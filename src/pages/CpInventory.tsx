import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { safeBatch } from '../lib/safeQuery'
import { safeLoad } from '../lib/safeLoad'
import { format } from 'date-fns'
import { useToast } from '../components/Toast'
import PageHeader from '../components/PageHeader'
import CPFilterBar from '../components/CPFilterBar'
import DataTable, { type Column } from '../components/DataTable'
import CPBadge from '../components/CPBadge'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import ConfirmDialog from '../components/ConfirmDialog'
import { PageSkeleton } from '../components/Skeleton'
import { fmt$, fmtNum } from '../lib/format'
import { useAuth } from '../contexts/AuthContext'
import { logActivity } from '../lib/activityLog'
import CostGuard from '../components/CostGuard'
import { ClipboardCheck, MapPin, Pencil, ClipboardList, Plus, Upload, Trash2 } from 'lucide-react'
import type {
  CoPacker,
  Ingredient,
  IngredientInventory,
  InventoryAdjustment,
  Recipe,
  RecipeIngredient,
  ShipmentToCopacker,
  PackagingMaterial,
  PackagingInventory,
  IngredientTag,
  IngredientTagLink,
} from '../types/database'
import { loadConversions, getConversionFactorWithDensity, type ConversionMap } from '../lib/conversions'
import { sanitize } from '../lib/sanitizePayload'
import { dbInsert, dbUpdate, dbDelete } from '../lib/dbWrite'

/* ── Row types ──────────────────────────────────────────────── */

interface IngRow extends Record<string, unknown> {
  id: string
  ingredient_id: string
  name: string
  unit: string
  quantity: number
  lot_number: string | null
  value: number
  enoughFor: number | null
  status: 'OK' | 'LOW' | 'CRITICAL'
}

interface PkgRow extends Record<string, unknown> {
  id: string
  name: string
  onHand: number
  status: 'OK' | 'LOW'
}

interface FullCountLine {
  inventoryId: string | null
  ingredientId: string
  ingredientName: string
  unit: string
  enteredUnit: string
  unitCost: number
  systemQty: number
  actualCount: string
  lotNumber: string
}

interface AdjRow extends Record<string, unknown> {
  id: string
  created_at: string
  co_packer_id: string | null
  ingredient_id: string | null
  previous_quantity: number | null
  new_quantity: number | null
  difference: number | null
  reason: string | null
  ingredientName: string
  unit: string
}

interface CsvRow {
  ingredientId: string
  name: string
  quantity: number
  lotNumber: string
  unit: string
  matched: boolean
}

const DEFAULT_RUN_SIZE = 5000

const REASONS = [
  'CP Physical Count',
  'Inventory Correction',
  'Spillage/Damage',
  'Found Extra Stock',
  'Other',
]

const ADD_REASONS = [
  'Already at CP — initial entry',
  'Received from supplier',
  'Transferred from another location',
  'Found during count',
  'Other',
]

function fmtQty(v: number, unit: string) {
  return `${fmtNum(Math.round(v))} ${unit}`
}

/* ================================================================ */

