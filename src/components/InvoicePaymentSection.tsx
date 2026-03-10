import { useState, useMemo } from 'react'
import Badge from './Badge'
import AddInvoiceModal from './AddInvoiceModal'
import ConfirmDialog from './ConfirmDialog'
import { useToast } from './Toast'
import { dbDelete, dbDeleteIn } from '../lib/dbWrite'
import { fmt$, fmtRate, fmtDate } from '../lib/format'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import type {
  ProductionOrder,
  ProductionRun,
  CoPacker,
  ProductionRunInvoice,
  ProductionRunPayment,
} from '../types/database'

/* ── Status helpers ──────────────────────────────────────────────── */

function computeInvoiceStatus(invoice: ProductionRunInvoice, payments: ProductionRunPayment[]): string {
  const totalPaid = payments
    .filter((p) => p.invoice_id === invoice.id)
    .reduce((sum, p) => sum + Number(p.amount), 0)
  if (totalPaid === 0) return 'pending'
  if (totalPaid >= Number(invoice.total_amount)) return 'paid'
  return 'partial'
}

const STATUS_BADGE: Record<string, 'gray' | 'amber' | 'green' | 'red'> = {
  pending: 'gray',
  partial: 'amber',
  paid: 'green',
  overdue: 'red',
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  partial: 'Partial',
  paid: '✓ Paid',
  overdue: 'Overdue',
}

/* ── Component ───────────────────────────────────────────────────── */

