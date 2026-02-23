import { useRef, useState, type DragEvent } from 'react'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase'
import { sanitize } from '../lib/sanitizePayload'
import { dbInsert, dbInsertSingle, dbUpdate, dbDeleteNeq } from '../lib/dbWrite'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import ConfirmDialog from '../components/ConfirmDialog'
import Modal from '../components/Modal'
import PageHeader from '../components/PageHeader'
import { Upload, X, FileText, AlertTriangle, Trash2 } from 'lucide-react'
import { loadConversions, getConversionFactorWithDensity, normalizeUnit } from '../lib/conversions'

/* ── Types ─────────────────────────────────────────────────── */

interface SectionState<T> {
  file: File | null
  parsed: T[]
  errors: string[]
  importing: boolean
  result: { success: number; errors: string[] } | null
}

function emptyState<T>(): SectionState<T> {
  return { file: null, parsed: [], errors: [], importing: false, result: null }
}

/* ── Row types ─────────────────────────────────────────────── */

interface CoPackerRow extends Record<string, unknown> {
  name: string; short_code: string; color: string; location: string
  contact_name: string; contact_email: string; contact_phone: string
  contact_role: string
  fee_per_unit: number | null; payment_terms: string; min_order_qty: number | null
  monthly_capacity: number | null; status: string; notes: string
}

interface IngredientRow extends Record<string, unknown> {
  name: string; category: string; unit: string; unit_cost: number
  reorder_point: number | null; shelf_life_days: number | null; notes: string
}

interface SupplierRow extends Record<string, unknown> {
  name: string; contact_name: string; contact_email: string; contact_phone: string
  contact_role: string; lead_time_days: number | null; payment_terms: string
  rating: number | null; notes: string; ingredients_supplied: string
}

const VALID_UNITS = new Set(['oz', 'g', 'lbs', 'kg', 'fl_oz', 'ml', 'l', 'gal', 'pcs'])


interface RecipeRow extends Record<string, unknown> {
  recipe_name: string; sku: string; co_packer_short_code: string
  package_size: number | null; package_size_unit: string
  expected_yield_pct: number | null
  waste_tolerance_pct: number | null; status: string
  ingredient_name: string; quantity_per_unit: number; unit: string; tolerance_pct: number | null
  _warning?: string
}

interface InventoryRow extends Record<string, unknown> {
  ingredient_name: string; location: string; co_packer_short_code: string
  quantity: number; lot_number: string; expiration_date: string
}

/* ── Helpers ───────────────────────────────────────────────── */

function toNum(v: string): number | null {
  if (!v || v.trim() === '') return null
  const n = Number(v)
  return isNaN(n) ? null : n
}

function str(v: string): string {
  return (v ?? '').trim()
}

interface PreviewCol<T> { label: string; key: keyof T }

/* ── Sub-components ────────────────────────────────────────── */

