import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { sanitize } from '../lib/sanitizePayload'
import { dbInsert, dbInsertSingle, dbUpdate, dbDeleteIn } from '../lib/dbWrite'
import { safeBatch } from '../lib/safeQuery'
import { safeLoad } from '../lib/safeLoad'
import { useToast } from '../components/Toast'
import { useAuth } from '../contexts/AuthContext'
import { logActivity } from '../lib/activityLog'
import CostGuard from '../components/CostGuard'
import PageHeader from '../components/PageHeader'
import CPBadge from '../components/CPBadge'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import DataTable, { type Column } from '../components/DataTable'
import { PageSkeleton } from '../components/Skeleton'
import RecipeIcon from '../components/RecipeIcon'
import ImageUpload from '../components/ImageUpload'
import Tooltip from '../components/Tooltip'
import { Plus, Trash2, ChevronDown, ChevronUp, Copy, Pencil, BookOpen } from 'lucide-react'
import type {
  Recipe,
  RecipeIngredient,
  CoPacker,
  Ingredient,
  RecipeInsert,
  RecipeIngredientInsert,
  FinishedGoodsMovement,
  ProductionRun,
  IngredientTag,
  IngredientTagLink,
} from '../types/database'
import {
  loadConversions,
  getConversionFactorWithDensity,
  dualUnitParts,
  defaultRecipeUnit,
  unitGroup,
  RECIPE_UNITS,
  PACKAGE_SIZE_UNITS,
  type ConversionMap,
} from '../lib/conversions'
import { calculateRecipeCOGSBreakdown } from '../lib/recipeCosting'

/* ── Constants ──────────────────────────────────────────────── */

const STATUS_COLORS: Record<string, 'green' | 'accent' | 'purple' | 'red'> = {
  active: 'green',
  draft: 'accent',
  seasonal: 'purple',
  discontinued: 'red',
}

/* ── Types ──────────────────────────────────────────────────── */

interface BomRow extends Record<string, unknown> {
  id: string
  ingredientId: string
  ingredientName: string
  qtyPerUnit: number
  unit: string
  invUnit: string
  convertedQty: number
  ingredientUnitCost: number
  qtyPer1000: number
  qtyPer5000: number
  tolerancePct: number | null
  costPerUnit: number
  unitMismatch: boolean
  density: number | null
  providedBy: string
  cpChargePerUnit: number | null
}

interface FormLine {
  ingredient_id: string
  qty: string
  unit: string
  tolerance: string
  provided_by: 'fitbake' | 'copacker'
  cp_charge: string
}

interface EditLine {
  id: string | null
  ingredient_id: string
  qty: string
  unit: string
  tolerance: string
  provided_by: 'fitbake' | 'copacker'
  cp_charge: string
}

/* ── Helpers ────────────────────────────────────────────────── */

import { fmt$, fmtRate } from '../lib/format'

/* ================================================================ */