export default function InvoicePaymentSection({
  order,
  runs,
  coPackers,
  invoices,
  payments,
  onRefresh,
}: {
  order: ProductionOrder
  runs: ProductionRun[]
  coPackers: CoPacker[]
  invoices: ProductionRunInvoice[]
  payments: ProductionRunPayment[]
  onRefresh: () => void
}) {
  const toast = useToast()

  /* ── Invoice modal state ─────────────────────────────────────── */
  const [showAddInvoice, setShowAddInvoice] = useState(false)
  const [editingInvoice, setEditingInvoice] = useState<ProductionRunInvoice | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  /* ── Filter invoices & payments for this order ──────────────── */
  const orderInvoices = useMemo(
    () => invoices.filter((inv) => inv.production_order_id === order.id),
    [invoices, order.id],
  )

  const orderRuns = useMemo(
    () => runs.filter((r) => r.production_order_id === order.id),
    [runs, order.id],
  )

  /* ── Enriched invoice rows ──────────────────────────────────── */
  const enrichedInvoices = useMemo(() => {
    return orderInvoices.map((inv) => {
      const invPayments = payments.filter((p) => p.invoice_id === inv.id)
      const totalPaid = invPayments.reduce((sum, p) => sum + Number(p.amount), 0)
      const balance = Math.max(0, Number(inv.total_amount) - totalPaid)
      const status = computeInvoiceStatus(inv, payments)
      return { ...inv, payments: invPayments, totalPaid, balance, status }
    })
  }, [orderInvoices, payments])

  /* ── Financial summary (CP invoices only) ────────────────────── */
  const financialSummary = useMemo(() => {
    const cpCost = enrichedInvoices.reduce((sum, inv) => sum + Number(inv.total_amount), 0)
    const cpPaid = enrichedInvoices.reduce((sum, inv) => sum + inv.totalPaid, 0)
    const cpBalance = Math.max(0, cpCost - cpPaid)
    return { cpCost, cpPaid, cpBalance }
  }, [enrichedInvoices])

  /* ── Delete invoice ──────────────────────────────────────────── */
  async function handleDeleteInvoice() {
    if (!confirmDeleteId) return
    setDeleting(true)
    try {
      // Delete payments first
      const invPayments = payments.filter((p) => p.invoice_id === confirmDeleteId)
      if (invPayments.length > 0) {
        const { error } = await dbDeleteIn('production_run_payments', 'invoice_id', [confirmDeleteId])
        if (error) throw error
      }
      // Delete invoice
      const { error } = await dbDelete('production_run_invoices', 'id', confirmDeleteId)
      if (error) throw error
      toast.success('Invoice deleted')
      onRefresh()
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to delete invoice')
    } finally {
      setDeleting(false)
      setConfirmDeleteId(null)
    }
  }

  /* ── No invoices — minimal render ───────────────────────────── */
  if (orderInvoices.length === 0 && financialSummary.ingredientCost === 0) {
    return (
      <div className="border-t border-border pt-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-base font-semibold uppercase tracking-wider text-muted">CP Invoice & Payments</p>
          <button
            type="button"
            onClick={() => setShowAddInvoice(true)}
            className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent/20"
          >
            <Plus size={14} /> Add Invoice
          </button>
        </div>
        <p className="text-[13px] text-muted">No invoices yet.</p>

        {/* Add Invoice Modal */}
        <AddInvoiceModal
          isOpen={showAddInvoice}
          onClose={() => setShowAddInvoice(false)}
          order={order}
          runs={runs}
          coPackers={coPackers}
          onSaved={onRefresh}
        />
      </div>
    )
  }

  /* ── Full render ────────────────────────────────────────────── */
  return (
    <div className="border-t border-border pt-3 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-base font-semibold uppercase tracking-wider text-muted">CP Invoice & Payments</p>
        <button
          type="button"
          onClick={() => setShowAddInvoice(true)}
          className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent/20"
        >
          <Plus size={14} /> Add Invoice
        </button>
      </div>

      {/* Invoice table */}
      {enrichedInvoices.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-border bg-surface/50 text-muted">
                <th className="px-3 py-3 text-left text-[13px] font-semibold uppercase tracking-wider">Invoice #</th>
                <th className="px-3 py-3 text-left text-[13px] font-semibold uppercase tracking-wider">Date</th>
                <th className="px-3 py-3 text-right text-[13px] font-semibold uppercase tracking-wider">Total</th>
                <th className="px-3 py-3 text-right text-[13px] font-semibold uppercase tracking-wider">Per Unit</th>
                <th className="px-3 py-3 text-right text-[13px] font-semibold uppercase tracking-wider">Paid</th>
                <th className="px-3 py-3 text-right text-[13px] font-semibold uppercase tracking-wider">Balance</th>
                <th className="px-3 py-3 text-center text-[13px] font-semibold uppercase tracking-wider">Status</th>
                <th className="px-3 py-3 text-center text-[13px] font-semibold uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {enrichedInvoices.map((inv) => (
                <tr key={inv.id} className="border-b border-border last:border-0" style={{ height: 48 }}>
                  <td className="px-3 py-3 font-mono text-accent">{inv.invoice_number || '—'}</td>
                  <td className="px-3 py-3 text-text">{inv.invoice_date ? fmtDate(inv.invoice_date) : '—'}</td>
                  <td className="px-3 py-3 text-right font-mono text-text">{fmt$(Number(inv.total_amount))}</td>
                  <td className="px-3 py-3 text-right font-mono text-muted">
                    {inv.per_unit_cost != null ? fmtRate(Number(inv.per_unit_cost)) : '—'}
                  </td>
                  <td className="px-3 py-3 text-right font-mono" style={{ color: '#22C55E' }}>
                    {fmt$(inv.totalPaid)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono" style={{ color: inv.balance > 0 ? '#F59E0B' : '#22C55E' }}>
                    {fmt$(inv.balance)}
                  </td>
                  <td className="px-3 py-3 text-center">
                    <Badge color={STATUS_BADGE[inv.status] ?? 'gray'}>
                      {STATUS_LABEL[inv.status] ?? inv.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEditingInvoice(inv)}
                        className="rounded p-1.5 text-muted transition-colors hover:text-text hover:bg-hover"
                        title="Edit"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(inv.id)}
                        className="rounded p-1.5 text-muted transition-colors hover:text-red-400 hover:bg-hover"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Financial Summary */}
      {enrichedInvoices.length > 0 && (
        <div className="rounded-lg border border-border bg-surface/30 px-5 py-4">
          <p className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-muted">Financial Summary</p>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[14px]">
            <span className="text-muted">{enrichedInvoices.length > 1 ? 'CP Invoices Total:' : 'CP Invoice Total:'}</span>
            <span className="text-right font-mono text-text">{fmt$(financialSummary.cpCost)}</span>

            <span className="text-muted">{enrichedInvoices.length > 1 ? 'Total Paid:' : 'CP Paid:'}</span>
            <span className="text-right font-mono" style={{ color: '#22C55E' }}>{fmt$(financialSummary.cpPaid)}</span>

            <span className="text-muted">{enrichedInvoices.length > 1 ? 'Total Balance:' : 'CP Balance:'}</span>
            <span
              className="text-right font-mono font-semibold"
              style={{ color: financialSummary.cpBalance > 0 ? '#F59E0B' : '#22C55E' }}
            >
              {fmt$(financialSummary.cpBalance)}
            </span>
          </div>
        </div>
      )}

      {/* Add Invoice Modal */}
      <AddInvoiceModal
        isOpen={showAddInvoice}
        onClose={() => setShowAddInvoice(false)}
        order={order}
        runs={runs}
        coPackers={coPackers}
        onSaved={onRefresh}
      />

      {/* Edit Invoice Modal */}
      {editingInvoice && (
        <AddInvoiceModal
          isOpen={true}
          onClose={() => setEditingInvoice(null)}
          order={order}
          runs={runs}
          coPackers={coPackers}
          existingInvoice={editingInvoice}
          existingPayments={payments.filter((p) => p.invoice_id === editingInvoice.id)}
          onSaved={onRefresh}
        />
      )}

      {/* Delete Confirm */}
      <ConfirmDialog
        isOpen={!!confirmDeleteId}
        title="Delete Invoice?"
        message="This will permanently delete this invoice and all its payments. This cannot be undone."
        confirmLabel="Delete"
        danger
        loading={deleting}
        onConfirm={handleDeleteInvoice}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  )
}

/* ── Utility: Compute payment summary for order card header ──── */
export function getOrderPaymentSummary(
  orderId: string,
  invoices: ProductionRunInvoice[],
  payments: ProductionRunPayment[],
): { cpCost: number; totalPaid: number; balance: number; status: 'none' | 'pending' | 'partial' | 'paid' } {
  const orderInvoices = invoices.filter((inv) => inv.production_order_id === orderId)
  if (orderInvoices.length === 0) return { cpCost: 0, totalPaid: 0, balance: 0, status: 'none' }

  const cpCost = orderInvoices.reduce((sum, inv) => sum + Number(inv.total_amount), 0)
  const totalPaid = orderInvoices.reduce((sum, inv) => {
    const invPayments = payments.filter((p) => p.invoice_id === inv.id)
    return sum + invPayments.reduce((s, p) => s + Number(p.amount), 0)
  }, 0)
  const balance = Math.max(0, cpCost - totalPaid)

  let status: 'none' | 'pending' | 'partial' | 'paid' = 'pending'
  if (totalPaid === 0) status = 'pending'
  else if (totalPaid >= cpCost) status = 'paid'
  else status = 'partial'

  return { cpCost, totalPaid, balance, status }
}