function FileDropZone({ onFile, currentFile, onClear }: {
  onFile: (f: File) => void
  currentFile: File | null
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file && file.name.endsWith('.csv')) onFile(file)
  }

  if (currentFile) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
        <FileText size={16} className="text-accent" />
        <span className="text-sm text-text">{currentFile.name}</span>
        <span className="text-xs text-muted">({(currentFile.size / 1024).toFixed(1)} KB)</span>
        <button onClick={onClear} className="ml-auto rounded p-1 text-muted hover:text-text">
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
        dragOver ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50'
      }`}
    >
      <Upload size={24} className="mx-auto mb-2 text-muted" />
      <p className="text-sm text-muted">Drag & drop a CSV file or click to browse</p>
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}

function PreviewTable<T extends Record<string, unknown>>({ columns, data }: {
  columns: PreviewCol<T>[]
  data: T[]
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-surface">
            {columns.map((col) => (
              <th key={String(col.key)} className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => {
            const hasWarning = '_warning' in row && !!row._warning
            return (
              <tr key={i} className={`border-b border-border last:border-0 ${hasWarning ? 'bg-amber-500/10' : ''}`}>
                {columns.map((col) => (
                  <td
                    key={String(col.key)}
                    className={`px-3 py-2 ${
                      col.key === '_warning' && row[col.key]
                        ? 'font-medium text-amber-400'
                        : 'text-muted'
                    }`}
                  >
                    {String(row[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ImportSection<T extends Record<string, unknown>>({
  number, title, description, expectedColumns, state,
  previewColumns, onFileSelect, onClear, onConfirmImport, warningCount,
}: {
  number: number; title: string; description: string; expectedColumns: string[]
  state: SectionState<T>; previewColumns: PreviewCol<T>[]
  onFileSelect: (f: File) => void; onClear: () => void; onConfirmImport: () => void
  warningCount?: number
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="mb-1 flex items-center gap-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-xs font-bold text-accent">
          {number}
        </span>
        <h2 className="text-base font-semibold text-text">{title}</h2>
      </div>
      <p className="mb-4 ml-10 text-xs text-muted">{description}</p>

      <div className="mb-4 ml-10">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Expected Columns</p>
        <p className="font-mono text-xs text-muted/70">{expectedColumns.join(', ')}</p>
      </div>

      <div className="ml-10">
        <FileDropZone onFile={onFileSelect} currentFile={state.file} onClear={onClear} />
      </div>

      {state.errors.length > 0 && (
        <div className="ml-10 mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
          <p className="mb-1 text-xs font-medium text-red-400">Parsing errors:</p>
          <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-red-300">
            {state.errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      {state.parsed.length > 0 && !state.result && (
        <div className="ml-10 mt-4">
          <p className="mb-2 text-xs text-muted">
            Preview ({Math.min(5, state.parsed.length)} of {state.parsed.length} rows)
          </p>
          <PreviewTable columns={previewColumns} data={state.parsed.slice(0, 5) as (T & Record<string, unknown>)[]} />
          {warningCount != null && warningCount > 0 && (
            <p className="mt-3 text-xs font-medium text-amber-400">
              {warningCount} row{warningCount !== 1 ? 's' : ''} will be skipped due to invalid units
            </p>
          )}
          <button
            onClick={onConfirmImport}
            disabled={state.importing}
            className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {state.importing ? 'Importing...' : `Confirm Import (${state.parsed.length - (warningCount ?? 0)} rows)`}
          </button>
        </div>
      )}

      {state.result && (
        <div className="ml-10 mt-4 space-y-2">
          {state.result.success > 0 && (
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3">
              <p className="text-xs font-medium text-green-400">
                Imported {state.result.success} records
              </p>
            </div>
          )}
          {state.result.errors.length > 0 && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
              <p className="mb-1 text-xs font-medium text-red-400">
                {state.result.errors.length} error{state.result.errors.length !== 1 ? 's' : ''}:
              </p>
              <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs text-red-300">
                {state.result.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Main page ─────────────────────────────────────────────── */

export default function ImportData() {
  const { can } = useAuth()
  const toast = useToast()

  /* Section states */
  const [cpState, setCpState] = useState<SectionState<CoPackerRow>>(emptyState)
  const [ingState, setIngState] = useState<SectionState<IngredientRow>>(emptyState)
  const [supState, setSupState] = useState<SectionState<SupplierRow>>(emptyState)
  const [recState, setRecState] = useState<SectionState<RecipeRow>>(emptyState)
  const [invState, setInvState] = useState<SectionState<InventoryRow>>(emptyState)

  /* Clear all state */
  const [clearStep, setClearStep] = useState<'idle' | 'confirm1' | 'confirm2'>('idle')
  const [clearInput, setClearInput] = useState('')
  const [clearing, setClearing] = useState(false)

  /* ── CSV parsers ─────────────────────────────────────────── */

  function parseFile<T>(
    file: File,
    requiredCols: string[],
    transform: (raw: Record<string, string>, idx: number) => { data?: T; error?: string },
    setState: React.Dispatch<React.SetStateAction<SectionState<T>>>,
  ) {
    setState((s) => ({ ...s, file, parsed: [], errors: [], result: null }))
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete(results) {
        const headers = results.meta.fields ?? []
        const missing = requiredCols.filter((c) => !headers.includes(c))
        if (missing.length > 0) {
          setState((s) => ({ ...s, errors: [`Missing required columns: ${missing.join(', ')}`] }))
          return
        }
        const parsed: T[] = []
        const errors: string[] = []
        results.data.forEach((raw, i) => {
          const r = transform(raw, i)
          if (r.error) errors.push(r.error)
          else if (r.data) parsed.push(r.data)
        })
        setState((s) => ({ ...s, parsed, errors }))
      },
    })
  }

  /* Co-Packers */
  function parseCoPacker(file: File) {
    parseFile<CoPackerRow>(file, ['name', 'short_code'], (raw, i) => {
      if (!str(raw.name) || !str(raw.short_code))
        return { error: `Row ${i + 1}: name and short_code are required` }
      return {
        data: {
          name: str(raw.name), short_code: str(raw.short_code),
          color: str(raw.color), location: str(raw.location),
          contact_name: str(raw.contact_name), contact_email: str(raw.contact_email),
          contact_phone: str(raw.contact_phone),
          contact_role: str(raw.contact_role) || 'Production Manager',
          fee_per_unit: toNum(raw.fee_per_unit),
          payment_terms: str(raw.payment_terms), min_order_qty: toNum(raw.min_order_qty),
          monthly_capacity: toNum(raw.monthly_capacity),
          status: str(raw.status) || 'active', notes: str(raw.notes),
        },
      }
    }, setCpState)
  }

  /* Ingredients */
  function parseIngredient(file: File) {
    parseFile<IngredientRow>(file, ['name', 'unit_cost'], (raw, i) => {
      const uc = toNum(raw.unit_cost)
      if (!str(raw.name)) return { error: `Row ${i + 1}: name is required` }
      if (uc == null) return { error: `Row ${i + 1}: unit_cost must be a valid number` }
      const rawUnit = str(raw.unit)
      const unit = rawUnit ? normalizeUnit(rawUnit) : 'lbs'
      return {
        data: {
          name: str(raw.name), category: str(raw.category),
          unit, unit_cost: uc,
          reorder_point: toNum(raw.reorder_point),
          shelf_life_days: toNum(raw.shelf_life_days), notes: str(raw.notes),
        },
      }
    }, setIngState)
  }

  /* Suppliers */
  function parseSupplier(file: File) {
    parseFile<SupplierRow>(file, ['name'], (raw, i) => {
      if (!str(raw.name)) return { error: `Row ${i + 1}: name is required` }
      return {
        data: {
          name: str(raw.name), contact_name: str(raw.contact_name),
          contact_email: str(raw.contact_email), contact_phone: str(raw.contact_phone),
          contact_role: str(raw.contact_role) || 'Sales Rep',
          lead_time_days: toNum(raw.lead_time_days), payment_terms: str(raw.payment_terms),
          rating: toNum(raw.rating), notes: str(raw.notes),
          ingredients_supplied: str(raw.ingredients_supplied),
        },
      }
    }, setSupState)
  }

  /* Recipes / BOM */
  function parseRecipe(file: File) {
    parseFile<RecipeRow>(file, ['recipe_name', 'sku', 'ingredient_name', 'quantity_per_unit'], (raw, i) => {
      if (!str(raw.recipe_name) || !str(raw.sku))
        return { error: `Row ${i + 1}: recipe_name and sku are required` }
      if (!str(raw.ingredient_name))
        return { error: `Row ${i + 1}: ingredient_name is required` }
      const qty = toNum(raw.quantity_per_unit)
      if (qty == null) return { error: `Row ${i + 1}: quantity_per_unit must be a valid number` }
      const rawUnit = str(raw.unit)
      const unit = rawUnit ? normalizeUnit(rawUnit) : ''
      const warning = unit && !VALID_UNITS.has(unit.toLowerCase())
        ? `Unrecognized unit "${rawUnit}"`
        : undefined
      return {
        data: {
          recipe_name: str(raw.recipe_name), sku: str(raw.sku),
          co_packer_short_code: str(raw.co_packer_short_code),
          package_size: toNum(raw.package_size) ?? toNum(raw.package_size_oz),
          package_size_unit: str(raw.package_size_unit) || 'oz',
          expected_yield_pct: toNum(raw.expected_yield_pct),
          waste_tolerance_pct: toNum(raw.waste_tolerance_pct),
          status: str(raw.status) || 'active',
          ingredient_name: str(raw.ingredient_name),
          quantity_per_unit: qty,
          unit,
          tolerance_pct: toNum(raw.tolerance_pct),
          _warning: warning,
        },
      }
    }, setRecState)
  }

  /* Inventory */
  function parseInventory(file: File) {
    parseFile<InventoryRow>(file, ['ingredient_name', 'location', 'quantity'], (raw, i) => {
      if (!str(raw.ingredient_name)) return { error: `Row ${i + 1}: ingredient_name is required` }
      const loc = str(raw.location).toLowerCase()
      if (loc !== 'copacker')
        return { error: `Row ${i + 1}: location must be 'copacker'` }
      const qty = toNum(raw.quantity)
      if (qty == null) return { error: `Row ${i + 1}: quantity must be a valid number` }
      return {
        data: {
          ingredient_name: str(raw.ingredient_name), location: loc,
          co_packer_short_code: str(raw.co_packer_short_code),
          quantity: qty, lot_number: str(raw.lot_number),
          expiration_date: str(raw.expiration_date),
        },
      }
    }, setInvState)
  }

  /* ── Import handlers ─────────────────────────────────────── */

  async function importCoPackers() {
    setCpState((s) => ({ ...s, importing: true }))
    let success = 0
    const errors: string[] = []
    for (let i = 0; i < cpState.parsed.length; i++) {
      const r = cpState.parsed[i]
      const { data: cp, error } = await dbInsertSingle('co_packers',
        sanitize('co_packers', {
          name: r.name, short_code: r.short_code, color: r.color || null,
          location: r.location || null,
          fee_per_unit: r.fee_per_unit, payment_terms: r.payment_terms || null,
          min_order_qty: r.min_order_qty, monthly_capacity: r.monthly_capacity,
          status: r.status, notes: r.notes || null,
        }),
      )
      if (error || !cp) {
        errors.push(`Row ${i + 1} (${r.name}): ${error?.message ?? 'insert failed'}`)
        continue
      }
      success++

      // Create primary contact if name provided
      if (r.contact_name) {
        await dbInsert('co_packer_contacts',
          sanitize('co_packer_contacts', {
            co_packer_id: cp.id,
            name: r.contact_name,
            email: r.contact_email || null,
            phone: r.contact_phone || null,
            role: r.contact_role || 'Production Manager',
            is_primary: true,
          }),
        )
      }
    }
    setCpState((s) => ({ ...s, importing: false, result: { success, errors } }))
    if (success > 0) toast.success(`Imported ${success} co-packers`)
    if (errors.length > 0) toast.error(`${errors.length} co-packer rows failed`)
  }

  async function importIngredients() {
    setIngState((s) => ({ ...s, importing: true }))
    let success = 0
    const errors: string[] = []
    for (let i = 0; i < ingState.parsed.length; i++) {
      const r = ingState.parsed[i]
      const { error } = await dbInsert('ingredients',
        sanitize('ingredients', {
          name: r.name, category: r.category || null, unit: r.unit,
          unit_cost: r.unit_cost, reorder_point: r.reorder_point,
          shelf_life_days: r.shelf_life_days, notes: r.notes || null,
        }),
      )
      if (error) errors.push(`Row ${i + 1} (${r.name}): ${error.message}`)
      else success++
    }
    setIngState((s) => ({ ...s, importing: false, result: { success, errors } }))
    if (success > 0) toast.success(`Imported ${success} ingredients`)
    if (errors.length > 0) toast.error(`${errors.length} ingredient rows failed`)
  }

  async function importSuppliers() {
    setSupState((s) => ({ ...s, importing: true }))
    const { data: allIng } = await supabase.from('ingredients').select('id, name')
    const ingMap = new Map((allIng ?? []).map((i) => [i.name.trim().toLowerCase(), i.id]))

    let success = 0
    const errors: string[] = []
    for (let i = 0; i < supState.parsed.length; i++) {
      const r = supState.parsed[i]
      const { data: sup, error } = await dbInsertSingle('suppliers',
        sanitize('suppliers', {
          name: r.name, lead_time_days: r.lead_time_days,
          payment_terms: r.payment_terms || null,
          rating: r.rating, notes: r.notes || null,
        }),
      )
      if (error || !sup) {
        errors.push(`Row ${i + 1} (${r.name}): ${error?.message ?? 'insert failed'}`)
        continue
      }
      success++

      // Create primary contact if name provided
      if (r.contact_name) {
        await dbInsert('supplier_contacts',
          sanitize('supplier_contacts', {
            supplier_id: sup.id,
            name: r.contact_name,
            email: r.contact_email || null,
            phone: r.contact_phone || null,
            role: r.contact_role || 'Sales Rep',
            is_primary: true,
          }),
        )
      }

      // Link ingredients
      if (r.ingredients_supplied) {
        const names = r.ingredients_supplied.split(',').map((s) => s.trim()).filter(Boolean)
        for (const name of names) {
          const ingId = ingMap.get(name.toLowerCase())
          if (!ingId) {
            errors.push(`Row ${i + 1} (${r.name}): ingredient "${name}" not found, skipped`)
            continue
          }
          await dbInsert('supplier_ingredients', sanitize('supplier_ingredients', {
            supplier_id: sup.id,
            ingredient_id: ingId,
          }))
        }
      }
    }
    setSupState((s) => ({ ...s, importing: false, result: { success, errors } }))
    if (success > 0) toast.success(`Imported ${success} suppliers`)
    if (errors.length > 0) toast.error(`${errors.length} supplier issues`)
  }

  async function importRecipes() {
    setRecState((s) => ({ ...s, importing: true }))

    // Fetch lookups
    const { data: allCp } = await supabase.from('co_packers').select('id, short_code')
    const cpMap = new Map((allCp ?? []).map((c) => [c.short_code.trim().toLowerCase(), c.id]))
    const { data: allIng } = await supabase.from('ingredients').select('id, name, unit_cost, unit, density_g_per_ml')
    const ingMap = new Map((allIng ?? []).map((i) => [i.name.trim().toLowerCase(), { id: i.id, unit_cost: Number(i.unit_cost), unit: i.unit, density_g_per_ml: i.density_g_per_ml }]))
    const convMap = await loadConversions()

    // Filter out rows with warnings (invalid units)
    const validRows = recState.parsed.filter((r) => !r._warning)

    // Group rows by recipe
    const groups = new Map<string, RecipeRow[]>()
    for (const row of validRows) {
      const key = `${row.recipe_name}::${row.sku}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }

    let success = 0
    const errors: string[] = []

    for (const [key, rows] of groups) {
      const first = rows[0]
      const cpId = first.co_packer_short_code ? cpMap.get(first.co_packer_short_code.toLowerCase()) : null
      if (first.co_packer_short_code && !cpId) {
        errors.push(`Recipe "${first.recipe_name}": co-packer "${first.co_packer_short_code}" not found`)
        continue
      }

      const { data: recipe, error } = await dbInsertSingle('recipes',
        sanitize('recipes', {
          name: first.recipe_name, sku: first.sku, co_packer_id: cpId ?? null,
          package_size: first.package_size, package_size_unit: first.package_size_unit,
          expected_yield_pct: first.expected_yield_pct ?? 96.5,
          waste_tolerance_pct: first.waste_tolerance_pct ?? 2.5, status: first.status,
        }),
      )
      if (error || !recipe) {
        errors.push(`Recipe "${key}": ${error?.message ?? 'insert failed'}`)
        continue
      }

      let cogs = 0
      let allIngsOk = true
      for (const row of rows) {
        const ing = ingMap.get(row.ingredient_name.toLowerCase())
        if (!ing) {
          errors.push(`Recipe "${first.recipe_name}" → ingredient "${row.ingredient_name}" not found`)
          allIngsOk = false
          continue
        }
        // Resolve unit: use CSV value if provided, otherwise ingredient's inventory unit
        const resolvedUnit = row.unit || ing.unit
        const { error: riErr } = await dbInsert('recipe_ingredients',
          sanitize('recipe_ingredients', {
            recipe_id: recipe.id,
            ingredient_id: ing.id,
            quantity_per_unit: row.quantity_per_unit,
            unit: resolvedUnit,
            tolerance_pct: row.tolerance_pct ?? 2,
          }),
        )
        if (riErr) {
          errors.push(`Recipe "${first.recipe_name}" → "${row.ingredient_name}": ${riErr.message}`)
        } else {
          let factor = 1
          try { factor = getConversionFactorWithDensity(convMap, resolvedUnit, ing.unit, ing.density_g_per_ml) } catch { /* fallback */ }
          cogs += row.quantity_per_unit * factor * ing.unit_cost
        }
      }

      // Update COGS
      await dbUpdate('recipes',
        sanitize('recipes', {
          ingredient_cogs: Math.round(cogs * 100) / 100,
        }),
        'id', recipe.id,
      )

      if (allIngsOk) success++
      else success++ // recipe was still created, just some ingredients failed
    }

    setRecState((s) => ({ ...s, importing: false, result: { success, errors } }))
    if (success > 0) toast.success(`Imported ${success} recipes`)
    if (errors.length > 0) toast.error(`${errors.length} recipe issues`)
  }

  async function importInventory() {
    setInvState((s) => ({ ...s, importing: true }))

    const { data: allIng } = await supabase.from('ingredients').select('id, name')
    const ingMap = new Map((allIng ?? []).map((i) => [i.name.trim().toLowerCase(), i.id]))
    const { data: allCp } = await supabase.from('co_packers').select('id, short_code')
    const cpMap = new Map((allCp ?? []).map((c) => [c.short_code.trim().toLowerCase(), c.id]))

    let success = 0
    const errors: string[] = []
    for (let i = 0; i < invState.parsed.length; i++) {
      const r = invState.parsed[i]
      const ingId = ingMap.get(r.ingredient_name.toLowerCase())
      if (!ingId) {
        errors.push(`Row ${i + 1}: ingredient "${r.ingredient_name}" not found`)
        continue
      }
      let cpId: string | null = null
      if (r.location === 'copacker') {
        cpId = cpMap.get(r.co_packer_short_code.toLowerCase()) ?? null
        if (!cpId) {
          errors.push(`Row ${i + 1}: co-packer "${r.co_packer_short_code}" not found`)
          continue
        }
      }
      const { error } = await dbInsert('ingredient_inventory',
        sanitize('ingredient_inventory', {
          ingredient_id: ingId, location_type: r.location,
          co_packer_id: cpId, quantity: r.quantity,
          lot_number: r.lot_number || null,
          expiration_date: r.expiration_date || null,
        }),
      )
      if (error) errors.push(`Row ${i + 1} (${r.ingredient_name}): ${error.message}`)
      else success++
    }
    setInvState((s) => ({ ...s, importing: false, result: { success, errors } }))
    if (success > 0) toast.success(`Imported ${success} inventory records`)
    if (errors.length > 0) toast.error(`${errors.length} inventory rows failed`)
  }

  /* ── Clear All Data ──────────────────────────────────────── */

  async function handleClearAll() {
    setClearing(true)
    const tables = [
      'ingredient_cost_history',
      'co_packer_contacts',
      'reconciliation_lines', 'finished_goods_movements', 'production_runs',
      'recipe_ingredients', 'recipes', 'shipment_items', 'shipments_to_copacker',
      'purchase_order_items', 'purchase_orders', 'supplier_contacts', 'supplier_ingredients', 'suppliers',
      'packaging_inventory', 'packaging_materials', 'ingredient_inventory',
      'ingredients', 'co_packers',
    ]
    for (const table of tables) {
      const { error } = await dbDeleteNeq(table, 'id', '')
      if (error) {
        toast.error(`Failed to clear ${table}: ${error.message}`)
        setClearing(false)
        setClearStep('idle')
        setClearInput('')
        return
      }
    }
    toast.success('All data cleared successfully')
    setClearing(false)
    setClearStep('idle')
    setClearInput('')
    // Reset all section states
    setCpState(emptyState())
    setIngState(emptyState())
    setSupState(emptyState())
    setRecState(emptyState())
    setInvState(emptyState())
  }

  /* ── Preview column definitions ──────────────────────────── */

  const cpCols: PreviewCol<CoPackerRow>[] = [
    { label: 'Name', key: 'name' }, { label: 'Code', key: 'short_code' },
    { label: 'Location', key: 'location' }, { label: 'Fee/Unit', key: 'fee_per_unit' },
    { label: 'Status', key: 'status' },
  ]
  const ingCols: PreviewCol<IngredientRow>[] = [
    { label: 'Name', key: 'name' }, { label: 'Category', key: 'category' },
    { label: 'Unit', key: 'unit' }, { label: 'Unit Cost', key: 'unit_cost' },
    { label: 'Reorder Pt', key: 'reorder_point' },
  ]
  const supCols: PreviewCol<SupplierRow>[] = [
    { label: 'Name', key: 'name' }, { label: 'Contact', key: 'contact_name' },
    { label: 'Lead Time', key: 'lead_time_days' }, { label: 'Rating', key: 'rating' },
    { label: 'Ingredients', key: 'ingredients_supplied' },
  ]
  const hasRecipeWarnings = recState.parsed.some((r) => r._warning)
  const recCols: PreviewCol<RecipeRow>[] = [
    { label: 'Recipe', key: 'recipe_name' }, { label: 'SKU', key: 'sku' },
    { label: 'CP', key: 'co_packer_short_code' }, { label: 'Ingredient', key: 'ingredient_name' },
    { label: 'Qty', key: 'quantity_per_unit' }, { label: 'Unit', key: 'unit' },
    ...(hasRecipeWarnings ? [{ label: 'Warning', key: '_warning' as keyof RecipeRow }] : []),
  ]
  const invCols: PreviewCol<InventoryRow>[] = [
    { label: 'Ingredient', key: 'ingredient_name' }, { label: 'Location', key: 'location' },
    { label: 'CP', key: 'co_packer_short_code' }, { label: 'Quantity', key: 'quantity' },
    { label: 'Lot #', key: 'lot_number' },
  ]

  /* ── Render ──────────────────────────────────────────────── */

  if (!can('import_data')) return <Navigate to="/" replace />

  return (
    <div>
      <PageHeader title="Import Data" subtitle="Bulk import from CSV files" />

      {/* Danger Zone */}
      <div className="mb-8 rounded-xl border border-red-500/30 bg-red-500/10 p-5">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 text-red-400" />
            <div>
              <h3 className="text-sm font-semibold text-red-400">Danger Zone</h3>
              <p className="mt-1 text-xs text-muted">
                Permanently delete ALL data from every table. This cannot be undone.
              </p>
            </div>
          </div>
          <button
            onClick={() => setClearStep('confirm1')}
            className="flex items-center gap-1.5 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600"
          >
            <Trash2 size={14} />
            Clear All Data
          </button>
        </div>
      </div>

      {/* Import order hint */}
      <p className="mb-6 text-xs text-muted">
        Import in order: Co-Packers → Ingredients → Suppliers → Recipes → Inventory.
        Each section depends on the ones above it for name lookups.
      </p>

      {/* Upload sections */}
      <div className="space-y-6">
        <ImportSection
          number={1} title="Co-Packers" description="Upload co_packers.csv"
          expectedColumns={['name', 'short_code', 'color', 'location', 'contact_name', 'contact_email', 'contact_phone', 'contact_role', 'fee_per_unit', 'payment_terms', 'min_order_qty', 'monthly_capacity', 'status', 'notes']}
          state={cpState} previewColumns={cpCols}
          onFileSelect={parseCoPacker}
          onClear={() => setCpState(emptyState())}
          onConfirmImport={importCoPackers}
        />

        <ImportSection
          number={2} title="Ingredients" description="Upload ingredients.csv"
          expectedColumns={['name', 'category', 'unit', 'unit_cost', 'reorder_point', 'shelf_life_days', 'notes']}
          state={ingState} previewColumns={ingCols}
          onFileSelect={parseIngredient}
          onClear={() => setIngState(emptyState())}
          onConfirmImport={importIngredients}
        />

        <ImportSection
          number={3} title="Suppliers" description="Upload suppliers.csv — ingredients_supplied column links to Ingredients by name"
          expectedColumns={['name', 'contact_name', 'contact_email', 'contact_phone', 'contact_role', 'lead_time_days', 'payment_terms', 'rating', 'notes', 'ingredients_supplied']}
          state={supState} previewColumns={supCols}
          onFileSelect={parseSupplier}
          onClear={() => setSupState(emptyState())}
          onConfirmImport={importSuppliers}
        />

        <ImportSection
          number={4} title="Recipes / BOM" description="Upload recipes_bom.csv — multiple rows per recipe (one per ingredient). Looks up co-packers by short_code and ingredients by name."
          expectedColumns={['recipe_name', 'sku', 'co_packer_short_code', 'package_size', 'package_size_unit', 'expected_yield_pct', 'waste_tolerance_pct', 'status', 'ingredient_name', 'quantity_per_unit', 'unit', 'tolerance_pct']}
          state={recState} previewColumns={recCols}
          onFileSelect={parseRecipe}
          onClear={() => setRecState(emptyState())}
          onConfirmImport={importRecipes}
          warningCount={recState.parsed.filter((r) => r._warning).length}
        />

        <ImportSection
          number={5} title="Inventory" description="Upload inventory.csv — looks up ingredients by name and co-packers by short_code"
          expectedColumns={['ingredient_name', 'location', 'co_packer_short_code', 'quantity', 'lot_number', 'expiration_date']}
          state={invState} previewColumns={invCols}
          onFileSelect={parseInventory}
          onClear={() => setInvState(emptyState())}
          onConfirmImport={importInventory}
        />
      </div>

      {/* Clear All — Step 1: ConfirmDialog */}
      <ConfirmDialog
        isOpen={clearStep === 'confirm1'}
        title="Clear All Data"
        message="This will permanently delete ALL data from every table (co-packers, ingredients, suppliers, recipes, production runs, shipments, finished goods, and more). This cannot be undone."
        confirmLabel="Yes, proceed"
        danger
        onConfirm={() => setClearStep('confirm2')}
        onCancel={() => setClearStep('idle')}
      />

      {/* Clear All — Step 2: Type DELETE */}
      <Modal
        isOpen={clearStep === 'confirm2'}
        onClose={() => { setClearStep('idle'); setClearInput('') }}
        title="Final Confirmation"
      >
        <p className="mb-4 text-sm text-muted">
          Type <span className="font-mono font-bold text-red-400">DELETE</span> to confirm permanent deletion of all data.
        </p>
        <input
          value={clearInput}
          onChange={(e) => setClearInput(e.target.value)}
          placeholder="Type DELETE"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none transition-colors focus:border-accent"
          autoFocus
        />
        <div className="mt-4 flex justify-end gap-3">
          <button
            onClick={() => { setClearStep('idle'); setClearInput('') }}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:text-text"
          >
            Cancel
          </button>
          <button
            disabled={clearInput !== 'DELETE' || clearing}
            onClick={handleClearAll}
            className="rounded-lg bg-red-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
          >
            {clearing ? 'Deleting...' : 'Delete Everything'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
