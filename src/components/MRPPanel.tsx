import { Check, AlertTriangle, ShoppingCart } from 'lucide-react'
import Badge from './Badge'
import { dualUnitParts, type ConversionMap } from '../lib/conversions'
import type { MRPRow, MRPSummary } from '../lib/mrp'

interface MRPPanelProps {
  rows: MRPRow[]
  summary: MRPSummary
  cpName: string
  conversions: ConversionMap
  onCreatePOs?: () => void
  compact?: boolean
}

const ROW_BG: Record<MRPRow['status'], string> = {
  ready: 'rgba(34,197,94,0.12)',
  order: 'rgba(239,68,68,0.12)',
  cp_provided: 'rgba(245,158,11,0.08)',
}

function fmtV(v: number): string {
  if (v === 0) return '0'
  return v % 1 === 0
    ? v.toLocaleString()
    : v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

function fmtU(v: number, unit: string): string {
  return `${fmtV(v)} ${unit}`
}

export default function MRPPanel({
  rows,
  summary,
  cpName,
  conversions,
  onCreatePOs,
  compact,
}: MRPPanelProps) {
  const cpCount = rows.filter((r) => r.status === 'cp_provided').length

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted">No ingredient requirements to display.</p>
    )
  }

  return (
    <div>
      <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">
        Material Requirements at{' '}
        <span className="text-text">{cpName}</span>
      </p>

      <p className="mb-1 text-[10px] text-muted italic">
        All quantities in each ingredient's inventory unit unless noted
      </p>

      {/* Scrollable table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border bg-surface/50 text-muted">
              <th className="px-3 py-2 font-medium">Ingredient</th>
              <th className="px-3 py-2 font-medium text-center" style={{ width: 70 }}>Source</th>
              <th className="px-3 py-2 font-medium text-right">Total Need</th>
              <th className="px-3 py-2 font-medium text-right">At CP</th>
              <th className="px-3 py-2 font-medium text-right">In Transit</th>
              <th className="px-3 py-2 font-medium text-right">Total Avail</th>
              <th className="px-3 py-2 font-medium text-right">Shortfall</th>
              <th className="px-3 py-2 font-medium text-right">To Order</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isCp = row.status === 'cp_provided'
              const showDualNeed = row.recipeUnit !== row.unit
              const orderDual = row.needToOrder > 0
                ? dualUnitParts(conversions, row.needToOrder, row.unit)
                : null

              return (
                <tr
                  key={row.ingredientId}
                  style={{ backgroundColor: ROW_BG[row.status] }}
                >
                  {/* Ingredient (unit) */}
                  <td className="px-3 py-2 font-medium text-text">
                    {row.ingredientName}{' '}
                    <span className="text-muted font-normal">({row.unit})</span>
                  </td>

                  {/* Source */}
                  <td className="px-3 py-2 text-center">
                    <Badge color={isCp ? 'amber' : 'accent'}>{isCp ? 'CP' : 'You'}</Badge>
                  </td>

                  {/* Total Need — dual display */}
                  <td className="px-3 py-2 text-right font-mono text-text">
                    {showDualNeed ? (
                      <>
                        {fmtU(row.recipeUnitNeed, row.recipeUnit)}{' '}
                        <span className="text-muted">({fmtU(row.totalNeed, row.unit)})</span>
                      </>
                    ) : (
                      fmtU(row.totalNeed, row.unit)
                    )}
                  </td>

                  {isCp ? (
                    <>
                      <td className="px-3 py-2 text-right text-muted">—</td>
                      <td className="px-3 py-2 text-right text-muted">—</td>
                      <td className="px-3 py-2 text-right text-muted">—</td>
                      <td className="px-3 py-2 text-right text-muted">—</td>
                      <td className="px-3 py-2 text-center">
                        <Badge color="amber">CP PROVIDED</Badge>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2 text-right font-mono text-text">{fmtU(row.atCoPacker, row.unit)}</td>
                      <td className="px-3 py-2 text-right font-mono text-text">{fmtU(row.inTransit, row.unit)}</td>
                      <td className="px-3 py-2 text-right font-mono text-text">{fmtU(row.totalAvailable, row.unit)}</td>

                      {/* Shortfall */}
                      <td className="px-3 py-2 text-right font-mono font-medium" style={{ color: row.shortfall > 0 ? '#EF4444' : undefined }}>
                        {fmtU(row.shortfall, row.unit)}
                      </td>

                      {/* To Order — dual with secondary system */}
                      <td className="px-3 py-2 text-right font-mono font-medium" style={{ color: row.needToOrder > 0 ? '#EF4444' : undefined }}>
                        {orderDual ? (
                          <>
                            {orderDual.primary}
                            {orderDual.secondary && (
                              <span className="text-muted font-normal"> ({orderDual.secondary})</span>
                            )}
                          </>
                        ) : (
                          fmtU(0, row.unit)
                        )}
                      </td>
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Summary bar */}
      <div className="mt-3 flex items-center gap-4 text-sm">
        {summary.ready > 0 && (
          <span className="flex items-center gap-1.5 text-green-400">
            <Check size={14} />
            <span className="font-medium">{summary.ready}</span> Ready
          </span>
        )}
        {summary.needOrder > 0 && (
          <span className="flex items-center gap-1.5 text-red-400">
            <AlertTriangle size={14} />
            <span className="font-medium">{summary.needOrder}</span> Need Order
          </span>
        )}
        {cpCount > 0 && (
          <span className="text-amber-400">
            + <span className="font-medium">{cpCount}</span> CP provided
          </span>
        )}
      </div>

      {/* Action buttons */}
      {!compact && onCreatePOs && (
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={onCreatePOs}
            disabled={summary.needOrder === 0}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            <ShoppingCart size={15} />
            Create Purchase Orders
          </button>
        </div>
      )}
    </div>
  )
}
