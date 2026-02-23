import { supabase } from './supabase'
import { safeQuery } from './safeQuery'

export type ConversionMap = Map<string, number>

let cache: ConversionMap | null = null

/** Normalize common unit aliases to canonical form used in the conversions table. */
const UNIT_ALIASES: Record<string, string> = {
  pounds: 'lbs', pound: 'lbs', lb: 'lbs',
  ounces: 'oz', ounce: 'oz',
  grams: 'g', gram: 'g',
  kilograms: 'kg', kilogram: 'kg',
  liters: 'l', liter: 'l', litres: 'l', litre: 'l',
  milliliters: 'ml', milliliter: 'ml', millilitres: 'ml', millilitre: 'ml',
  pieces: 'pcs', piece: 'pcs', pc: 'pcs', each: 'pcs',
  gallon: 'gal', gallons: 'gal',
  'fluid ounces': 'fl_oz', 'fluid ounce': 'fl_oz', 'fl oz': 'fl_oz', floz: 'fl_oz',
}

/* ── Unit type groups ────────────────────────────────────── */

const WEIGHT_UNITS = new Set(['oz', 'lbs', 'g', 'kg'])
const VOLUME_UNITS = new Set(['fl_oz', 'ml', 'l', 'gal'])
const DISCRETE_UNITS = new Set(['pcs'])

/** Return the measurement group for a unit ('weight', 'volume', 'discrete', or 'unknown'). */
export function unitGroup(unit: string): 'weight' | 'volume' | 'discrete' | 'unknown' {
  const n = normalizeUnit(unit)
  if (WEIGHT_UNITS.has(n)) return 'weight'
  if (VOLUME_UNITS.has(n)) return 'volume'
  if (DISCRETE_UNITS.has(n)) return 'discrete'
  return 'unknown'
}

export function normalizeUnit(unit: string): string {
  const lower = unit.toLowerCase().trim()
  return UNIT_ALIASES[lower] ?? unit
}

/** Load unit conversions from the database (cached after first call). */
export async function loadConversions(): Promise<ConversionMap> {
  if (cache) return cache
  const { data } = await safeQuery(() => supabase.from('unit_conversions').select('*'))
  cache = new Map(
    ((data ?? []) as any[]).map((r) => [`${r.from_unit}→${r.to_unit}`, Number(r.multiplier)]),
  )
  return cache
}

/** Look up the multiplier to convert `from` → `to`. Returns 1 for same-unit. Throws if unknown. */
export function getConversionFactor(
  conversions: ConversionMap,
  from: string,
  to: string,
): number {
  const nFrom = normalizeUnit(from)
  const nTo = normalizeUnit(to)
  if (nFrom === nTo) return 1
  // Prevent cross-type conversions (e.g. weight → volume)
  const fromGroup = unitGroup(nFrom)
  const toGroup = unitGroup(nTo)
  if (fromGroup !== 'unknown' && toGroup !== 'unknown' && fromGroup !== toGroup) {
    throw new Error(
      `Cannot convert ${from} (${fromGroup}) to ${to} (${toGroup}) — mixing unit types`,
    )
  }
  const key = `${nFrom}→${nTo}`
  const factor = conversions.get(key)
  if (factor == null) {
    throw new Error(`No conversion from "${from}" to "${to}"`)
  }
  return factor
}

/** Convert a value from one unit to another. */
export function convertUnit(
  conversions: ConversionMap,
  value: number,
  from: string,
  to: string,
): number {
  return value * getConversionFactor(conversions, from, to)
}

/**
 * Get conversion factor with optional density bridge for weight↔volume.
 * Chain: weight → g → ml (÷ density) → target volume unit
 *    or: volume → ml → g (* density) → target weight unit
 * Falls back to standard same-type conversion when density isn't needed.
 */
