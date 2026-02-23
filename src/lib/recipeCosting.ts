import type { RecipeIngredient, Ingredient } from '../types/database'
import { type ConversionMap, getConversionFactorWithDensity } from './conversions'

/* ── Types ──────────────────────────────────────────────────── */

export interface RecipeCOGSBreakdown {
  fitbakeCost: number
  cpCharge: number
  total: number
}

/* ── Core calculation ────────────────────────────────────────── */

/**
 * Calculate ingredient COGS per unit for a recipe.
 *
 * FitBake-provided ingredients: qty × conversion × ingredient.unit_cost
 * Co-packer-provided ingredients: cp_charge_per_unit (flat per-unit fee)
 *
 * This is the single source of truth — used by Recipes, ProductionRuns,
 * and ProductionPlanner pages.
 */
export function calculateRecipeCOGS(
  recipeId: string,
  recipeIngredients: RecipeIngredient[],
  ingredients: Ingredient[],
  conversions: ConversionMap,
): number {
  return calculateRecipeCOGSBreakdown(recipeId, recipeIngredients, ingredients, conversions).total
}

export function calculateRecipeCOGSBreakdown(
  recipeId: string,
  recipeIngredients: RecipeIngredient[],
  ingredients: Ingredient[],
  conversions: ConversionMap,
): RecipeCOGSBreakdown {
  const ris = recipeIngredients.filter((ri) => ri.recipe_id === recipeId)
  let fitbakeCost = 0
  let cpCharge = 0
  for (const ri of ris) {
    if (ri.provided_by === 'copacker') {
      cpCharge += ri.cp_charge_per_unit ?? 0
      continue
    }
    if (!ri.ingredient_id) continue
    const ing = ingredients.find((i) => i.id === ri.ingredient_id)
    if (!ing) continue
    const invUnit = ing.unit ?? 'lbs'
    let factor = 1
    try {
      factor = getConversionFactorWithDensity(conversions, ri.unit, invUnit, ing.density_g_per_ml)
    } catch { /* fallback to 1 */ }
    fitbakeCost += ri.quantity_per_unit * factor * ing.unit_cost
  }
  return { fitbakeCost, cpCharge, total: fitbakeCost + cpCharge }
}