export default function Recipes() {
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [recipeIngredients, setRecipeIngredients] = useState<RecipeIngredient[]>([])
  const [coPackers, setCoPackers] = useState<CoPacker[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editModal, setEditModal] = useState<string | null>(null) // recipe id being edited
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [conversions, setConversions] = useState<ConversionMap>(new Map())
  const [fgMovements, setFgMovements] = useState<FinishedGoodsMovement[]>([])
  const [productionRuns, setProductionRuns] = useState<ProductionRun[]>([])
  const [tags, setTags] = useState<IngredientTag[]>([])
  const [tagLinks, setTagLinks] = useState<IngredientTagLink[]>([])
  const toast = useToast()
  const { can, appUser } = useAuth()

  /* ── Create-form state ────────────────────────────────────── */
  const [fName, setFName] = useState('')
  const [fSku, setFSku] = useState('')
  const [fCP, setFCP] = useState('')
  const [fPkgSize, setFPkgSize] = useState('16')
  const [fPkgUnit, setFPkgUnit] = useState('oz')
  const [fYield, setFYield] = useState('96.5')
  const [fWaste, setFWaste] = useState('2.5')
  const [fStatus, setFStatus] = useState('draft')
  const [fLines, setFLines] = useState<FormLine[]>([
    { ingredient_id: '', qty: '', unit: 'oz', tolerance: '2', provided_by: 'fitbake', cp_charge: '' },
  ])
  const [fImageUrl, setFImageUrl] = useState<string | null>(null)

  /* ── Edit-form state ──────────────────────────────────────── */
  const [editForm, setEditForm] = useState({
    name: '', sku: '', co_packer_id: '', package_size: '16',
    package_size_unit: 'oz', expected_yield_pct: '96.5',
    waste_tolerance_pct: '2.5', status: 'draft',
  })
  const [editImageUrl, setEditImageUrl] = useState<string | null>(null)
  const [editLines, setEditLines] = useState<EditLine[]>([])
  const [removedLineIds, setRemovedLineIds] = useState<string[]>([])
  const [editEstFreight, setEditEstFreight] = useState('')

  /* ── Data loading ─────────────────────────────────────────── */

  async function load() {
    const [recRes, riRes, cpRes, ingRes, convMap, mvRes, prRes, tagRes, tlRes] = await safeBatch(() => Promise.all([
      supabase.from('recipes').select('*').order('name'),
      supabase.from('recipe_ingredients').select('*'),
      supabase.from('co_packers').select('*').order('name'),
      supabase.from('ingredients').select('*').order('name'),
      loadConversions(),
      supabase.from('finished_goods_movements').select('*'),
      supabase.from('production_runs').select('*'),
      supabase.from('ingredient_tags').select('*').order('name'),
      supabase.from('ingredient_tag_links').select('*'),
    ]))
    setRecipes(recRes.data ?? [])
    setRecipeIngredients(riRes.data ?? [])
    setCoPackers(cpRes.data ?? [])
    setIngredients(ingRes.data ?? [])
    setConversions(convMap)
    setFgMovements(mvRes.data ?? [])
    setProductionRuns(prRes.data ?? [])
    setTags(tagRes.data ?? [])
    setTagLinks(tlRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => safeLoad(load, setLoading), [])

  /* ── Derived ──────────────────────────────────────────────── */

  function cpForRecipe(r: Recipe): CoPacker | undefined {
    return coPackers.find((cp) => cp.id === r.co_packer_id)
  }

  function ingTagLabel(ingredientId: string): string {
    const ingTags = tagLinks
      .filter((l) => l.ingredient_id === ingredientId)
      .map((l) => tags.find((t) => t.id === l.tag_id)?.name)
      .filter(Boolean)
    return ingTags.length > 0 ? ` [${ingTags.join(', ')}]` : ''
  }

  function ingTagObjects(ingredientId: string): IngredientTag[] {
    return tagLinks
      .filter((l) => l.ingredient_id === ingredientId)
      .map((l) => tags.find((t) => t.id === l.tag_id))
      .filter((t): t is IngredientTag => t != null)
  }

  function bomForRecipe(recipeId: string): BomRow[] {
    const ris = recipeIngredients.filter((ri) => ri.recipe_id === recipeId)
    return ris.map((ri) => {
      const ing = ingredients.find((i) => i.id === ri.ingredient_id)
      const invUnit = ing?.unit ?? 'lbs'
      const density = ing?.density_g_per_ml ?? null
      const isCp = ri.provided_by === 'copacker'
      let factor = 1
      let mismatch = false
      try {
        factor = getConversionFactorWithDensity(conversions, ri.unit, invUnit, density)
      } catch {
        const rg = unitGroup(ri.unit)
        const ig = unitGroup(invUnit)
        mismatch = !isCp && rg !== 'unknown' && ig !== 'unknown' && rg !== ig
      }
      const qtyInInvUnit = ri.quantity_per_unit * factor
      const unitCost = ing?.unit_cost ?? 0
      const costPerUnit = isCp ? (ri.cp_charge_per_unit ?? 0) : qtyInInvUnit * unitCost
      return {
        id: ri.id,
        ingredientId: ri.ingredient_id ?? '',
        ingredientName: ing?.name ?? '?',
        qtyPerUnit: ri.quantity_per_unit,
        unit: ri.unit,
        invUnit,
        convertedQty: qtyInInvUnit,
        ingredientUnitCost: unitCost,
        qtyPer1000: qtyInInvUnit * 1000,
        qtyPer5000: qtyInInvUnit * 5000,
        tolerancePct: ri.tolerance_pct,
        costPerUnit,
        unitMismatch: mismatch,
        density,
        providedBy: ri.provided_by ?? 'fitbake',
        cpChargePerUnit: ri.cp_charge_per_unit,
      }
    })
  }

  function calcLandedCogs(recipe: Recipe) {
    const cogsBreakdown = calculateRecipeCOGSBreakdown(recipe.id, recipeIngredients, ingredients, conversions)
    const ingredientCogs = cogsBreakdown.total
    const fitbakeIngredientCost = cogsBreakdown.fitbakeCost
    const cpIngredientCharge = cogsBreakdown.cpCharge
    const cp = cpForRecipe(recipe)
    const cpFee = cp?.fee_per_unit ?? 0

    // Freight from actual movements
    const recipeMoves = fgMovements.filter(
      (m) => m.recipe_id === recipe.id && m.shipping_cost != null && Number(m.shipping_cost) > 0,
    )
    const cpToFba = recipeMoves.filter((m) => m.freight_leg === 'cp_to_fba')
    const cpTo3pl = recipeMoves.filter((m) => m.freight_leg === 'cp_to_3pl')

    const avgPerUnit = (moves: FinishedGoodsMovement[]) => {
      if (moves.length === 0) return 0
      const totalCost = moves.reduce((s, m) => s + Number(m.shipping_cost ?? 0), 0)
      const totalQty = moves.reduce((s, m) => s + m.quantity, 0)
      return totalQty > 0 ? totalCost / totalQty : 0
    }

    const avgCpToFba = avgPerUnit(cpToFba)
    const avgCpTo3pl = avgPerUnit(cpTo3pl)

    let freightPerUnit: number
    let freightSource: 'actual' | 'estimate' | 'none'
    if (recipeMoves.length > 0) {
      // Weighted average across all freight legs
      const totalCost = recipeMoves.reduce((s, m) => s + Number(m.shipping_cost ?? 0), 0)
      const totalQty = recipeMoves.reduce((s, m) => s + m.quantity, 0)
      freightPerUnit = totalQty > 0 ? totalCost / totalQty : 0
      freightSource = 'actual'
    } else if (recipe.estimated_freight_per_unit != null) {
      freightPerUnit = Number(recipe.estimated_freight_per_unit)
      freightSource = 'estimate'
    } else {
      freightPerUnit = 0
      freightSource = 'none'
    }

    // Waste from reconciled runs
    const reconciledRuns = productionRuns.filter(
      (r) => r.recipe_id === recipe.id && r.status === 'reconciled'
        && r.produced_quantity && r.produced_quantity > 0,
    )
    let wastePerUnit = 0
    if (reconciledRuns.length > 0) {
      const totalWaste = reconciledRuns.reduce((s, r) => s + Number(r.waste_cost ?? 0), 0)
      const totalProduced = reconciledRuns.reduce((s, r) => s + (r.produced_quantity ?? 0), 0)
      wastePerUnit = totalProduced > 0 ? Math.abs(totalWaste / totalProduced) : 0
    }

    return {
      ingredientCogs,
      fitbakeIngredientCost,
      cpIngredientCharge,
      cpFee,
      freightPerUnit,
      freightSource,
      freightBreakdown: { cpToFba: avgCpToFba, cpTo3pl: avgCpTo3pl },
      freightShipmentCount: recipeMoves.length,
      wastePerUnit,
      wasteRunCount: reconciledRuns.length,
      total: ingredientCogs + cpFee + freightPerUnit + wastePerUnit,
    }
  }

  /* ── BOM table columns ────────────────────────────────────── */

  const bomColumns: Column<BomRow>[] = useMemo(
    () => [
      {
        label: 'Ingredient',
        key: 'ingredientName',
        width: '200px',
        render: (row) => {
          const rowTags = ingTagObjects(row.ingredientId)
          return (
            <span className="flex items-center gap-1 font-medium text-text">
              {row.ingredientName}
              {rowTags.map((tag) => (
                <span key={tag.id} className="ml-1 inline-block rounded-full px-1.5 py-0 text-[9px] font-medium" style={{ backgroundColor: tag.color + '25', color: tag.color }}>
                  {tag.name}
                </span>
              ))}
              {row.unitMismatch && (
                <Tooltip maxWidth={320} content={
                  <span className="text-red-200">
                    Unit type mismatch: recipe uses {unitGroup(row.unit)} but ingredient tracks in {unitGroup(row.invUnit)}.
                    Update the ingredient or recipe unit.
                  </span>
                }>
                  <span className="cursor-help text-red-500">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                    </svg>
                  </span>
                </Tooltip>
              )}
            </span>
          )
        },
      },
      {
        label: 'Source',
        key: 'providedBy',
        width: '90px',
        render: (row) => (
          <Badge color={row.providedBy === 'copacker' ? 'amber' : 'accent'}>
            {row.providedBy === 'copacker' ? 'CP' : 'You'}
          </Badge>
        ),
      },
      {
        label: 'Qty / Unit',
        key: 'qtyPerUnit',
        align: 'right',
        width: '130px',
        render: (row) => (
          <span className="font-mono text-text">
            {row.qtyPerUnit.toFixed(2)} {row.unit}
          </span>
        ),
      },
      {
        label: 'Per 1,000',
        key: 'qtyPer1000',
        align: 'right',
        width: '220px',
        render: (row) => {
          const d = dualUnitParts(conversions, parseFloat(row.qtyPer1000.toFixed(1)), row.invUnit)
          return (
            <span className="font-mono text-text">
              {d.primary}
              {d.secondary && <span className="text-muted"> ({d.secondary})</span>}
            </span>
          )
        },
      },
      {
        label: 'Per 5,000',
        key: 'qtyPer5000',
        align: 'right',
        width: '220px',
        render: (row) => {
          const d = dualUnitParts(conversions, parseFloat(row.qtyPer5000.toFixed(1)), row.invUnit)
          return (
            <span className="font-mono text-text">
              {d.primary}
              {d.secondary && <span className="text-muted"> ({d.secondary})</span>}
            </span>
          )
        },
      },
      {
        label: 'Tolerance ±',
        key: 'tolerancePct',
        align: 'center',
        width: '100px',
        render: (row) => (
          <span className="font-mono text-xs text-muted">
            {row.providedBy === 'copacker' ? '—' : row.tolerancePct != null ? `${row.tolerancePct}%` : '—'}
          </span>
        ),
      },
      {
        label: 'Cost / Unit',
        key: 'costPerUnit',
        align: 'right',
        width: '110px',
        render: (row) => {
          if (row.unitMismatch) {
            return (
              <CostGuard>
              <Tooltip content={
                <span className="text-red-200">
                  Set density on this ingredient to enable weight/volume conversion.
                </span>
              }>
                <span className="cursor-help text-xs font-medium text-red-500">
                  Unit mismatch
                </span>
              </Tooltip>
              </CostGuard>
            )
          }
          if (row.providedBy === 'copacker') {
            return (
              <CostGuard>
              <Tooltip maxWidth={280} content={
                <>
                  <span className="block font-semibold text-text">{row.ingredientName}</span>
                  <span className="mt-1 block text-muted">Co-packer provided ingredient</span>
                  <span className="mt-1 block font-semibold text-amber-400">
                    CP Charge: {fmtRate(row.costPerUnit)}/unit
                  </span>
                </>
              }>
                <span className="cursor-default font-mono font-medium text-amber-400">
                  {fmtRate(row.costPerUnit)}
                </span>
              </Tooltip>
              </CostGuard>
            )
          }
          const singular: Record<string, string> = { lbs: 'lb', oz: 'oz', g: 'g', kg: 'kg', fl_oz: 'fl oz', ml: 'ml', l: 'l', gal: 'gal', pcs: 'pc' }
          const needsConversion = row.unit !== row.invUnit
          const usedDensity = row.density != null && unitGroup(row.unit) !== unitGroup(row.invUnit)
          return (
            <CostGuard>
            <Tooltip maxWidth={320} content={
              <>
                <span className="block font-semibold text-text">{row.ingredientName}</span>
                <span className="mt-1 block text-muted">
                  Recipe qty: {row.qtyPerUnit} {row.unit} per unit
                </span>
                {usedDensity && (
                  <span className="block text-muted">
                    Density: {row.density} g/ml
                  </span>
                )}
                {needsConversion && (
                  <span className="block text-muted">
                    Converted: {row.convertedQty.toFixed(row.convertedQty < 1 ? 4 : 2)} {row.invUnit}
                  </span>
                )}
                <span className="block text-muted">
                  Ingredient cost: ${row.ingredientUnitCost.toFixed(2)} per {singular[row.invUnit] ?? row.invUnit}
                </span>
                <span className="mt-1 block font-semibold text-green-400">
                  = {fmtRate(row.costPerUnit)} per unit
                </span>
              </>
            }>
              <span className="cursor-default font-mono font-medium text-text">
                {fmtRate(row.costPerUnit)}
              </span>
            </Tooltip>
            </CostGuard>
          )
        },
      },
    ],
    [conversions, tags, tagLinks],
  )

  /* ── Form helpers (create) ────────────────────────────────── */

  function updateLine(idx: number, field: keyof FormLine, value: string) {
    setFLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)))
  }

  function addLine() {
    setFLines((prev) => [...prev, { ingredient_id: '', qty: '', unit: 'oz', tolerance: '2', provided_by: 'fitbake', cp_charge: '' }])
  }

  function removeLine(idx: number) {
    setFLines((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)))
  }

  const formCogs = useMemo(() => {
    return fLines.reduce((sum, l) => {
      if (l.provided_by === 'copacker') return sum + (Number(l.cp_charge) || 0)
      if (!l.ingredient_id || !l.qty) return sum
      const ing = ingredients.find((i) => i.id === l.ingredient_id)
      if (!ing) return sum
      let factor = 1
      try { factor = getConversionFactorWithDensity(conversions, l.unit, ing.unit, ing.density_g_per_ml) } catch { /* fallback */ }
      return sum + Number(l.qty) * factor * ing.unit_cost
    }, 0)
  }, [fLines, ingredients, conversions])

  function resetForm() {
    setFName('')
    setFSku('')
    setFCP('')
    setFPkgSize('16')
    setFPkgUnit('oz')
    setFYield('96.5')
    setFWaste('2.5')
    setFStatus('draft')
    setFLines([{ ingredient_id: '', qty: '', unit: 'oz', tolerance: '2', provided_by: 'fitbake', cp_charge: '' }])
    setFImageUrl(null)
  }

  /* ── Submit new recipe ────────────────────────────────────── */

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    try {
      const { data: newRec, error } = await dbInsertSingle('recipes', sanitize('recipes', {
          name: fName,
          sku: fSku,
          co_packer_id: fCP || null,
          package_size: Number(fPkgSize) || 16,
          package_size_unit: fPkgUnit,
          expected_yield_pct: Number(fYield) || 96.5,
          waste_tolerance_pct: Number(fWaste) || 2.5,
          status: fStatus,
          ingredient_cogs: formCogs,
          image_url: fImageUrl,
        }))
      if (error) throw error

      if (newRec) {
        const inserts = fLines
          .filter((l) => l.ingredient_id && l.qty)
          .map((l) => sanitize('recipe_ingredients', {
            recipe_id: newRec.id,
            ingredient_id: l.ingredient_id,
            quantity_per_unit: Number(l.qty),
            unit: l.unit,
            tolerance_pct: l.provided_by === 'fitbake' && l.tolerance ? Number(l.tolerance) : null,
            provided_by: l.provided_by,
            cp_charge_per_unit: l.provided_by === 'copacker' && l.cp_charge ? Number(l.cp_charge) : null,
            cp_charge_unit: l.provided_by === 'copacker' ? 'per unit' : null,
          }))

        if (inserts.length > 0) {
          await dbInsert('recipe_ingredients', inserts)
        }
      }

      setModalOpen(false)
      resetForm()
      toast.success('Recipe created')
      if (newRec) logActivity(appUser?.id, 'create_recipe', 'recipe', newRec.id)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create recipe')
    } finally {
      setSaving(false)
    }
  }

  /* ── Duplicate recipe ─────────────────────────────────────── */

  async function handleDuplicate(recipe: Recipe) {
    setSaving(true)
    try {
      const { data: newRec, error } = await dbInsertSingle('recipes', sanitize('recipes', {
          name: `${recipe.name} (Copy)`,
          sku: `${recipe.sku}-COPY`,
          co_packer_id: recipe.co_packer_id,
          package_size: recipe.package_size,
          package_size_unit: recipe.package_size_unit,
          expected_yield_pct: recipe.expected_yield_pct,
          waste_tolerance_pct: recipe.waste_tolerance_pct,
          status: 'draft',
          ingredient_cogs: recipe.ingredient_cogs,
          image_url: recipe.image_url,
        }))
      if (error) throw error

      if (newRec) {
        const ris = recipeIngredients.filter((ri) => ri.recipe_id === recipe.id)
        if (ris.length > 0) {
          await dbInsert('recipe_ingredients',
            ris.map((ri) => sanitize('recipe_ingredients', {
              recipe_id: newRec.id,
              ingredient_id: ri.ingredient_id,
              quantity_per_unit: ri.quantity_per_unit,
              unit: ri.unit,
              tolerance_pct: ri.tolerance_pct,
              provided_by: ri.provided_by,
              cp_charge_per_unit: ri.cp_charge_per_unit,
              cp_charge_unit: ri.cp_charge_unit,
            })),
          )
        }
      }

      toast.success('Recipe duplicated')
      logActivity(appUser?.id, 'duplicate_recipe', 'recipe', newRec?.id)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to duplicate recipe')
    } finally {
      setSaving(false)
    }
  }

  /* ── Edit BOM ─────────────────────────────────────────────── */

  function openEditModal(recipeId: string) {
    const recipe = recipes.find((r) => r.id === recipeId)
    if (!recipe) return
    setEditForm({
      name: recipe.name,
      sku: recipe.sku,
      co_packer_id: recipe.co_packer_id ?? '',
      package_size: String(recipe.package_size ?? 16),
      package_size_unit: recipe.package_size_unit ?? 'oz',
      expected_yield_pct: String(recipe.expected_yield_pct ?? 96.5),
      waste_tolerance_pct: String(recipe.waste_tolerance_pct ?? 2.5),
      status: recipe.status ?? 'draft',
    })
    const ris = recipeIngredients.filter((ri) => ri.recipe_id === recipeId)
    setEditLines(
      ris.map((ri) => ({
        id: ri.id,
        ingredient_id: ri.ingredient_id ?? '',
        qty: String(ri.quantity_per_unit),
        unit: ri.unit,
        tolerance: ri.tolerance_pct != null ? String(ri.tolerance_pct) : '',
        provided_by: (ri.provided_by as 'fitbake' | 'copacker') ?? 'fitbake',
        cp_charge: ri.cp_charge_per_unit != null ? String(ri.cp_charge_per_unit) : '',
      })),
    )
    setRemovedLineIds([])
    setEditImageUrl(recipe.image_url)
    setEditEstFreight(recipe.estimated_freight_per_unit != null ? String(recipe.estimated_freight_per_unit) : '')
    setEditModal(recipeId)
  }

  function updateEditLine(idx: number, field: keyof EditLine, value: string) {
    setEditLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)))
  }

  function addEditLine() {
    setEditLines((prev) => [...prev, { id: null, ingredient_id: '', qty: '', unit: 'oz', tolerance: '2', provided_by: 'fitbake', cp_charge: '' }])
  }

  function removeEditLine(idx: number) {
    setEditLines((prev) => {
      const line = prev[idx]
      if (line.id) setRemovedLineIds((ids) => [...ids, line.id!])
      return prev.filter((_, i) => i !== idx)
    })
  }

  const editCogs = useMemo(() => {
    return editLines.reduce((sum, l) => {
      if (l.provided_by === 'copacker') return sum + (Number(l.cp_charge) || 0)
      if (!l.ingredient_id || !l.qty) return sum
      const ing = ingredients.find((i) => i.id === l.ingredient_id)
      if (!ing) return sum
      let factor = 1
      try { factor = getConversionFactorWithDensity(conversions, l.unit, ing.unit, ing.density_g_per_ml) } catch { /* fallback */ }
      return sum + Number(l.qty) * factor * ing.unit_cost
    }, 0)
  }, [editLines, ingredients, conversions])

  async function handleEditSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!editModal) return
    setSaving(true)
    try {
      // Delete removed lines
      if (removedLineIds.length > 0) {
        await dbDeleteIn('recipe_ingredients', 'id', removedLineIds)
      }

      // Update existing lines
      for (const line of editLines) {
        if (line.id) {
          await dbUpdate('recipe_ingredients', sanitize('recipe_ingredients', {
              ingredient_id: line.ingredient_id,
              quantity_per_unit: Number(line.qty),
              unit: line.unit,
              tolerance_pct: line.provided_by === 'fitbake' && line.tolerance ? Number(line.tolerance) : null,
              provided_by: line.provided_by,
              cp_charge_per_unit: line.provided_by === 'copacker' && line.cp_charge ? Number(line.cp_charge) : null,
              cp_charge_unit: line.provided_by === 'copacker' ? 'per unit' : null,
            }), 'id', line.id)
        }
      }

      // Insert new lines
      const newLines = editLines
        .filter((l) => !l.id && l.ingredient_id)
        .map((l) => sanitize('recipe_ingredients', {
          recipe_id: editModal,
          ingredient_id: l.ingredient_id,
          quantity_per_unit: Number(l.qty),
          unit: l.unit,
          tolerance_pct: l.provided_by === 'fitbake' && l.tolerance ? Number(l.tolerance) : null,
          provided_by: l.provided_by,
          cp_charge_per_unit: l.provided_by === 'copacker' && l.cp_charge ? Number(l.cp_charge) : null,
          cp_charge_unit: l.provided_by === 'copacker' ? 'per unit' : null,
        }))
      if (newLines.length > 0) {
        await dbInsert('recipe_ingredients', newLines)
      }

      // Compute landed COGS to persist
      const editRecipe = recipes.find((r) => r.id === editModal)
      const estFreight = editEstFreight ? Number(editEstFreight) : null
      let landedCogsVal: number | null = null
      if (editRecipe) {
        const tempRecipe = { ...editRecipe, estimated_freight_per_unit: estFreight }
        const lc = calcLandedCogs(tempRecipe)
        landedCogsVal = lc.total
      }

      // Update recipe
      const { error } = await dbUpdate('recipes', sanitize('recipes', {
        name: editForm.name,
        sku: editForm.sku,
        co_packer_id: editForm.co_packer_id || null,
        package_size: Number(editForm.package_size) || 16,
        package_size_unit: editForm.package_size_unit,
        expected_yield_pct: Number(editForm.expected_yield_pct) || 96.5,
        waste_tolerance_pct: Number(editForm.waste_tolerance_pct) || 2.5,
        status: editForm.status,
        ingredient_cogs: editCogs,
        image_url: editImageUrl,
        estimated_freight_per_unit: estFreight,
        landed_cogs: landedCogsVal,
      }), 'id', editModal)
      if (error) throw error

      setEditModal(null)
      toast.success('Recipe updated')
      logActivity(appUser?.id, 'update_recipe', 'recipe', editModal)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update recipe')
    } finally {
      setSaving(false)
    }
  }

  /* ── Render ───────────────────────────────────────────────── */

  if (loading) return <PageSkeleton />

  return (
    <div>
      <PageHeader title="Recipes / BOM" subtitle="Product formulas and bills of materials">
        {can('edit_recipes') && (
        <button
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
        >
          <Plus size={16} />
          New Recipe
        </button>
        )}
      </PageHeader>

      {/* Empty state */}
      {recipes.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <BookOpen size={40} className="mb-3 text-muted/40" />
          <p className="text-sm font-medium text-muted">No recipes yet</p>
          <p className="mt-1 text-xs text-muted/70">Create your first recipe to define product formulas</p>
        </div>
      )}

      {/* Recipe cards grid */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {recipes.map((recipe) => {
          const cp = cpForRecipe(recipe)
          const bom = bomForRecipe(recipe.id)
          const expanded = expandedId === recipe.id
          const ingCount = bom.length
          const totalCogs = bom.reduce((s, r) => s + r.costPerUnit, 0)
          const lc = calcLandedCogs(recipe)
          const statusColor = STATUS_COLORS[recipe.status ?? 'draft'] ?? 'accent'

          return (
            <div
              key={recipe.id}
              className="rounded-xl border border-border bg-card overflow-hidden"
            >
              {/* Card top */}
              <div
                className="cursor-pointer p-5"
                onClick={() => setExpandedId(expanded ? null : recipe.id)}
              >
                <div className="flex items-start justify-between">
                  {/* Left */}
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <RecipeIcon imageUrl={recipe.image_url} recipeName={recipe.name} coPackerColor={cp?.color} size="md" />
                    <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-sm font-semibold text-text">{recipe.name}</h3>
                      <Badge color={statusColor}>
                        {(recipe.status ?? 'draft').toUpperCase()}
                      </Badge>
                    </div>
                    <p className="mt-1 font-mono text-xs text-muted">{recipe.sku}</p>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                      {cp && <CPBadge coPacker={cp} />}
                      {cp && <span>Produced by {cp.name}</span>}
                    </div>
                    </div>
                  </div>

                  {/* Right — COGS */}
                  <CostGuard>
                  <div className="ml-4 flex flex-col items-end gap-1 text-right">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted">Ingredient COGS</p>
                      <p className="font-mono text-sm font-semibold text-text">
                        {fmtRate(lc.ingredientCogs)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted">
                        Landed COGS
                        {lc.freightSource === 'estimate' && <span className="ml-1 normal-case italic">(est.)</span>}
                        {lc.freightSource === 'none' && <span className="ml-1 normal-case italic">(no freight)</span>}
                      </p>
                      <Tooltip maxWidth={280} content={
                        <>
                          <span className="mb-1.5 block font-semibold text-text">Landed COGS Breakdown</span>
                          <span className="flex justify-between gap-6 text-muted">
                            <span>{lc.cpIngredientCharge > 0 ? 'Your Ingredients' : 'Ingredients'}</span>
                            <span className="font-mono text-text">{fmtRate(lc.fitbakeIngredientCost)}</span>
                          </span>
                          {lc.cpIngredientCharge > 0 && (
                            <span className="flex justify-between gap-6 text-muted">
                              <span>CP-Provided Ingredients</span>
                              <span className="font-mono text-amber-400">{fmtRate(lc.cpIngredientCharge)}</span>
                            </span>
                          )}
                          <span className="flex justify-between gap-6 text-muted">
                            <span>Co-Packer Fee</span>
                            <span className="font-mono text-text">{fmtRate(lc.cpFee)}</span>
                          </span>
                          <span className="flex justify-between gap-6 text-muted">
                            <span>
                              Freight
                              {lc.freightSource === 'actual' && ` (${lc.freightShipmentCount} shipments)`}
                              {lc.freightSource === 'estimate' && ' (est.)'}
                            </span>
                            <span className="font-mono text-text">{fmtRate(lc.freightPerUnit)}</span>
                          </span>
                          {lc.freightSource === 'actual' && (lc.freightBreakdown.cpToFba > 0 || lc.freightBreakdown.cpTo3pl > 0) && (
                            <span className="ml-3 block text-[10px] text-muted/70">
                              {lc.freightBreakdown.cpToFba > 0 && <span className="block">CP{'\u2192'}FBA: {fmtRate(lc.freightBreakdown.cpToFba)}</span>}
                              {lc.freightBreakdown.cpTo3pl > 0 && <span className="block">CP{'\u2192'}3PL: {fmtRate(lc.freightBreakdown.cpTo3pl)}</span>}
                            </span>
                          )}
                          <span className="flex justify-between gap-6 text-muted">
                            <span>Waste{lc.wasteRunCount > 0 && ` (${lc.wasteRunCount} runs)`}</span>
                            <span className="font-mono text-text">{fmtRate(lc.wastePerUnit)}</span>
                          </span>
                          <span className="mt-1.5 block border-t border-border pt-1.5">
                            <span className="flex justify-between gap-6 font-semibold">
                              <span className="text-text">Landed COGS</span>
                              <span className="font-mono text-green-400">{fmtRate(lc.total)}/unit</span>
                            </span>
                          </span>
                        </>
                      }>
                        <span className="cursor-default font-mono text-sm font-semibold text-green-400">
                          {fmtRate(lc.total)}
                        </span>
                      </Tooltip>
                    </div>
                  </div>
                  </CostGuard>
                </div>

                {/* Expand indicator */}
                <div className="mt-3 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
                  {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {expanded ? 'Collapse BOM' : `View BOM (${bom.length} ingredients)`}
                </div>
              </div>

              {/* Expanded BOM */}
              {expanded && (
                <div className="border-t border-border px-5 pb-5 pt-3">
                  <DataTable columns={bomColumns} data={bom} />

                  {/* Footer row */}
                  <div className="mt-3 flex items-center justify-between rounded-lg bg-surface/50 px-4 py-2.5 text-sm">
                    <span className="text-muted">
                      {ingCount} ingredient{ingCount !== 1 ? 's' : ''}
                    </span>
                    <CostGuard>
                    <span className="font-mono font-semibold text-green-400">
                      {fmt$(totalCogs)} COGS
                    </span>
                    </CostGuard>
                  </div>

                  {/* Action buttons */}
                  <div className="mt-3 flex items-center gap-2">
                    {can('edit_recipes') && (
                    <button
                      onClick={() => openEditModal(recipe.id)}
                      className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-text hover:bg-hover"
                    >
                      <Pencil size={12} />
                      Edit
                    </button>
                    )}
                    {can('edit_recipes') && (
                    <button
                      onClick={() => handleDuplicate(recipe)}
                      className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-text hover:bg-hover"
                    >
                      <Copy size={12} />
                      Duplicate
                    </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── New Recipe Modal ────────────────────────────────── */}
      <Modal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); resetForm() }}
        title="New Recipe"
        wide="xl"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" value={fName} onChange={setFName} required placeholder="e.g. Almond Bliss Bar" />
            <Field label="SKU" value={fSku} onChange={setFSku} required placeholder="e.g. FB-ALM-001" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="mb-1 block text-xs text-muted">Co-Packer</span>
              <select
                value={fCP}
                onChange={(e) => setFCP(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              >
                <option value="">Select…</option>
                {coPackers.map((cp) => (
                  <option key={cp.id} value={cp.id}>{cp.name}</option>
                ))}
              </select>
            </div>
            <div>
              <span className="mb-1 block text-xs text-muted">Status</span>
              <select
                value={fStatus}
                onChange={(e) => setFStatus(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              >
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="seasonal">Seasonal</option>
                <option value="discontinued">Discontinued</option>
              </select>
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs text-muted">Product Image</span>
            <ImageUpload
              currentUrl={fImageUrl}
              onUploaded={setFImageUrl}
              onRemoved={() => setFImageUrl(null)}
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <span className="mb-1 block text-xs text-muted">Package Size</span>
              <div className="flex">
                <input
                  type="number"
                  step="any"
                  value={fPkgSize}
                  onChange={(e) => setFPkgSize(e.target.value)}
                  className="w-full rounded-l-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none transition-colors focus:border-accent"
                />
                <select
                  value={fPkgUnit}
                  onChange={(e) => setFPkgUnit(e.target.value)}
                  className="rounded-r-lg border border-l-0 border-border bg-surface px-2 py-2 text-sm text-text outline-none focus:border-accent"
                >
                  {PACKAGE_SIZE_UNITS.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>
            <Field label="Expected Yield %" value={fYield} onChange={setFYield} type="number" />
            <Field label="Waste Tolerance %" value={fWaste} onChange={setFWaste} type="number" />
          </div>

          {/* Ingredients section */}
          <div className="border-t border-border pt-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wider text-muted">Ingredients</p>
              <button
                type="button"
                onClick={addLine}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
              >
                <Plus size={14} />
                Add Ingredient
              </button>
            </div>

            <div className="space-y-3">
              {fLines.map((line, idx) => {
                const ing = ingredients.find((i) => i.id === line.ingredient_id)
                const isCp = line.provided_by === 'copacker'
                let lineCost = 0
                if (isCp) {
                  lineCost = Number(line.cp_charge) || 0
                } else if (ing && Number(line.qty || 0) > 0) {
                  let factor = 1
                  try { factor = getConversionFactorWithDensity(conversions, line.unit, ing.unit, ing.density_g_per_ml) } catch { /* fallback */ }
                  lineCost = Number(line.qty) * factor * ing.unit_cost
                }

                return (
                  <div key={idx} className={`rounded-lg border ${isCp ? 'border-amber-500/30 bg-amber-500/5' : 'border-border bg-surface/50'} p-3`}>
                    <div className="grid grid-cols-[1fr_90px_80px_80px_80px_80px_40px] items-center gap-3">
                      <select
                        value={line.ingredient_id}
                        onChange={(e) => {
                          updateLine(idx, 'ingredient_id', e.target.value)
                          const selected = ingredients.find((i) => i.id === e.target.value)
                          if (selected) updateLine(idx, 'unit', defaultRecipeUnit(selected.category, selected.unit))
                        }}
                        required
                        className="min-w-[180px] rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                      >
                        <option value="">Ingredient…</option>
                        {ingredients.map((i) => (
                          <option key={i.id} value={i.id}>{i.name}{ingTagLabel(i.id)}</option>
                        ))}
                      </select>
                      <select
                        value={line.provided_by}
                        onChange={(e) => updateLine(idx, 'provided_by', e.target.value)}
                        className={`w-full rounded-lg border border-border bg-surface px-2 py-2 text-xs font-medium outline-none focus:border-accent ${isCp ? 'text-amber-400' : 'text-text'}`}
                      >
                        <option value="fitbake">You</option>
                        <option value="copacker">Co-Packer</option>
                      </select>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={line.qty}
                        onChange={(e) => updateLine(idx, 'qty', e.target.value)}
                        required
                        placeholder="Qty"
                        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                      />
                      <select
                        value={line.unit}
                        onChange={(e) => updateLine(idx, 'unit', e.target.value)}
                        className="w-full rounded-lg border border-border bg-surface px-2 py-2 text-sm text-text outline-none focus:border-accent"
                      >
                        {RECIPE_UNITS.map((u) => (
                          <option key={u} value={u}>{u}</option>
                        ))}
                      </select>
                      {isCp ? (
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={line.cp_charge}
                          onChange={(e) => updateLine(idx, 'cp_charge', e.target.value)}
                          placeholder="$/unit"
                          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-amber-400 outline-none focus:border-accent"
                        />
                      ) : (
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={line.tolerance}
                          onChange={(e) => updateLine(idx, 'tolerance', e.target.value)}
                          placeholder="± %"
                          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                        />
                      )}
                      <span className={`text-right font-mono text-xs ${isCp ? 'text-amber-400' : 'text-muted'}`}>
                        {lineCost > 0 ? fmtRate(lineCost) : '—'}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeLine(idx)}
                        className="flex items-center justify-center rounded-lg text-muted transition-colors hover:text-red-400"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Total COGS */}
          <div className="flex items-center justify-between border-t border-border pt-4">
            <span className="text-sm text-muted">Total Ingredient COGS</span>
            <CostGuard><span className="font-mono text-lg font-semibold text-green-400">{fmt$(formCogs)}</span></CostGuard>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => { setModalOpen(false); resetForm() }}
              className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Create Recipe'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Edit Recipe Modal ────────────────────────────────── */}
      <Modal
        isOpen={editModal !== null}
        onClose={() => setEditModal(null)}
        title={`Edit ${editForm.name || 'Recipe'}`}
        wide="xl"
      >
        <form onSubmit={handleEditSave} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" value={editForm.name} onChange={(v) => setEditForm((f) => ({ ...f, name: v }))} required placeholder="e.g. Almond Bliss Bar" />
            <Field label="SKU" value={editForm.sku} onChange={(v) => setEditForm((f) => ({ ...f, sku: v }))} required placeholder="e.g. FB-ALM-001" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="mb-1 block text-xs text-muted">Co-Packer</span>
              <select
                value={editForm.co_packer_id}
                onChange={(e) => setEditForm((f) => ({ ...f, co_packer_id: e.target.value }))}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              >
                <option value="">Select…</option>
                {coPackers.map((cp) => (
                  <option key={cp.id} value={cp.id}>{cp.name}</option>
                ))}
              </select>
            </div>
            <div>
              <span className="mb-1 block text-xs text-muted">Status</span>
              <select
                value={editForm.status}
                onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              >
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="seasonal">Seasonal</option>
                <option value="discontinued">Discontinued</option>
              </select>
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs text-muted">Product Image</span>
            <ImageUpload
              currentUrl={editImageUrl}
              onUploaded={setEditImageUrl}
              onRemoved={() => setEditImageUrl(null)}
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <span className="mb-1 block text-xs text-muted">Package Size</span>
              <div className="flex">
                <input
                  type="number"
                  step="any"
                  value={editForm.package_size}
                  onChange={(e) => setEditForm((f) => ({ ...f, package_size: e.target.value }))}
                  className="w-full rounded-l-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none transition-colors focus:border-accent"
                />
                <select
                  value={editForm.package_size_unit}
                  onChange={(e) => setEditForm((f) => ({ ...f, package_size_unit: e.target.value }))}
                  className="rounded-r-lg border border-l-0 border-border bg-surface px-2 py-2 text-sm text-text outline-none focus:border-accent"
                >
                  {PACKAGE_SIZE_UNITS.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>
            <Field label="Expected Yield %" value={editForm.expected_yield_pct} onChange={(v) => setEditForm((f) => ({ ...f, expected_yield_pct: v }))} type="number" />
            <Field label="Waste Tolerance %" value={editForm.waste_tolerance_pct} onChange={(v) => setEditForm((f) => ({ ...f, waste_tolerance_pct: v }))} type="number" />
          </div>

          {/* Ingredients section */}
          <div className="border-t border-border pt-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wider text-muted">Ingredients</p>
              <button
                type="button"
                onClick={addEditLine}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
              >
                <Plus size={14} />
                Add Ingredient
              </button>
            </div>

            <div className="space-y-3">
              {editLines.map((line, idx) => {
                const ing = ingredients.find((i) => i.id === line.ingredient_id)
                const isCp = line.provided_by === 'copacker'
                let lineCost = 0
                if (isCp) {
                  lineCost = Number(line.cp_charge) || 0
                } else if (ing && Number(line.qty || 0) > 0) {
                  let factor = 1
                  try { factor = getConversionFactorWithDensity(conversions, line.unit, ing.unit, ing.density_g_per_ml) } catch { /* fallback */ }
                  lineCost = Number(line.qty) * factor * ing.unit_cost
                }

                return (
                  <div key={line.id ?? `new-${idx}`} className={`rounded-lg border ${isCp ? 'border-amber-500/30 bg-amber-500/5' : 'border-border bg-surface/50'} p-3`}>
                    <div className="grid grid-cols-[1fr_90px_80px_80px_80px_80px_40px] items-center gap-3">
                      <select
                        value={line.ingredient_id}
                        onChange={(e) => {
                          updateEditLine(idx, 'ingredient_id', e.target.value)
                          const selected = ingredients.find((i) => i.id === e.target.value)
                          if (selected) updateEditLine(idx, 'unit', defaultRecipeUnit(selected.category, selected.unit))
                        }}
                        required
                        className="min-w-[180px] rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                      >
                        <option value="">Ingredient…</option>
                        {ingredients
                          .filter((i) => i.id === line.ingredient_id || !editLines.some((l, li) => li !== idx && l.ingredient_id === i.id))
                          .map((i) => (
                            <option key={i.id} value={i.id}>{i.name}{ingTagLabel(i.id)}</option>
                          ))}
                      </select>
                      <select
                        value={line.provided_by}
                        onChange={(e) => updateEditLine(idx, 'provided_by', e.target.value)}
                        className={`w-full rounded-lg border border-border bg-surface px-2 py-2 text-xs font-medium outline-none focus:border-accent ${isCp ? 'text-amber-400' : 'text-text'}`}
                      >
                        <option value="fitbake">You</option>
                        <option value="copacker">Co-Packer</option>
                      </select>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={line.qty}
                        onChange={(e) => updateEditLine(idx, 'qty', e.target.value)}
                        required
                        placeholder="Qty"
                        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                      />
                      <select
                        value={line.unit}
                        onChange={(e) => updateEditLine(idx, 'unit', e.target.value)}
                        className="w-full rounded-lg border border-border bg-surface px-2 py-2 text-sm text-text outline-none focus:border-accent"
                      >
                        {RECIPE_UNITS.map((u) => (
                          <option key={u} value={u}>{u}</option>
                        ))}
                      </select>
                      {isCp ? (
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={line.cp_charge}
                          onChange={(e) => updateEditLine(idx, 'cp_charge', e.target.value)}
                          placeholder="$/unit"
                          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-amber-400 outline-none focus:border-accent"
                        />
                      ) : (
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={line.tolerance}
                          onChange={(e) => updateEditLine(idx, 'tolerance', e.target.value)}
                          placeholder="± %"
                          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                        />
                      )}
                      <span className={`text-right font-mono text-xs ${isCp ? 'text-amber-400' : 'text-muted'}`}>
                        {lineCost > 0 ? fmtRate(lineCost) : '—'}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeEditLine(idx)}
                        className="flex items-center justify-center rounded-lg text-muted transition-colors hover:text-red-400"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Total Ingredient COGS */}
          <div className="flex items-center justify-between border-t border-border pt-4">
            <span className="text-sm text-muted">Total Ingredient COGS</span>
            <CostGuard><span className="font-mono text-lg font-semibold text-text">{fmt$(editCogs)}</span></CostGuard>
          </div>

          {/* Landed Costs section */}
          {editModal && (() => {
            const editRecipe = recipes.find((r) => r.id === editModal)
            if (!editRecipe) return null
            const tempRecipe = { ...editRecipe, estimated_freight_per_unit: editEstFreight ? Number(editEstFreight) : null }
            const elc = calcLandedCogs(tempRecipe)
            return (
              <CostGuard>
              <div className="space-y-2 border-t border-border pt-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted">Landed Costs</p>
                <div className="rounded-lg bg-surface/50 px-4 py-3 text-sm">
                  <div className="flex justify-between text-muted">
                    <span>Co-Packer Fee</span>
                    <span className="font-mono text-text">{fmt$(elc.cpFee)}/unit</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-muted">
                    <span>Estimated Freight</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted/70">$</span>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={editEstFreight}
                        onChange={(e) => setEditEstFreight(e.target.value)}
                        placeholder="0.00"
                        className="w-24 rounded-lg border border-border bg-surface px-2 py-1 text-right font-mono text-sm text-text outline-none focus:border-accent"
                      />
                      <span className="text-xs text-muted/70">/unit</span>
                    </div>
                  </div>
                  {elc.freightSource === 'actual' && (
                    <div className="mt-2 flex justify-between text-muted">
                      <span>
                        Actual Avg Freight
                        <span className="ml-1 text-[10px] text-muted/70">({elc.freightShipmentCount} shipments)</span>
                      </span>
                      <span className="font-mono text-text">{fmt$(elc.freightPerUnit)}/unit</span>
                    </div>
                  )}
                  {elc.freightSource === 'actual' && (elc.freightBreakdown.cpToFba > 0 || elc.freightBreakdown.cpTo3pl > 0) && (
                    <div className="ml-4 mt-0.5 text-xs text-muted/70">
                      {elc.freightBreakdown.cpToFba > 0 && <span>CP{'\u2192'}FBA: {fmt$(elc.freightBreakdown.cpToFba)} </span>}
                      {elc.freightBreakdown.cpTo3pl > 0 && <span>+ CP{'\u2192'}3PL: {fmt$(elc.freightBreakdown.cpTo3pl)}</span>}
                    </div>
                  )}
                  {elc.wasteRunCount > 0 && (
                    <div className="mt-2 flex justify-between text-muted">
                      <span>
                        Avg Waste Allocation
                        <span className="ml-1 text-[10px] text-muted/70">({elc.wasteRunCount} runs)</span>
                      </span>
                      <span className="font-mono text-text">{fmt$(elc.wastePerUnit)}/unit</span>
                    </div>
                  )}
                  <div className="mt-3 flex justify-between border-t border-border pt-2 font-semibold">
                    <span className="text-text">Landed COGS</span>
                    <span className="font-mono text-green-400">{fmt$(elc.total)}/unit</span>
                  </div>
                </div>
              </div>
              </CostGuard>
            )
          })()}

          {/* Actions */}
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setEditModal(null)}
              className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

/* ── Reusable controlled field ──────────────────────────────── */

function Field({
  label,
  value,
  onChange,
  type = 'text',
  required,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  required?: boolean
  placeholder?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        step={type === 'number' ? 'any' : undefined}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none transition-colors focus:border-accent"
      />
    </label>
  )
}