export function getConversionFactorWithDensity(
  conversions: ConversionMap,
  from: string,
  to: string,
  densityGPerMl: number | null | undefined,
): number {
  const nFrom = normalizeUnit(from)
  const nTo = normalizeUnit(to)
  if (nFrom === nTo) return 1

  const fromGroup = unitGroup(nFrom)
  const toGroup = unitGroup(nTo)

  // Same type or unknown — use standard conversion
  if (fromGroup === toGroup || fromGroup === 'unknown' || toGroup === 'unknown') {
    return getConversionFactor(conversions, from, to)
  }

  // Cross-type — need density
  if (!densityGPerMl || densityGPerMl <= 0) {
    throw new Error(
      `Cannot convert ${from} (${fromGroup}) to ${to} (${toGroup}) — set density to enable this`,
    )
  }

  // Weight → Volume: from → g → ml (÷ density) → to
  if (fromGroup === 'weight' && toGroup === 'volume') {
    const toGrams = nFrom === 'g' ? 1 : getConversionFactor(conversions, nFrom, 'g')
    const mlPerGram = 1 / densityGPerMl
    const fromMl = nTo === 'ml' ? 1 : getConversionFactor(conversions, 'ml', nTo)
    return toGrams * mlPerGram * fromMl
  }

  // Volume → Weight: from → ml → g (* density) → to
  if (fromGroup === 'volume' && toGroup === 'weight') {
    const toMl = nFrom === 'ml' ? 1 : getConversionFactor(conversions, nFrom, 'ml')
    const gramsPerMl = densityGPerMl
    const fromG = nTo === 'g' ? 1 : getConversionFactor(conversions, 'g', nTo)
    return toMl * gramsPerMl * fromG
  }

  throw new Error(`Cannot convert ${from} to ${to}`)
}

/** Format a quantity with its unit label (e.g. "7.2 oz", "1,125 lbs"). */
export function formatQuantityWithUnit(value: number, unit: string): string {
  const formatted = value % 1 === 0
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })
  return `${formatted} ${unit}`
}

/* ── Dual-unit bulk display ────────────────────────────────── */

/** Format a single qty+unit with precision rules: 1 decimal for lbs/kg, whole numbers for g/oz when >= 100. */
export function formatBulkQty(value: number, unit: string): string {
  if (value === 0) return `0 ${unit}`
  const n = normalizeUnit(unit)
  if ((n === 'g' || n === 'oz') && Math.abs(value) >= 100) {
    return `${Math.round(value).toLocaleString()} ${n}`
  }
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${n}`
}

/** Determine the secondary display unit for weight/volume ingredients. */
function secondaryWeightUnit(unit: string): string | null {
  const n = normalizeUnit(unit)
  if (n === 'lbs' || n === 'oz') return 'kg'
  if (n === 'kg' || n === 'g') return 'lbs'
  if (n === 'gal' || n === 'fl_oz') return 'l'
  if (n === 'l' || n === 'ml') return 'gal'
  return null
}

/**
 * Build dual-unit strings for bulk quantity display.
 * Returns { primary, secondary } where secondary is null for non-weight units.
 * Callers render: primary + (secondary) with muted styling.
 */
export function dualUnitParts(
  conversions: ConversionMap,
  value: number,
  unit: string,
): { primary: string; secondary: string | null } {
  const nUnit = normalizeUnit(unit)
  const primary = formatBulkQty(value, nUnit)
  const secUnit = secondaryWeightUnit(nUnit)
  if (!secUnit) return { primary, secondary: null }
  try {
    const converted = convertUnit(conversions, value, nUnit, secUnit)
    return { primary, secondary: formatBulkQty(converted, secUnit) }
  } catch {
    return { primary, secondary: null }
  }
}

/** Supported recipe units for the unit dropdown. */
export const RECIPE_UNITS = ['oz', 'g', 'lbs', 'kg', 'fl_oz', 'ml', 'l', 'gal', 'pcs'] as const

/** Package-size unit options (subset of RECIPE_UNITS without l/pcs). */
export const PACKAGE_SIZE_UNITS = ['oz', 'g', 'lbs', 'kg', 'fl_oz', 'ml', 'gal'] as const

/** Pick a sensible recipe unit based on ingredient category and inventory unit. */
export function defaultRecipeUnit(category: string | null, inventoryUnit: string): string {
  // Metric weight → grams
  if (inventoryUnit === 'g' || inventoryUnit === 'kg') return 'g'
  // Pieces stay as pieces
  if (inventoryUnit === 'pcs') return 'pcs'
  // Fluid ounces stay as fl_oz
  if (inventoryUnit === 'fl_oz') return 'fl_oz'
  // Metric volume → ml
  if (inventoryUnit === 'ml' || inventoryUnit === 'l') return 'ml'
  // Imperial (lbs / oz) — use category to decide
  const cat = (category ?? '').toLowerCase()
  if (['dairy', 'stabilizer', 'seasoning'].includes(cat)) return 'g'
  if (cat === 'packaging') return 'pcs'
  // flour/base, sweetener, protein, flavoring, leavening, other → oz
  return 'oz'
}