export default function CpInventory() {
  const { can, appUser } = useAuth()
  const [coPackers, setCoPackers] = useState<CoPacker[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [inventory, setInventory] = useState<IngredientInventory[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [recipeIngredients, setRecipeIngredients] = useState<RecipeIngredient[]>([])
  const [shipments, setShipments] = useState<ShipmentToCopacker[]>([])
  const [packagingMaterials, setPackagingMaterials] = useState<PackagingMaterial[]>([])
  const [packagingInventory, setPackagingInventory] = useState<PackagingInventory[]>([])
  const [adjustments, setAdjustments] = useState<InventoryAdjustment[]>([])
  const [tags, setTags] = useState<IngredientTag[]>([])
  const [tagLinks, setTagLinks] = useState<IngredientTagLink[]>([])
  const [cpFilter, setCpFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [conversions, setConversions] = useState<ConversionMap>(new Map())
  const toast = useToast()

  /* ── Inline edit state ──────────────────────────────────────── */
  const [editingCP, setEditingCP] = useState<string | null>(null)
  const [editCounts, setEditCounts] = useState<Record<string, string>>({})
  const [editUnits, setEditUnits] = useState<Record<string, string>>({})
  const [editReason, setEditReason] = useState('CP Physical Count')
  const [editNotes, setEditNotes] = useState('')
  const [editSaving, setEditSaving] = useState(false)

  /* ── Full count modal state ─────────────────────────────────── */
  const [fullCountCP, setFullCountCP] = useState<string | null>(null)
  const [fullCountLines, setFullCountLines] = useState<FullCountLine[]>([])
  const [fullCountZeroUnlisted, setFullCountZeroUnlisted] = useState(false)
  const [fullCountReason, setFullCountReason] = useState('CP Physical Count')
  const [fullCountNotes, setFullCountNotes] = useState('')
  const [fullCountSaving, setFullCountSaving] = useState(false)

  /* ── Expanded ingredient for history ────────────────────────── */
  const [expandedIngId, setExpandedIngId] = useState<string | null>(null)

  /* ── Add ingredient modal state ───────────────────────────── */
  const [addIngCP, setAddIngCP] = useState<string | null>(null)
  const [addIngForm, setAddIngForm] = useState({
    ingredientId: '', quantity: '', unit: '', lotNumber: '', expirationDate: '',
    reason: 'Already at CP — initial entry', notes: '',
  })
  const [addIngSaving, setAddIngSaving] = useState(false)
  const [addIngAdded, setAddIngAdded] = useState<{ name: string; qty: number; unit: string }[]>([])
  const [csvPreview, setCsvPreview] = useState<CsvRow[] | null>(null)
  const [csvImporting, setCsvImporting] = useState(false)
  const csvInputRef = useRef<HTMLInputElement>(null)

  /* ── Edit ingredient modal state ────────────────────────────── */
  const [editInvRow, setEditInvRow] = useState<IngRow | null>(null)
  const [editInvCPId, setEditInvCPId] = useState<string | null>(null)
  const [editInvForm, setEditInvForm] = useState({ quantity: '', unit: '', lot_number: '', expiration_date: '', notes: '' })
  const [editInvSaving, setEditInvSaving] = useState(false)

  /* ── Delete ingredient state ────────────────────────────────── */
  const [deleteInvRow, setDeleteInvRow] = useState<IngRow | null>(null)
  const [deleteInvCPId, setDeleteInvCPId] = useState<string | null>(null)
  const [deleteInvSaving, setDeleteInvSaving] = useState(false)

  /* ── Inline quantity edit state ─────────────────────────────── */
  const [inlineEditId, setInlineEditId] = useState<string | null>(null)
  const [inlineEditValue, setInlineEditValue] = useState('')
  const inlineEditRef = useRef<HTMLInputElement>(null)

  /* ── Data loading ───────────────────────────────────────────── */

  async function load() {
    const [cpRes, ingRes, invRes, recRes, riRes, shipRes, pmRes, piRes, adjRes, convMap, tagsRes, tagLinksRes] = await safeBatch(() => Promise.all([
      supabase.from('co_packers').select('*').order('name'),
      supabase.from('ingredients').select('*').order('name'),
      supabase.from('ingredient_inventory').select('*'),
      supabase.from('recipes').select('*'),
      supabase.from('recipe_ingredients').select('*'),
      supabase.from('shipments_to_copacker').select('*').order('ship_date', { ascending: false }),
      supabase.from('packaging_materials').select('*').order('name'),
      supabase.from('packaging_inventory').select('*'),
      supabase.from('inventory_adjustments').select('*').order('created_at', { ascending: false }).limit(200),
      loadConversions(),
      supabase.from('ingredient_tags').select('*').order('name'),
      supabase.from('ingredient_tag_links').select('*'),
    ]))
    setCoPackers(cpRes.data ?? [])
    setIngredients(ingRes.data ?? [])
    setInventory(invRes.data ?? [])
    setRecipes(recRes.data ?? [])
    setRecipeIngredients(riRes.data ?? [])
    setShipments(shipRes.data ?? [])
    setPackagingMaterials(pmRes.data ?? [])
    setPackagingInventory(piRes.data ?? [])
    setAdjustments(adjRes.data ?? [])
    setConversions(convMap)
    setTags(tagsRes.data ?? [])
    setTagLinks(tagLinksRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => safeLoad(load, setLoading), [])

  function ingTagLabel(ingredientId: string): string {
    const ingTags = tagLinks
      .filter((l) => l.ingredient_id === ingredientId)
      .map((l) => tags.find((t) => t.id === l.tag_id)?.name)
      .filter(Boolean)
    return ingTags.length > 0 ? ` [${ingTags.join(', ')}]` : ''
  }

  /* ── Visible co-packers ───────────────────────────────────── */

  const visibleCPs = useMemo(() => {
    if (cpFilter === 'all') return coPackers
    return coPackers.filter((cp) => cp.id === cpFilter)
  }, [coPackers, cpFilter])

  /* ── Last confirmed date per CP ───────────────────────────── */

  const lastConfirmedMap = useMemo(() => {
    const map: Record<string, string | null> = {}
    for (const cp of coPackers) {
      // Use last_count_date from inventory if available, otherwise fall back to shipment confirmation
      const cpInv = inventory.filter(
        (iv) => iv.location_type === 'copacker' && iv.co_packer_id === cp.id,
      )
      const lastCountDates = cpInv
        .map((iv) => iv.last_count_date)
        .filter(Boolean) as string[]
      if (lastCountDates.length > 0) {
        lastCountDates.sort()
        map[cp.id] = lastCountDates[lastCountDates.length - 1]
      } else {
        const confirmed = shipments.find(
          (s) => s.co_packer_id === cp.id && s.cp_confirmed,
        )
        map[cp.id] = confirmed?.cp_confirmed_date ?? null
      }
    }
    return map
  }, [coPackers, shipments, inventory])

  /* ── Build ingredient rows per CP ─────────────────────────── */

  function buildIngRows(cpId: string): IngRow[] {
    const cpInv = inventory.filter(
      (iv) => iv.location_type === 'copacker' && iv.co_packer_id === cpId,
    )
    const cpRecipes = recipes.filter((r) => r.co_packer_id === cpId)
    const cpRecipeIds = new Set(cpRecipes.map((r) => r.id))
    const cpRI = recipeIngredients.filter((ri) => cpRecipeIds.has(ri.recipe_id) && ri.provided_by !== 'copacker')

    return cpInv.map((iv) => {
      const ing = ingredients.find((i) => i.id === iv.ingredient_id)
      const qty = iv.quantity ?? 0
      const unitCost = ing?.unit_cost ?? 0
      const value = qty * unitCost

      const usages = cpRI.filter((ri) => ri.ingredient_id === iv.ingredient_id)
      let enoughFor: number | null = null
      if (usages.length > 0) {
        const runCounts = usages.map((ri) => {
          let factor = 1
          try { factor = getConversionFactorWithDensity(conversions, ri.unit, ing?.unit ?? 'lbs', ing?.density_g_per_ml) } catch { /* fallback */ }
          const perRun = ri.quantity_per_unit * factor * DEFAULT_RUN_SIZE
          return perRun > 0 ? qty / perRun : Infinity
        })
        enoughFor = Math.min(...runCounts)
      }

      let status: 'OK' | 'LOW' | 'CRITICAL'
      if (enoughFor !== null && enoughFor < 1) {
        status = 'CRITICAL'
      } else if (enoughFor !== null && enoughFor < 2) {
        status = 'LOW'
      } else {
        status = 'OK'
      }

      return {
        id: iv.id,
        ingredient_id: iv.ingredient_id,
        name: ing?.name ?? '?',
        unit: ing?.unit ?? 'lbs',
        quantity: qty,
        lot_number: iv.lot_number,
        value,
        enoughFor,
        status,
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
  }

  /* ── Build packaging rows per CP ──────────────────────────── */

  function buildPkgRows(cpId: string): PkgRow[] {
    const cpPkg = packagingInventory.filter((pi) => pi.co_packer_id === cpId)
    return cpPkg.map((pi) => {
      const mat = packagingMaterials.find((m) => m.id === pi.packaging_material_id)
      const qty = pi.quantity ?? 0
      return {
        id: pi.id,
        name: mat?.name ?? '?',
        onHand: qty,
        status: qty > 0 ? 'OK' as const : 'LOW' as const,
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
  }

  /* ── Inline edit helpers ────────────────────────────────────── */

  function startEdit(cpId: string) {
    const rows = buildIngRows(cpId)
    const counts: Record<string, string> = {}
    const units: Record<string, string> = {}
    for (const r of rows) {
      counts[r.id] = String(r.quantity)
      units[r.id] = r.unit
    }
    setEditCounts(counts)
    setEditUnits(units)
    setEditReason('CP Physical Count')
    setEditNotes('')
    setEditingCP(cpId)
  }

  function cancelEdit() {
    setEditingCP(null)
    setEditCounts({})
    setEditUnits({})
    setEditNotes('')
  }

  function getEditConverted(row: IngRow): number {
    const enteredQty = Number(editCounts[row.id] ?? row.quantity)
    const enteredUnit = editUnits[row.id] ?? row.unit
    if (enteredUnit === row.unit) return enteredQty
    try {
      const ing = ingredients.find((i) => i.id === row.ingredient_id)
      const factor = getConversionFactorWithDensity(conversions, enteredUnit, row.unit, ing?.density_g_per_ml)
      return enteredQty * factor
    } catch {
      return enteredQty
    }
  }

  function getEditDiff(row: IngRow): number {
    return getEditConverted(row) - row.quantity
  }

  function getEditChangedRows(ingRows: IngRow[]) {
    return ingRows.filter((r) => {
      const converted = getEditConverted(r)
      return Math.abs(converted - r.quantity) > 0.001
    })
  }

  async function saveEditCounts(cpId: string) {
    const ingRows = buildIngRows(cpId)
    const changed = getEditChangedRows(ingRows)
    if (changed.length === 0) return

    setEditSaving(true)
    try {
      const cp = coPackers.find((c) => c.id === cpId)
      const reasonText = editReason + (editNotes ? ` — ${editNotes}` : '')

      // Update each inventory row (store in base unit)
      for (const r of changed) {
        const convertedQty = getEditConverted(r)
        const { error } = await dbUpdate('ingredient_inventory', sanitize('ingredient_inventory', { quantity: convertedQty, last_count_date: new Date().toISOString() }), 'id', r.id)
        if (error) throw error
      }

      // Audit trail (non-blocking)
      try {
        const adjInserts = changed.map((r) => {
          const convertedQty = getEditConverted(r)
          return sanitize('inventory_adjustments', {
            ingredient_id: r.ingredient_id,
            co_packer_id: cpId,
            location_type: 'copacker',
            previous_quantity: r.quantity,
            new_quantity: convertedQty,
            difference: convertedQty - r.quantity,
            reason: reasonText,
            adjusted_by: 'User',
          })
        })
        await dbInsert('inventory_adjustments', adjInserts)
      } catch (auditErr) {
        console.warn('Audit log failed:', auditErr)
      }

      toast.success(`Updated ${changed.length} ingredient count${changed.length > 1 ? 's' : ''} for ${cp?.name ?? 'co-packer'}`)
      for (const r of changed) {
        logActivity(appUser?.id, 'adjust_inventory', 'ingredient_inventory', r.id)
      }
      cancelEdit()
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save counts')
    } finally {
      setEditSaving(false)
    }
  }

  /* ── Full count modal helpers ───────────────────────────────── */

  function openFullCount(cpId: string) {
    const cpInv = inventory.filter(
      (iv) => iv.location_type === 'copacker' && iv.co_packer_id === cpId,
    )
    const lines: FullCountLine[] = cpInv
      .map((iv) => {
        const ing = ingredients.find((i) => i.id === iv.ingredient_id)
        const u = ing?.unit ?? 'lbs'
        return {
          inventoryId: iv.id,
          ingredientId: iv.ingredient_id,
          ingredientName: ing?.name ?? '?',
          unit: u,
          enteredUnit: u,
          unitCost: ing?.unit_cost ?? 0,
          systemQty: iv.quantity ?? 0,
          actualCount: '',
          lotNumber: iv.lot_number ?? '',
        }
      })
      .sort((a, b) => a.ingredientName.localeCompare(b.ingredientName))

    setFullCountLines(lines)
    setFullCountZeroUnlisted(false)
    setFullCountReason('CP Physical Count')
    setFullCountNotes('')
    setFullCountCP(cpId)
  }

  function addFullCountIngredient(ingredientId: string) {
    const ing = ingredients.find((i) => i.id === ingredientId)
    if (!ing) return
    setFullCountLines((prev) => [
      ...prev,
      {
        inventoryId: null,
        ingredientId: ing.id,
        ingredientName: ing.name,
        unit: ing.unit,
        enteredUnit: ing.unit,
        unitCost: ing.unit_cost,
        systemQty: 0,
        actualCount: '',
        lotNumber: '',
      },
    ])
  }

  function updateFullCountLine(idx: number, field: 'actualCount' | 'lotNumber' | 'enteredUnit', value: string) {
    setFullCountLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)))
  }

  async function applyFullCount() {
    if (!fullCountCP) return
    setFullCountSaving(true)
    try {
      const cp = coPackers.find((c) => c.id === fullCountCP)
      const reasonText = fullCountReason + (fullCountNotes ? ` — ${fullCountNotes}` : '')
      const adjInserts: Array<{
        ingredient_id: string; co_packer_id: string; location_type: string;
        previous_quantity: number; new_quantity: number; difference: number;
        reason: string; adjusted_by: string
      }> = []

      let updatedCount = 0

      for (const line of fullCountLines) {
        const hasCount = line.actualCount !== ''
        const rawQty = hasCount ? Number(line.actualCount) : null
        const newQty = rawQty !== null
          ? convertFullCountQty(line, rawQty)
          : (fullCountZeroUnlisted && line.systemQty > 0 ? 0 : null)

        if (newQty === null) continue // untouched and not zeroed
        if (Math.abs(newQty - line.systemQty) < 0.001 && hasCount) {
          // Same value entered — still update last_count_date but no adjustment
          if (line.inventoryId) {
            await dbUpdate('ingredient_inventory', sanitize('ingredient_inventory', { last_count_date: new Date().toISOString(), lot_number: line.lotNumber || null }), 'id', line.inventoryId)
          }
          updatedCount++
          continue
        }

        if (line.inventoryId) {
          // Update existing
          const { error } = await dbUpdate('ingredient_inventory', sanitize('ingredient_inventory', {
              quantity: newQty,
              last_count_date: new Date().toISOString(),
              lot_number: line.lotNumber || null,
            }), 'id', line.inventoryId)
          if (error) throw error
        } else {
          // Insert new inventory row
          const { error } = await dbInsert('ingredient_inventory',
            sanitize('ingredient_inventory', {
              ingredient_id: line.ingredientId,
              co_packer_id: fullCountCP,
              location_type: 'copacker',
              quantity: newQty,
              last_count_date: new Date().toISOString(),
              lot_number: line.lotNumber || null,
            }),
          )
          if (error) throw error
        }

        adjInserts.push(sanitize('inventory_adjustments', {
          ingredient_id: line.ingredientId,
          co_packer_id: fullCountCP,
          location_type: 'copacker',
          previous_quantity: line.systemQty,
          new_quantity: newQty,
          difference: newQty - line.systemQty,
          reason: !hasCount && fullCountZeroUnlisted ? `Zeroed — not in CP count` : reasonText,
          adjusted_by: 'User',
        }))
        updatedCount++
      }

      // Audit trail (non-blocking)
      if (adjInserts.length > 0) {
        try {
          await dbInsert('inventory_adjustments', adjInserts)
        } catch (auditErr) {
          console.warn('Audit log failed:', auditErr)
        }
      }

      toast.success(`Applied full count: ${updatedCount} item${updatedCount !== 1 ? 's' : ''} at ${cp?.name ?? 'co-packer'}`)
      logActivity(appUser?.id, 'full_count', 'ingredient_inventory', undefined, { co_packer_id: fullCountCP })
      setFullCountCP(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply count')
    } finally {
      setFullCountSaving(false)
    }
  }

  /** Convert a full-count line's actualCount from enteredUnit → base unit */
  function convertFullCountQty(line: FullCountLine, qty: number): number {
    if (line.enteredUnit === line.unit) return qty
    try {
      const ing = ingredients.find((i) => i.id === line.ingredientId)
      const factor = getConversionFactorWithDensity(conversions, line.enteredUnit, line.unit, ing?.density_g_per_ml)
      return qty * factor
    } catch {
      return qty
    }
  }

  /* ── Full count summary stats ───────────────────────────────── */

  const fullCountStats = useMemo(() => {
    let counted = 0
    let discrepancies = 0
    let valueDiff = 0
    for (const line of fullCountLines) {
      if (line.actualCount === '') continue
      counted++
      const convertedQty = convertFullCountQty(line, Number(line.actualCount))
      const diff = convertedQty - line.systemQty
      if (Math.abs(diff) > 0.01) {
        discrepancies++
        valueDiff += diff * line.unitCost
      }
    }
    if (fullCountZeroUnlisted) {
      for (const line of fullCountLines) {
        if (line.actualCount === '' && line.systemQty > 0) {
          discrepancies++
          valueDiff -= line.systemQty * line.unitCost
        }
      }
    }
    return { counted, discrepancies, valueDiff }
  }, [fullCountLines, fullCountZeroUnlisted, conversions, ingredients])

  /* ── Available ingredients for "add" in full count ──────────── */

  const fullCountAvailableIngs = useMemo(() => {
    const usedIds = new Set(fullCountLines.map((l) => l.ingredientId))
    return ingredients.filter((i) => !usedIds.has(i.id))
  }, [fullCountLines, ingredients])

  /* ── Add ingredient modal helpers ───────────────────────────── */

  const addIngAvailable = useMemo(() => {
    if (!addIngCP) return []
    const existingIds = new Set(
      inventory
        .filter((iv) => iv.location_type === 'copacker' && iv.co_packer_id === addIngCP)
        .map((iv) => iv.ingredient_id),
    )
    return ingredients.filter((i) => !existingIds.has(i.id))
  }, [addIngCP, inventory, ingredients])

  const UNIT_OPTIONS = ['lbs', 'oz', 'g', 'kg', 'fl_oz', 'ml', 'l', 'gal', 'pcs']

  function openAddIngredient(cpId: string) {
    setAddIngCP(cpId)
    setAddIngForm({ ingredientId: '', quantity: '', unit: '', lotNumber: '', expirationDate: '', reason: 'Already at CP — initial entry', notes: '' })
    setAddIngAdded([])
    setCsvPreview(null)
  }

  function selectAddIngredient(ingredientId: string) {
    const ing = ingredients.find((i) => i.id === ingredientId)
    setAddIngForm((f) => ({ ...f, ingredientId, unit: ing?.unit ?? 'lbs' }))
  }

  async function submitAddIngredient() {
    if (!addIngCP || !addIngForm.ingredientId || !addIngForm.quantity) return
    setAddIngSaving(true)
    try {
      const cp = coPackers.find((c) => c.id === addIngCP)
      const ing = ingredients.find((i) => i.id === addIngForm.ingredientId)
      const enteredQty = Number(addIngForm.quantity)
      const enteredUnit = addIngForm.unit || ing?.unit || 'lbs'
      const baseUnit = ing?.unit ?? 'lbs'

      // Convert to ingredient's base unit if different
      let storedQty = enteredQty
      if (enteredUnit !== baseUnit) {
        try {
          const factor = getConversionFactorWithDensity(conversions, enteredUnit, baseUnit, ing?.density_g_per_ml)
          storedQty = enteredQty * factor
        } catch {
          toast.error(`Cannot convert ${enteredUnit} → ${baseUnit}`)
          setAddIngSaving(false)
          return
        }
      }

      const reasonText = addIngForm.reason + (addIngForm.notes ? ` — ${addIngForm.notes}` : '')
      const displayQty = enteredUnit !== baseUnit
        ? `${fmtNum(Math.round(enteredQty))} ${enteredUnit} → ${fmtNum(Math.round(storedQty))} ${baseUnit}`
        : `${fmtNum(Math.round(storedQty))} ${baseUnit}`

      const { error: invErr } = await dbInsert('ingredient_inventory',
        sanitize('ingredient_inventory', {
          ingredient_id: addIngForm.ingredientId,
          location_type: 'copacker',
          co_packer_id: addIngCP,
          quantity: storedQty,
          lot_number: addIngForm.lotNumber || null,
          expiration_date: addIngForm.expirationDate || null,
          last_count_date: new Date().toISOString(),
        }),
      )
      if (invErr) throw invErr

      // Audit trail (non-blocking)
      try {
        await dbInsert('inventory_adjustments',
          sanitize('inventory_adjustments', {
            ingredient_id: addIngForm.ingredientId,
            co_packer_id: addIngCP,
            location_type: 'copacker',
            previous_quantity: 0,
            new_quantity: storedQty,
            difference: storedQty,
            reason: reasonText,
            adjusted_by: 'User',
          }),
        )
      } catch (auditErr) {
        console.warn('Audit log failed:', auditErr)
      }

      setAddIngAdded((prev) => [...prev, { name: ing?.name ?? '?', qty: storedQty, unit: baseUnit }])
      toast.success(`Added ${ing?.name ?? 'ingredient'} to ${cp?.name ?? 'co-packer'} (${displayQty})`)
      setAddIngForm((f) => ({ ingredientId: '', quantity: '', unit: '', lotNumber: '', expirationDate: '', reason: f.reason, notes: '' }))
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add ingredient')
    } finally {
      setAddIngSaving(false)
    }
  }

  function handleCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const lines = text.split(/\r?\n/).filter((l) => l.trim())
      if (lines.length < 2) { toast.error('CSV must have a header row and at least one data row'); return }

      // Parse header
      const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/['"]/g, ''))
      const nameIdx = header.findIndex((h) => h.includes('ingredient') || h === 'name')
      const qtyIdx = header.findIndex((h) => h.includes('quantity') || h === 'qty' || h === 'amount')
      const lotIdx = header.findIndex((h) => h.includes('lot'))

      if (nameIdx === -1 || qtyIdx === -1) {
        toast.error('CSV must have ingredient_name and quantity columns')
        return
      }

      const existingIds = new Set(
        inventory
          .filter((iv) => iv.location_type === 'copacker' && iv.co_packer_id === addIngCP)
          .map((iv) => iv.ingredient_id),
      )

      const rows: CsvRow[] = []
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map((c) => c.trim().replace(/^['"]|['"]$/g, ''))
        const rawName = cols[nameIdx] ?? ''
        const rawQty = Number(cols[qtyIdx] ?? 0)
        const rawLot = lotIdx >= 0 ? (cols[lotIdx] ?? '') : ''
        if (!rawName) continue

        const matched = ingredients.find(
          (ing) => ing.name.toLowerCase() === rawName.toLowerCase(),
        )

        rows.push({
          ingredientId: matched?.id ?? '',
          name: rawName,
          quantity: rawQty,
          lotNumber: rawLot,
          unit: matched?.unit ?? '?',
          matched: !!matched && !existingIds.has(matched.id),
        })
      }
      setCsvPreview(rows)
    }
    reader.readAsText(file)
    // Reset input so same file can be re-selected
    e.target.value = ''
  }

  async function importCsv() {
    if (!csvPreview || !addIngCP) return
    const matchedRows = csvPreview.filter((r) => r.matched && r.quantity > 0)
    if (matchedRows.length === 0) return
    setCsvImporting(true)
    try {
      const cp = coPackers.find((c) => c.id === addIngCP)

      const invInserts = matchedRows.map((r) => sanitize('ingredient_inventory', {
        ingredient_id: r.ingredientId,
        location_type: 'copacker',
        co_packer_id: addIngCP,
        quantity: r.quantity,
        lot_number: r.lotNumber || null,
        last_count_date: new Date().toISOString(),
      }))
      const { error: invErr } = await dbInsert('ingredient_inventory', invInserts)
      if (invErr) throw invErr

      // Audit trail (non-blocking)
      try {
        const adjInserts = matchedRows.map((r) => sanitize('inventory_adjustments', {
          ingredient_id: r.ingredientId,
          co_packer_id: addIngCP,
          location_type: 'copacker',
          previous_quantity: 0,
          new_quantity: r.quantity,
          difference: r.quantity,
          reason: 'CSV Import',
          adjusted_by: 'User',
        }))
        await dbInsert('inventory_adjustments', adjInserts)
      } catch (auditErr) {
        console.warn('Audit log failed:', auditErr)
      }

      setAddIngAdded((prev) => [
        ...prev,
        ...matchedRows.map((r) => ({ name: r.name, qty: r.quantity, unit: r.unit })),
      ])
      toast.success(`Imported ${matchedRows.length} ingredient${matchedRows.length !== 1 ? 's' : ''} to ${cp?.name ?? 'co-packer'}`)
      setCsvPreview(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to import CSV')
    } finally {
      setCsvImporting(false)
    }
  }

  /* ── Edit ingredient modal functions ─────────────────────── */

  function openEditInv(row: IngRow, cpId: string) {
    const iv = inventory.find((i) => i.id === row.id)
    setEditInvRow(row)
    setEditInvCPId(cpId)
    setEditInvForm({
      quantity: String(row.quantity),
      unit: row.unit,
      lot_number: iv?.lot_number ?? '',
      expiration_date: iv?.expiration_date ?? '',
      notes: '',
    })
  }

  function closeEditInv() {
    setEditInvRow(null)
    setEditInvCPId(null)
  }

  async function saveEditInv() {
    if (!editInvRow || !editInvCPId) return
    setEditInvSaving(true)
    try {
      const ing = ingredients.find((i) => i.id === editInvRow.ingredient_id)
      let finalQty = Number(editInvForm.quantity)
      if (editInvForm.unit !== editInvRow.unit) {
        try {
          const factor = getConversionFactorWithDensity(conversions, editInvForm.unit, editInvRow.unit, ing?.density_g_per_ml)
          finalQty = finalQty * factor
        } catch { /* keep as entered */ }
      }

      const { error } = await dbUpdate('ingredient_inventory', sanitize('ingredient_inventory', {
          quantity: finalQty,
          lot_number: editInvForm.lot_number || null,
          expiration_date: editInvForm.expiration_date || null,
          last_count_date: new Date().toISOString(),
        }), 'id', editInvRow.id)
      if (error) throw error

      // Audit trail (non-blocking)
      if (Math.abs(finalQty - editInvRow.quantity) > 0.001) {
        try {
          await dbInsert('inventory_adjustments',
            sanitize('inventory_adjustments', {
              ingredient_id: editInvRow.ingredient_id,
              co_packer_id: editInvCPId,
              location_type: 'copacker',
              previous_quantity: editInvRow.quantity,
              new_quantity: finalQty,
              difference: finalQty - editInvRow.quantity,
              reason: editInvForm.notes || 'Manual edit',
              adjusted_by: 'User',
            }),
          )
        } catch (auditErr) {
          console.warn('Audit log failed:', auditErr)
        }
      }

      toast.success(`Updated ${editInvRow.name}`)
      closeEditInv()
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setEditInvSaving(false)
    }
  }

  /* ── Delete ingredient functions ───────────────────────────── */

  function confirmDeleteInv(row: IngRow, cpId: string) {
    setDeleteInvRow(row)
    setDeleteInvCPId(cpId)
  }

  async function executeDeleteInv() {
    if (!deleteInvRow || !deleteInvCPId) return
    setDeleteInvSaving(true)
    try {
      // Audit trail (non-blocking)
      try {
        await dbInsert('inventory_adjustments',
          sanitize('inventory_adjustments', {
            ingredient_id: deleteInvRow.ingredient_id,
            co_packer_id: deleteInvCPId,
            location_type: 'copacker',
            previous_quantity: deleteInvRow.quantity,
            new_quantity: 0,
            difference: -deleteInvRow.quantity,
            reason: 'Deleted',
            adjusted_by: 'User',
          }),
        )
      } catch (auditErr) {
        console.warn('Audit log failed:', auditErr)
      }

      const { error } = await dbDelete('ingredient_inventory', 'id', deleteInvRow.id)
      if (error) throw error

      const cp = coPackers.find((c) => c.id === deleteInvCPId)
      toast.success(`Removed ${deleteInvRow.name} from ${cp?.name ?? 'co-packer'}`)
      setDeleteInvRow(null)
      setDeleteInvCPId(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setDeleteInvSaving(false)
    }
  }

  /* ── Inline quantity edit functions ─────────────────────────── */

  function startInlineEdit(row: IngRow) {
    setInlineEditId(row.id)
    setInlineEditValue(String(row.quantity))
  }

  function cancelInlineEdit() {
    setInlineEditId(null)
  }

  async function saveInlineEdit(row: IngRow, cpId: string) {
    const newQty = Number(inlineEditValue)
    if (isNaN(newQty) || newQty < 0) { cancelInlineEdit(); return }
    if (Math.abs(newQty - row.quantity) < 0.001) { cancelInlineEdit(); return }

    try {
      const { error } = await dbUpdate('ingredient_inventory', sanitize('ingredient_inventory', {
          quantity: newQty,
          last_count_date: new Date().toISOString(),
        }), 'id', row.id)
      if (error) throw error

      // Audit trail (non-blocking)
      try {
        await dbInsert('inventory_adjustments',
          sanitize('inventory_adjustments', {
            ingredient_id: row.ingredient_id,
            co_packer_id: cpId,
            location_type: 'copacker',
            previous_quantity: row.quantity,
            new_quantity: newQty,
            difference: newQty - row.quantity,
            reason: 'Quick edit',
            adjusted_by: 'User',
          }),
        )
      } catch (auditErr) {
        console.warn('Audit log failed:', auditErr)
      }

      toast.success(`Updated ${row.name} to ${fmtQty(newQty, row.unit)}`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update')
    } finally {
      cancelInlineEdit()
    }
  }

  /* ── Ingredient table columns ─────────────────────────────── */

  function getIngColumns(cpId: string): Column<IngRow>[] {
    const isEditing = editingCP === cpId

    const cols: Column<IngRow>[] = [
      {
        label: 'Ingredient',
        key: 'name',
        width: '200px',
        render: (row) => (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpandedIngId(expandedIngId === row.id ? null : row.id) }}
            className="text-left font-medium text-text hover:text-accent transition-colors"
          >
            {row.name}
          </button>
        ),
      },
    ]

    if (isEditing) {
      cols.push({
        label: 'Actual Qty',
        key: 'quantity',
        align: 'right',
        width: '220px',
        render: (row) => {
          const selUnit = editUnits[row.id] ?? row.unit
          const isConverted = selUnit !== row.unit
          let convPreview = ''
          if (isConverted && editCounts[row.id]) {
            try {
              const ing = ingredients.find((i) => i.id === row.ingredient_id)
              const factor = getConversionFactorWithDensity(conversions, selUnit, row.unit, ing?.density_g_per_ml)
              convPreview = `= ${fmtNum(Math.round(Number(editCounts[row.id]) * factor * 100) / 100)} ${row.unit}`
            } catch {
              convPreview = `Cannot convert`
            }
          }
          return (
            <div className="text-right">
              <div className="flex items-center justify-end gap-1">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={editCounts[row.id] ?? ''}
                  onChange={(e) => setEditCounts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                  className="w-20 rounded border border-border bg-surface px-2 py-1 text-right text-xs font-mono text-text outline-none focus:border-accent"
                />
                <select
                  value={selUnit}
                  onChange={(e) => setEditUnits((prev) => ({ ...prev, [row.id]: e.target.value }))}
                  className="w-16 rounded border border-border bg-surface px-1 py-1 text-xs text-text outline-none focus:border-accent"
                >
                  {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <p className="mt-0.5 text-[10px] text-muted">
                System: {fmtQty(row.quantity, row.unit)}
                {isConverted && convPreview && <span className="ml-1 text-accent">{convPreview}</span>}
              </p>
            </div>
          )
        },
      })
      cols.push({
        label: 'Difference',
        key: 'lot_number',
        align: 'right',
        width: '120px',
        render: (row) => {
          const diff = getEditDiff(row)
          if (Math.abs(diff) < 0.01) return <span className="text-muted">—</span>
          const color = diff > 0 ? 'text-green-400' : 'text-red-400'
          return <span className={`font-mono text-xs font-medium ${color}`}>{diff > 0 ? '+' : ''}{fmtNum(Math.round(diff))} {row.unit}</span>
        },
      })
    } else {
      cols.push({
        label: 'Qty on Hand',
        key: 'quantity',
        align: 'right',
        width: '130px',
        render: (row) => {
          if (inlineEditId === row.id) {
            return (
              <form onSubmit={(e) => { e.preventDefault(); saveInlineEdit(row, cpId) }} className="text-right">
                <input
                  ref={inlineEditRef}
                  type="number"
                  min="0"
                  step="any"
                  value={inlineEditValue}
                  onChange={(e) => setInlineEditValue(e.target.value)}
                  onBlur={() => saveInlineEdit(row, cpId)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancelInlineEdit() } }}
                  className="w-24 rounded border border-accent bg-surface px-2 py-0.5 text-right text-xs font-mono text-text outline-none"
                  autoFocus
                />
              </form>
            )
          }
          return (
            <span
              className="font-mono text-text cursor-text"
              onDoubleClick={(e) => { e.stopPropagation(); if (!editingCP) startInlineEdit(row) }}
              title="Double-click to quick edit"
            >
              {fmtQty(row.quantity, row.unit)}
            </span>
          )
        },
      })
      cols.push({
        label: 'Lot #',
        key: 'lot_number',
        width: '110px',
        render: (row) => (
          <span className="font-mono text-xs text-muted">{row.lot_number || '—'}</span>
        ),
      })
    }

    cols.push(
      {
        label: 'Value',
        key: 'value',
        align: 'right',
        width: '110px',
        render: (row) => {
          const qty = isEditing ? getEditConverted(row) : row.quantity
          const ing = ingredients.find((i) => i.id === row.ingredient_id)
          const val = qty * (ing?.unit_cost ?? 0)
          return <CostGuard><span className="font-mono font-medium text-text">{fmt$(val)}</span></CostGuard>
        },
      },
      {
        label: 'Enough For',
        key: 'enoughFor',
        align: 'right',
        width: '110px',
        render: (row) => {
          if (row.enoughFor === null) return <span className="text-muted">—</span>
          const text =
            row.enoughFor < 1
              ? '< 1 run'
              : `~${Math.floor(row.enoughFor)} run${Math.floor(row.enoughFor) !== 1 ? 's' : ''}`
          return <span className="font-mono text-xs text-text">{text}</span>
        },
      },
      {
        label: 'Status',
        key: 'status',
        align: 'center',
        width: '90px',
        render: (row) => (
          <Badge
            color={
              row.status === 'OK' ? 'green' : row.status === 'LOW' ? 'amber' : 'red'
            }
          >
            {row.status}
          </Badge>
        ),
      },
    )

    if (!isEditing) {
      cols.push({
        label: '',
        key: '_actions',
        width: '70px',
        align: 'right' as const,
        render: (row: IngRow) => (
          <div className="flex items-center justify-end gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); openEditInv(row, cpId) }}
              className="rounded p-1 text-muted/50 hover:text-accent hover:bg-accent/10 transition-colors"
              title="Edit"
            >
              <Pencil size={13} />
            </button>
            {can('delete_any') && (
            <button
              onClick={(e) => { e.stopPropagation(); confirmDeleteInv(row, cpId) }}
              className="rounded p-1 text-muted/50 hover:text-red-400 hover:bg-red-400/10 transition-colors"
              title="Delete"
            >
              <Trash2 size={13} />
            </button>
            )}
          </div>
        ),
      })
    }

    return cols
  }

  /* ── Packaging table columns ──────────────────────────────── */

  const pkgColumns: Column<PkgRow>[] = useMemo(
    () => [
      {
        label: 'Material',
        key: 'name',
        render: (row) => <span className="font-medium text-text">{row.name}</span>,
      },
      {
        label: 'On Hand',
        key: 'onHand',
        align: 'right',
        width: '120px',
        render: (row) => (
          <span className="font-mono text-text">{row.onHand.toLocaleString()}</span>
        ),
      },
      {
        label: 'Status',
        key: 'status',
        align: 'center',
        width: '90px',
        render: (row) => (
          <Badge color={row.status === 'OK' ? 'green' : 'amber'}>{row.status}</Badge>
        ),
      },
    ],
    [],
  )

  /* ── History table columns ──────────────────────────────────── */

  const historyRows: AdjRow[] = useMemo(() => {
    const filtered = cpFilter === 'all'
      ? adjustments
      : adjustments.filter((a) => a.co_packer_id === cpFilter)

    return filtered.map((a) => {
      const ing = ingredients.find((i) => i.id === a.ingredient_id)
      return {
        id: a.id,
        created_at: a.created_at ?? '',
        co_packer_id: a.co_packer_id,
        ingredient_id: a.ingredient_id,
        previous_quantity: a.previous_quantity,
        new_quantity: a.new_quantity,
        difference: a.difference,
        reason: a.reason,
        ingredientName: ing?.name ?? '?',
        unit: ing?.unit ?? 'lbs',
      }
    })
  }, [adjustments, cpFilter, ingredients])

  const historyColumns: Column<AdjRow>[] = useMemo(
    () => [
      {
        label: 'Date',
        key: 'created_at',
        width: '160px',
        render: (row) => (
          <span className="text-xs text-muted">
            {row.created_at ? format(new Date(row.created_at), 'MMM d, yyyy h:mm a') : '—'}
          </span>
        ),
      },
      {
        label: 'CP',
        key: 'co_packer_id',
        width: '90px',
        render: (row) =>
          row.co_packer_id ? <CPBadge coPackerId={row.co_packer_id as string} /> : <span className="text-muted">—</span>,
      },
      {
        label: 'Ingredient',
        key: 'ingredientName',
        width: '180px',
        render: (row) => <span className="font-medium text-text">{row.ingredientName}</span>,
      },
      {
        label: 'System Qty',
        key: 'previous_quantity',
        align: 'right',
        width: '110px',
        render: (row) => (
          <span className="font-mono text-xs text-muted">
            {row.previous_quantity != null ? fmtQty(row.previous_quantity, row.unit) : '—'}
          </span>
        ),
      },
      {
        label: 'Actual Qty',
        key: 'new_quantity',
        align: 'right',
        width: '110px',
        render: (row) => (
          <span className="font-mono text-xs text-text">
            {row.new_quantity != null ? fmtQty(row.new_quantity, row.unit) : '—'}
          </span>
        ),
      },
      {
        label: 'Difference',
        key: 'difference',
        align: 'right',
        width: '100px',
        render: (row) => {
          if (row.difference == null || row.difference === 0) return <span className="text-muted">—</span>
          const color = row.difference > 0 ? 'text-green-400' : 'text-red-400'
          return (
            <span className={`font-mono text-xs font-medium ${color}`}>
              {row.difference > 0 ? '+' : ''}{fmtNum(Math.round(row.difference))}
            </span>
          )
        },
      },
      {
        label: 'Reason',
        key: 'reason',
        width: '200px',
        render: (row) => (
          <span className="text-xs text-muted truncate" title={row.reason ?? ''}>
            {row.reason ?? '—'}
          </span>
        ),
      },
    ],
    [],
  )

  /* ── Render ───────────────────────────────────────────────── */

  if (loading) return <PageSkeleton />

  return (
    <div>
      <PageHeader
        title="Co-Packer Inventory"
        subtitle="Your materials in co-packer custody"
      >
        <button
          onClick={() => { toast.success('Count request sent to all co-packers') }}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
        >
          <ClipboardCheck size={16} />
          Request All CP Counts
        </button>
      </PageHeader>

      <CPFilterBar selected={cpFilter} onSelect={setCpFilter} />

      {/* Co-packer sections */}
      <div className="space-y-8">
        {visibleCPs.map((cp) => {
          const hex = cp.color ?? '#3B82F6'
          const ingRows = buildIngRows(cp.id)
          const pkgRows = buildPkgRows(cp.id)
          const lastConfirmed = lastConfirmedMap[cp.id]
          const isEditing = editingCP === cp.id
          const changedRows = isEditing ? getEditChangedRows(ingRows) : []
          const netDiff = changedRows.reduce((s, r) => s + getEditDiff(r), 0)

          return (
            <div
              key={cp.id}
              className="overflow-hidden rounded-xl border border-border bg-card"
            >
              {/* Colored top border */}
              <div className="h-[3px]" style={{ backgroundColor: hex }} />

              {/* Card header */}
              <div className="flex items-center justify-between px-5 pt-4 pb-3">
                <div>
                  <div className="flex items-center gap-3">
                    <CPBadge coPacker={cp} />
                    <h3 className="text-base font-semibold text-text">{cp.name}</h3>
                  </div>
                  <div className="mt-1.5 flex items-center gap-4 text-xs text-muted">
                    {cp.location && (
                      <span className="flex items-center gap-1">
                        <MapPin size={12} />
                        {cp.location}
                      </span>
                    )}
                    <span>
                      Last count confirmed:{' '}
                      <span className="font-medium text-text">
                        {lastConfirmed
                          ? format(new Date(lastConfirmed), 'MMM d, yyyy')
                          : 'Never'}
                      </span>
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!isEditing && (
                    <>
                      <button
                        onClick={() => openAddIngredient(cp.id)}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-text hover:bg-hover"
                      >
                        <Plus size={13} />
                        Add Ingredient
                      </button>
                      <button
                        onClick={() => openFullCount(cp.id)}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-text hover:bg-hover"
                      >
                        <ClipboardList size={13} />
                        Enter Full Count
                      </button>
                      <button
                        onClick={() => startEdit(cp.id)}
                        className="flex items-center gap-1.5 rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20"
                      >
                        <Pencil size={13} />
                        Update Counts
                      </button>
                      <button
                        onClick={() => toast.success(`Count request sent to ${cp.short_code}`)}
                        className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-text hover:bg-hover"
                      >
                        Request Count
                      </button>
                    </>
                  )}
                  {isEditing && (
                    <span className="rounded-lg bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent">
                      Editing Counts…
                    </span>
                  )}
                </div>
              </div>

              {/* Raw materials table */}
              <div className="px-5 pb-2">
                <DataTable
                  columns={getIngColumns(cp.id)}
                  data={ingRows}
                  highlightRow={(row) =>
                    isEditing
                      ? getEditDiff(row) !== 0
                      : row.status === 'CRITICAL'
                  }
                  highlightColor={isEditing ? (ingRows.some((r) => getEditDiff(r) < 0) ? '#EF4444' : '#22C55E') : '#EF4444'}
                  emptyMessage="No ingredients at this co-packer"
                  emptyHint="Ship ingredients to start tracking"
                />

                {/* Expanded ingredient adjustment history */}
                {ingRows.some((r) => expandedIngId === r.id) && (() => {
                  const row = ingRows.find((r) => expandedIngId === r.id)!
                  const rowAdj = adjustments.filter((a) => a.ingredient_id === row.ingredient_id && a.co_packer_id === cp.id)
                  if (rowAdj.length === 0) return (
                    <div className="mb-2 rounded-lg border border-border bg-surface/30 px-4 py-3 text-xs text-muted">
                      No adjustment history for {row.name}
                    </div>
                  )
                  return (
                    <div className="mb-2 rounded-lg border border-border bg-surface/30 overflow-hidden">
                      <p className="px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-muted border-b border-border">
                        Adjustment History — {row.name}
                      </p>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border text-muted">
                            <th className="px-3 py-1.5 text-left font-medium">Date</th>
                            <th className="px-3 py-1.5 text-right font-medium">Previous</th>
                            <th className="px-3 py-1.5 text-right font-medium">Actual</th>
                            <th className="px-3 py-1.5 text-right font-medium">Diff</th>
                            <th className="px-3 py-1.5 text-left font-medium">Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rowAdj.slice(0, 10).map((a) => {
                            const diffColor = (a.difference ?? 0) > 0 ? 'text-green-400' : (a.difference ?? 0) < 0 ? 'text-red-400' : 'text-muted'
                            return (
                              <tr key={a.id} className="border-b border-border last:border-0">
                                <td className="px-3 py-1.5 text-muted">{a.created_at ? format(new Date(a.created_at), 'MMM d, yyyy') : '—'}</td>
                                <td className="px-3 py-1.5 text-right font-mono text-muted">{a.previous_quantity != null ? fmtNum(Math.round(a.previous_quantity)) : '—'}</td>
                                <td className="px-3 py-1.5 text-right font-mono text-text">{a.new_quantity != null ? fmtNum(Math.round(a.new_quantity)) : '—'}</td>
                                <td className={`px-3 py-1.5 text-right font-mono font-medium ${diffColor}`}>
                                  {a.difference != null && a.difference !== 0 ? `${a.difference > 0 ? '+' : ''}${fmtNum(Math.round(a.difference))}` : '—'}
                                </td>
                                <td className="px-3 py-1.5 text-muted truncate max-w-[200px]" title={a.reason ?? ''}>{a.reason ?? '—'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )
                })()}
              </div>

              {/* Edit mode footer */}
              {isEditing && (
                <div className="border-t border-border px-5 py-4 space-y-3">
                  <p className="text-xs text-muted">
                    {changedRows.length} item{changedRows.length !== 1 ? 's' : ''} changed
                    {changedRows.length > 0 && (
                      <>, net difference: <span className={`font-mono font-medium ${netDiff > 0 ? 'text-green-400' : netDiff < 0 ? 'text-red-400' : 'text-muted'}`}>
                        {netDiff > 0 ? '+' : ''}{fmtNum(Math.round(netDiff))} units
                      </span></>
                    )}
                  </p>
                  <div className="flex items-center gap-3">
                    <select
                      value={editReason}
                      onChange={(e) => setEditReason(e.target.value)}
                      className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                    >
                      {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <input
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      placeholder="Additional notes…"
                      className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent"
                    />
                  </div>
                  <div className="flex justify-end gap-3">
                    <button
                      onClick={cancelEdit}
                      className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => saveEditCounts(cp.id)}
                      disabled={changedRows.length === 0 || editSaving}
                      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                    >
                      {editSaving ? 'Saving…' : `Save Counts (${changedRows.length})`}
                    </button>
                  </div>
                </div>
              )}

              {/* Packaging section */}
              <div className="px-5 pb-5 pt-3">
                <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted">
                  Packaging Materials
                </p>
                {pkgRows.length > 0 ? (
                  <DataTable columns={pkgColumns} data={pkgRows} />
                ) : (
                  <p className="rounded-lg border border-border bg-surface/30 px-4 py-3 text-xs text-muted">
                    No packaging materials tracked
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Count History ──────────────────────────────────────── */}
      {historyRows.length > 0 && (
        <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold text-text">Count History</h3>
          </div>
          <div className="px-5 pb-5 pt-2">
            <DataTable
              columns={historyColumns}
              data={historyRows}
              highlightRow={(row) => {
                if (row.difference == null || row.previous_quantity == null || row.previous_quantity === 0) return false
                return Math.abs(row.difference) > 0.05 * Math.abs(row.previous_quantity)
              }}
              highlightColor="#EF4444"
            />
          </div>
        </div>
      )}

      {/* ── Edit Ingredient Modal ───────────────────────────────── */}
      <Modal isOpen={!!editInvRow} onClose={closeEditInv} title="">
        {editInvRow && (() => {
          const iv = inventory.find((i) => i.id === editInvRow.id)
          const ing = ingredients.find((i) => i.id === editInvRow.ingredient_id)
          const cp = coPackers.find((c) => c.id === editInvCPId)
          const unitCost = ing?.unit_cost ?? 0
          let convertedBaseQty = Number(editInvForm.quantity)
          if (editInvForm.unit !== editInvRow.unit) {
            try {
              const factor = getConversionFactorWithDensity(conversions, editInvForm.unit, editInvRow.unit, ing?.density_g_per_ml)
              convertedBaseQty = Number(editInvForm.quantity) * factor
            } catch { /* keep as entered */ }
          }
          const currentValue = convertedBaseQty * unitCost

          return (
            <div className="space-y-4">
              {/* Header */}
              <div className="flex items-center gap-3">
                <h3 className="text-base font-semibold text-text">{editInvRow.name}</h3>
                <span className="text-sm text-muted">at</span>
                {cp && <CPBadge coPacker={cp} />}
                <span className="text-sm text-text">{cp?.name}</span>
              </div>

              {/* Editable fields */}
              <div className="grid grid-cols-2 gap-4">
                <label className="block">
                  <span className="mb-1 block text-xs text-muted">Quantity ({editInvForm.unit})</span>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={editInvForm.quantity}
                      onChange={(e) => setEditInvForm((f) => ({ ...f, quantity: e.target.value }))}
                      className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                    />
                    <select
                      value={editInvForm.unit}
                      onChange={(e) => {
                        const newUnit = e.target.value
                        const oldUnit = editInvForm.unit
                        try {
                          const factor = getConversionFactorWithDensity(conversions, oldUnit, newUnit, ing?.density_g_per_ml)
                          const converted = Number(editInvForm.quantity) * factor
                          setEditInvForm((f) => ({ ...f, unit: newUnit, quantity: String(Math.round(converted * 100) / 100) }))
                        } catch {
                          setEditInvForm((f) => ({ ...f, unit: newUnit }))
                        }
                      }}
                      className="w-20 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-text outline-none focus:border-accent"
                    >
                      {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  {editInvForm.unit !== editInvRow.unit && (
                    <p className="mt-1 text-[10px] text-accent">
                      = {fmtQty(Math.round(convertedBaseQty * 100) / 100, editInvRow.unit)} (base unit)
                    </p>
                  )}
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-muted">Lot Number</span>
                  <input
                    type="text"
                    value={editInvForm.lot_number}
                    onChange={(e) => setEditInvForm((f) => ({ ...f, lot_number: e.target.value }))}
                    placeholder="Optional"
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-muted">Expiration Date</span>
                  <input
                    type="date"
                    value={editInvForm.expiration_date}
                    onChange={(e) => setEditInvForm((f) => ({ ...f, expiration_date: e.target.value }))}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                  />
                </label>
                <div>
                  <span className="mb-1 block text-xs text-muted">Current Value</span>
                  <p className="rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm font-mono text-text"><CostGuard>{fmt$(currentValue)}</CostGuard></p>
                </div>
              </div>

              {/* Read-only info */}
              <div className="flex gap-6 text-xs text-muted rounded-lg bg-surface/50 px-4 py-3">
                <span>Avg cost: <CostGuard><span className="font-mono text-text">{fmt$(unitCost)}</span>/{editInvRow.unit}</CostGuard></span>
                <span>Last updated: <span className="text-text">{iv?.updated_at ? format(new Date(iv.updated_at), 'MMM d, yyyy') : iv?.last_count_date ? format(new Date(iv.last_count_date), 'MMM d, yyyy') : '—'}</span></span>
              </div>

              {/* Adjustment notes */}
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Adjustment Notes</span>
                <textarea
                  value={editInvForm.notes}
                  onChange={(e) => setEditInvForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  placeholder="Reason for change (optional)…"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent resize-none"
                />
              </label>

              {/* Buttons */}
              <div className="flex items-center justify-between border-t border-border pt-4">
                {can('delete_any') && (
                <button
                  type="button"
                  onClick={() => { closeEditInv(); confirmDeleteInv(editInvRow, editInvCPId!) }}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-400/10"
                >
                  <Trash2 size={13} /> Delete
                </button>
                )}
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={closeEditInv}
                    className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveEditInv}
                    disabled={editInvSaving}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                  >
                    {editInvSaving ? 'Saving…' : 'Save Changes'}
                  </button>
                </div>
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* ── Delete Ingredient Confirm ─────────────────────────────── */}
      <ConfirmDialog
        isOpen={!!deleteInvRow}
        title={`Remove ${deleteInvRow?.name ?? 'ingredient'}?`}
        message={`Remove ${deleteInvRow?.name} from ${coPackers.find((c) => c.id === deleteInvCPId)?.name ?? 'co-packer'}? This sets the quantity to zero and removes the inventory record.`}
        confirmLabel="Yes, Remove"
        danger
        loading={deleteInvSaving}
        onConfirm={executeDeleteInv}
        onCancel={() => { setDeleteInvRow(null); setDeleteInvCPId(null) }}
      />

      {/* ── Full Count Modal ──────────────────────────────────── */}
      <Modal
        isOpen={fullCountCP !== null}
        onClose={() => setFullCountCP(null)}
        title={`Full Count — ${coPackers.find((c) => c.id === fullCountCP)?.name ?? ''}`}
        wide="xl"
      >
        <div className="space-y-4">
          {/* Table */}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-surface/50 text-muted">
                  <th className="px-3 py-2 font-medium">Ingredient</th>
                  <th className="px-3 py-2 font-medium text-right" style={{ width: 120 }}>System Qty</th>
                  <th className="px-3 py-2 font-medium text-right" style={{ width: 190 }}>Actual Count</th>
                  <th className="px-3 py-2 font-medium" style={{ width: 120 }}>Lot #</th>
                  <th className="px-3 py-2 font-medium text-right" style={{ width: 120 }}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {fullCountLines.map((line, idx) => {
                  const hasCount = line.actualCount !== ''
                  const convertedQty = hasCount ? convertFullCountQty(line, Number(line.actualCount)) : null
                  const diff = convertedQty !== null ? convertedQty - line.systemQty : null
                  const isConverted = line.enteredUnit !== line.unit
                  const willZero = !hasCount && fullCountZeroUnlisted && line.systemQty > 0
                  const rowBg = willZero
                    ? 'bg-red-500/5'
                    : diff != null && Math.abs(diff) > 0.01
                      ? diff > 0 ? 'bg-green-500/5' : 'bg-red-500/5'
                      : ''

                  return (
                    <tr key={`${line.ingredientId}-${idx}`} className={`border-b border-border last:border-0 ${rowBg}`}>
                      <td className="px-3 py-2 font-medium text-text">{line.ingredientName}</td>
                      <td className="px-3 py-2 text-right font-mono text-muted">
                        {fmtQty(line.systemQty, line.unit)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={line.actualCount}
                            onChange={(e) => updateFullCountLine(idx, 'actualCount', e.target.value)}
                            placeholder={willZero ? '→ 0' : '—'}
                            className="w-20 rounded border border-border bg-surface px-2 py-1 text-right text-xs font-mono text-text outline-none focus:border-accent placeholder:text-red-400/60"
                          />
                          <select
                            value={line.enteredUnit}
                            onChange={(e) => updateFullCountLine(idx, 'enteredUnit', e.target.value)}
                            className="w-16 rounded border border-border bg-surface px-1 py-1 text-xs text-text outline-none focus:border-accent"
                          >
                            {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                        </div>
                        {isConverted && hasCount && convertedQty !== null && (
                          <p className="mt-0.5 text-[10px] text-accent text-right">
                            = {fmtNum(Math.round(convertedQty * 100) / 100)} {line.unit}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={line.lotNumber}
                          onChange={(e) => updateFullCountLine(idx, 'lotNumber', e.target.value)}
                          placeholder="—"
                          className="w-24 rounded border border-border bg-surface px-2 py-1 text-xs font-mono text-text outline-none focus:border-accent"
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs font-medium">
                        {willZero ? (
                          <span className="text-red-400">→ 0</span>
                        ) : diff != null && Math.abs(diff) > 0.01 ? (
                          <span className={diff > 0 ? 'text-green-400' : 'text-red-400'}>
                            {diff > 0 ? '+' : ''}{fmtNum(Math.round(diff))} {line.unit}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Add ingredient + zero unlisted */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {fullCountAvailableIngs.length > 0 && (
                <select
                  value=""
                  onChange={(e) => { if (e.target.value) addFullCountIngredient(e.target.value) }}
                  className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                >
                  <option value="">+ Add Ingredient…</option>
                  {fullCountAvailableIngs.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}{ingTagLabel(i.id)}</option>
                  ))}
                </select>
              )}
            </div>
            <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={fullCountZeroUnlisted}
                onChange={(e) => setFullCountZeroUnlisted(e.target.checked)}
                className="rounded border-border"
              />
              Set unlisted ingredients to zero
            </label>
          </div>

          {/* Summary */}
          <div className="rounded-lg border border-border bg-surface/30 px-4 py-3 text-xs">
            <div className="flex items-center gap-6 text-muted">
              <span>Items counted: <span className="font-medium text-text">{fullCountStats.counted}</span></span>
              <span>Discrepancies: <span className={`font-medium ${fullCountStats.discrepancies > 0 ? 'text-amber-400' : 'text-text'}`}>{fullCountStats.discrepancies}</span></span>
              <span>Value difference: <span className={`font-mono font-medium ${fullCountStats.valueDiff > 0 ? 'text-green-400' : fullCountStats.valueDiff < 0 ? 'text-red-400' : 'text-text'}`}>
                {fullCountStats.valueDiff > 0 ? '+' : ''}{fmt$(fullCountStats.valueDiff)}
              </span></span>
            </div>
          </div>

          {/* Reason + Notes */}
          <div className="flex items-center gap-3">
            <select
              value={fullCountReason}
              onChange={(e) => setFullCountReason(e.target.value)}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
            >
              {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input
              value={fullCountNotes}
              onChange={(e) => setFullCountNotes(e.target.value)}
              placeholder="Additional notes…"
              className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent"
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <button
              onClick={() => setFullCountCP(null)}
              className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
            <button
              onClick={applyFullCount}
              disabled={fullCountSaving || (fullCountStats.counted === 0 && !fullCountZeroUnlisted)}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {fullCountSaving ? 'Applying…' : 'Apply Count'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Add Ingredient Modal ───────────────────────────────── */}
      <Modal
        isOpen={addIngCP !== null}
        onClose={() => setAddIngCP(null)}
        title={`Add Ingredient to ${coPackers.find((c) => c.id === addIngCP)?.name ?? ''}`}
      >
        <div className="space-y-4">
          {/* CSV import link */}
          <input ref={csvInputRef} type="file" accept=".csv" hidden onChange={handleCsvFile} />

          {csvPreview ? (
            /* ── CSV Preview ──────────────────────────────── */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-text">CSV Preview</p>
                <button
                  onClick={() => setCsvPreview(null)}
                  className="text-xs text-muted hover:text-text"
                >
                  Cancel import
                </button>
              </div>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border bg-surface/50 text-muted">
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Ingredient</th>
                      <th className="px-3 py-2 font-medium text-right">Quantity</th>
                      <th className="px-3 py-2 font-medium">Lot #</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvPreview.map((row, i) => (
                      <tr key={i} className={`border-b border-border last:border-0 ${row.matched ? '' : 'bg-red-500/5'}`}>
                        <td className="px-3 py-2">
                          {row.matched ? (
                            <span className="text-green-400 text-xs">Matched</span>
                          ) : (
                            <span className="text-red-400 text-xs">Not found</span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-medium text-text">{row.name}</td>
                        <td className="px-3 py-2 text-right font-mono text-text">
                          {fmtNum(row.quantity)} {row.unit}
                        </td>
                        <td className="px-3 py-2 font-mono text-muted">{row.lotNumber || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted">
                {csvPreview.filter((r) => r.matched).length} of {csvPreview.length} rows matched.
                {csvPreview.some((r) => !r.matched) && ' Unmatched rows will be skipped.'}
              </p>
              <div className="flex justify-end gap-3 border-t border-border pt-4">
                <button
                  onClick={() => setCsvPreview(null)}
                  className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
                >
                  Cancel
                </button>
                <button
                  onClick={importCsv}
                  disabled={csvImporting || csvPreview.filter((r) => r.matched).length === 0}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {csvImporting ? 'Importing…' : `Import ${csvPreview.filter((r) => r.matched).length} Items`}
                </button>
              </div>
            </div>
          ) : (
            /* ── Single-add form ──────────────────────────── */
            <div className="space-y-3">
              <div className="flex justify-end">
                <button
                  onClick={() => csvInputRef.current?.click()}
                  className="flex items-center gap-1.5 text-xs text-accent hover:underline"
                >
                  <Upload size={12} />
                  Import from CSV
                </button>
              </div>

              {/* Ingredient dropdown */}
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Ingredient</label>
                <select
                  value={addIngForm.ingredientId}
                  onChange={(e) => selectAddIngredient(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                >
                  <option value="">Select ingredient…</option>
                  {addIngAvailable.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}{ingTagLabel(i.id)}</option>
                  ))}
                </select>
              </div>

              {/* Quantity + Unit */}
              <div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="mb-1 block text-xs font-medium text-muted">Quantity</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={addIngForm.quantity}
                      onChange={(e) => setAddIngForm((f) => ({ ...f, quantity: e.target.value }))}
                      placeholder="0"
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                    />
                  </div>
                  <div style={{ width: 110 }}>
                    <label className="mb-1 block text-xs font-medium text-muted">Unit</label>
                    <select
                      value={addIngForm.unit}
                      onChange={(e) => setAddIngForm((f) => ({ ...f, unit: e.target.value }))}
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                    >
                      {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                </div>
                {/* Conversion preview */}
                {addIngForm.ingredientId && addIngForm.quantity && (() => {
                  const ing = ingredients.find((i) => i.id === addIngForm.ingredientId)
                  const baseUnit = ing?.unit ?? 'lbs'
                  if (addIngForm.unit === baseUnit || !addIngForm.unit) return null
                  try {
                    const factor = getConversionFactorWithDensity(conversions, addIngForm.unit, baseUnit, ing?.density_g_per_ml)
                    const converted = Number(addIngForm.quantity) * factor
                    return (
                      <p className="mt-1 text-xs text-accent">
                        = {fmtNum(Math.round(converted * 100) / 100)} {baseUnit}
                      </p>
                    )
                  } catch {
                    return (
                      <p className="mt-1 text-xs text-red-400">
                        Cannot convert {addIngForm.unit} → {baseUnit}
                      </p>
                    )
                  }
                })()}
              </div>

              {/* Lot Number + Expiration */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="mb-1 block text-xs font-medium text-muted">Lot Number</label>
                  <input
                    type="text"
                    value={addIngForm.lotNumber}
                    onChange={(e) => setAddIngForm((f) => ({ ...f, lotNumber: e.target.value }))}
                    placeholder="Optional"
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                  />
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-xs font-medium text-muted">Expiration Date</label>
                  <input
                    type="date"
                    value={addIngForm.expirationDate}
                    onChange={(e) => setAddIngForm((f) => ({ ...f, expirationDate: e.target.value }))}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                  />
                </div>
              </div>

              {/* Reason + Notes */}
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Reason</label>
                <select
                  value={addIngForm.reason}
                  onChange={(e) => setAddIngForm((f) => ({ ...f, reason: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                >
                  {ADD_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Notes</label>
                <input
                  type="text"
                  value={addIngForm.notes}
                  onChange={(e) => setAddIngForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Optional"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              </div>

              {/* Add button */}
              <div className="flex justify-end">
                <button
                  onClick={submitAddIngredient}
                  disabled={addIngSaving || !addIngForm.ingredientId || !addIngForm.quantity}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {addIngSaving ? 'Adding…' : 'Add to Inventory'}
                </button>
              </div>
            </div>
          )}

          {/* Running list of added items */}
          {addIngAdded.length > 0 && (
            <div className="border-t border-border pt-3 space-y-1">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
                Added this session ({addIngAdded.length})
              </p>
              {addIngAdded.map((item, i) => (
                <p key={i} className="text-xs text-green-400">
                  ✓ {item.name} — {fmtNum(item.qty)} {item.unit}
                </p>
              ))}
            </div>
          )}

          {/* Done button */}
          <div className="flex justify-end border-t border-border pt-4">
            <button
              onClick={() => setAddIngCP(null)}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-hover"
            >
              Done
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
