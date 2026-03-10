import { useState, useMemo } from 'react'
import Modal from './Modal'
import Badge from './Badge'
import { useToast } from './Toast'
import { sanitize } from '../lib/sanitizePayload'
import { dbInsertSingle, dbInsert, dbUpdate, dbDelete } from '../lib/dbWrite'
import { fmt$, fmtDate } from '../lib/format'
import { format } from 'date-fns'
import { Plus, Trash2 } from 'lucide-react'
import type {
  ProductionOrder,
  ProductionRun,
  ProductionRunInvoice,
  ProductionRunPayment,
  CoPacker,
} from '../types/database'

/* ── Payment form row ──────────────────────────────────────────── */
interface PaymentRow {
  id: string | null
  payment_type: string
  amount: string
  payment_date: string
  payment_method: string
  payment_method_used: string
  card_used: string
  processing_fee: number
  reference_number: string
  notes: string
  _deleted?: boolean
}

const PAYMENT_TYPES = ['Deposit', 'Progress Payment', 'Balance', 'Final Payment']
const PAYMENT_METHODS = ['Wire Transfer', 'ACH', 'Check', 'Credit Card', 'Melio', 'Cash', 'Other']
const MELIO_FEE_PCT = 0.029

/* ── Status helpers ──────────────────────────────────────────────── */
function getInvoiceStatus(totalAmount: number, payments: PaymentRow[]): string {
  const totalPaid = payments
    .filter((p) => !p._deleted && Number(p.amount) > 0)
    .reduce((sum, p) => sum + Number(p.amount), 0)
  if (totalPaid === 0) return 'pending'
  if (totalPaid >= totalAmount) return 'paid'
  return 'partial'
}

const STATUS_BADGE: Record<string, 'gray' | 'amber' | 'green'> = {
  pending: 'gray',
  partial: 'amber',
  paid: 'green',
}

/* ── Component ───────────────────────────────────────────────────── */
export default function AddInvoiceModal({
  isOpen,
  onClose,
  order,
  runs,
  coPackers,
  existingInvoice,
  existingPayments,
  onSaved,
}: {
  isOpen: boolean
  onClose: () => void
  order: ProductionOrder
  runs: ProductionRun[]
  coPackers: CoPacker[]
  existingInvoice?: ProductionRunInvoice | null
  existingPayments?: ProductionRunPayment[]
  onSaved: () => void
}) {
  const toast = useToast()
  const editing = !!existingInvoice

  const orderRuns = useMemo(
    () => runs.filter((r) => r.production_order_id === order.id),
    [runs, order.id],
  )
  const totalUnits = orderRuns.reduce((s, r) => s + r.requested_quantity, 0)
  const cp = coPackers.find((c) => c.id === order.co_packer_id)

  /* ── Form state ──────────────────────────────────────────────── */
  const [invoiceNumber, setInvoiceNumber] = useState(existingInvoice?.invoice_number ?? '')
  const [invoiceDate, setInvoiceDate] = useState(
    existingInvoice?.invoice_date ?? format(new Date(), 'yyyy-MM-dd'),
  )
  const [appliesTo, setAppliesTo] = useState<'order' | 'run'>(
    existingInvoice?.production_run_id ? 'run' : 'order',
  )
  const [selectedRunId, setSelectedRunId] = useState(existingInvoice?.production_run_id ?? '')
  const [totalAmount, setTotalAmount] = useState(
    existingInvoice ? String(existingInvoice.total_amount) : '',
  )
  const [perUnitCost, setPerUnitCost] = useState(
    existingInvoice?.per_unit_cost != null ? String(existingInvoice.per_unit_cost) : '',
  )
  const [notes, setNotes] = useState(existingInvoice?.notes ?? '')
  const [saving, setSaving] = useState(false)

  /* ── Derived unit count (for per-unit calc) ──────────────────── */
  const unitCount = useMemo(() => {
    if (appliesTo === 'run' && selectedRunId) {
      const run = orderRuns.find((r) => r.id === selectedRunId)
      return run?.requested_quantity ?? 0
    }
    return totalUnits
  }, [appliesTo, selectedRunId, orderRuns, totalUnits])

  /* ── Bidirectional cost sync ─────────────────────────────────── */
  const [lastEdited, setLastEdited] = useState<'total' | 'perUnit'>('total')

  function handleTotalChange(val: string) {
    setTotalAmount(val)
    setLastEdited('total')
    const num = Number(val)
    if (num > 0 && unitCount > 0) {
      setPerUnitCost((num / unitCount).toFixed(4))
    } else {
      setPerUnitCost('')
    }
  }

  function handlePerUnitChange(val: string) {
    setPerUnitCost(val)
    setLastEdited('perUnit')
    const num = Number(val)
    if (num > 0 && unitCount > 0) {
      setTotalAmount((num * unitCount).toFixed(2))
    } else {
      setTotalAmount('')
    }
  }

  /* ── Payment rows state ──────────────────────────────────────── */
  const [payments, setPayments] = useState<PaymentRow[]>(() => {
    if (existingPayments && existingPayments.length > 0) {
      return existingPayments.map((p) => ({
        id: p.id,
        payment_type: p.payment_type,
        amount: String(p.amount),
        payment_date: p.payment_date ?? '',
        payment_method: p.payment_method ?? '',
        payment_method_used: (p as any).payment_method_used ?? '',
        card_used: (p as any).card_used ?? '',
        processing_fee: Number((p as any).processing_fee ?? 0),
        reference_number: p.reference_number ?? '',
        notes: p.notes ?? '',
      }))
    }
    return []
  })

  function addPayment() {
    setPayments((prev) => [
      ...prev,
      {
        id: null,
        payment_type: 'Deposit',
        amount: '',
        payment_date: format(new Date(), 'yyyy-MM-dd'),
        payment_method: '',
        payment_method_used: '',
        card_used: '',
        processing_fee: 0,
        reference_number: '',
        notes: '',
      },
    ])
  }

  function updatePayment(idx: number, field: keyof PaymentRow, val: string) {
    setPayments((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: val } : p)))
  }

  function removePayment(idx: number) {
    setPayments((prev) =>
      prev.map((p, i) => {
        if (i !== idx) return p
        if (p.id) return { ...p, _deleted: true }
        return p
      }).filter((p, i) => i !== idx || p.id),
    )
  }

  /* ── Quick actions ───────────────────────────────────────────── */
  function markDepositPaid() {
    setPayments((prev) => [
      ...prev,
      {
        id: null,
        payment_type: 'Deposit',
        amount: totalAmount ? String(Math.round(Number(totalAmount) * 0.5 * 100) / 100) : '',
        payment_date: format(new Date(), 'yyyy-MM-dd'),
        payment_method: '',
        payment_method_used: '',
        card_used: '',
        processing_fee: 0,
        reference_number: '',
        notes: '',
      },
    ])
  }

  function markFullyPaid() {
    const totalPaid = payments
      .filter((p) => !p._deleted)
      .reduce((s, p) => s + Number(p.amount), 0)
    const remaining = Math.max(0, Number(totalAmount) - totalPaid)
    if (remaining <= 0) return
    setPayments((prev) => [
      ...prev,
      {
        id: null,
        payment_type: 'Final Payment',
        amount: String(remaining.toFixed(2)),
        payment_date: format(new Date(), 'yyyy-MM-dd'),
        payment_method: '',
        payment_method_used: '',
        card_used: '',
        processing_fee: 0,
        reference_number: '',
        notes: '',
      },
    ])
  }

  /* ── Payment totals ──────────────────────────────────────────── */
  const activePayments = payments.filter((p) => !p._deleted)
  const totalPaid = activePayments.reduce((s, p) => s + Number(p.amount), 0)
  const balance = Math.max(0, Number(totalAmount) - totalPaid)
  const computedStatus = getInvoiceStatus(Number(totalAmount), payments)

  /* ── Save ────────────────────────────────────────────────────── */
  async function handleSave() {
    if (!totalAmount || Number(totalAmount) <= 0) {
      toast.error('Total amount is required')
      return
    }
    setSaving(true)
    try {
      let invoiceId = existingInvoice?.id

      const invoicePayload = sanitize('production_run_invoices', {
        production_order_id: order.id,
        production_run_id: appliesTo === 'run' ? selectedRunId || null : null,
        co_packer_id: order.co_packer_id,
        invoice_number: invoiceNumber || null,
        invoice_date: invoiceDate || null,
        total_amount: Number(totalAmount),
        per_unit_cost: perUnitCost ? Number(perUnitCost) : null,
        notes: notes || null,
        status: computedStatus,
      })

      if (editing && invoiceId) {
        const { error } = await dbUpdate('production_run_invoices', invoicePayload, 'id', invoiceId)
        if (error) throw error
      } else {
        const { data, error } = await dbInsertSingle('production_run_invoices', invoicePayload)
        if (error) throw error
        invoiceId = data.id
      }

      // Handle payments: delete removed, update existing, insert new
      for (const p of payments) {
        if (p._deleted && p.id) {
          const { error } = await dbDelete('production_run_payments', 'id', p.id)
          if (error) throw error
          continue
        }
        if (p._deleted) continue

        const fee = p.payment_method_used === 'Melio' ? parseFloat((Number(p.amount) * MELIO_FEE_PCT).toFixed(2)) : 0
        const paymentPayload = sanitize('production_run_payments', {
          invoice_id: invoiceId,
          payment_type: p.payment_type,
          amount: Number(p.amount),
          payment_date: p.payment_date || null,
          payment_method: p.payment_method || null,
          payment_method_used: p.payment_method_used || null,
          card_used: p.payment_method_used === 'Credit Card' ? (p.card_used || null) : null,
          processing_fee: fee,
          reference_number: p.reference_number || null,
          notes: p.notes || null,
        })

        if (p.id) {
          const { error } = await dbUpdate('production_run_payments', paymentPayload, 'id', p.id)
          if (error) throw error
        } else {
          const { error } = await dbInsert('production_run_payments', paymentPayload)
          if (error) throw error
        }
      }

      toast.success(editing ? 'Invoice updated' : 'Invoice created')
      onSaved()
      onClose()
    } catch (err: any) {
      console.error('Save invoice error:', err)
      toast.error(err?.message ?? 'Failed to save invoice')
    } finally {
      setSaving(false)
    }
  }

  /* ── Render ──────────────────────────────────────────────────── */
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? 'Edit CP Invoice' : 'Add CP Invoice'} wide="xl">
      <div className="space-y-4">
        {/* Invoice fields */}
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-muted">Invoice #</span>
            <input
              type="text"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="INV-2024-0045"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-muted">Invoice Date</span>
            <input
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
            />
          </label>
        </div>

        {/* Applies to */}
        <div>
          <span className="mb-2 block text-[13px] font-medium text-muted">Applies to</span>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-[14px] text-text cursor-pointer">
              <input
                type="radio"
                name="appliesTo"
                checked={appliesTo === 'order'}
                onChange={() => { setAppliesTo('order'); setSelectedRunId('') }}
                className="accent-[#3B82F6]"
              />
              Entire Production Order (all flavors)
            </label>
            <label className="flex items-center gap-2 text-[14px] text-text cursor-pointer">
              <input
                type="radio"
                name="appliesTo"
                checked={appliesTo === 'run'}
                onChange={() => setAppliesTo('run')}
                className="accent-[#3B82F6]"
              />
              Specific run:
            </label>
            {appliesTo === 'run' && (
              <select
                value={selectedRunId}
                onChange={(e) => setSelectedRunId(e.target.value)}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-[14px] text-text outline-none focus:border-accent"
              >
                <option value="">Select run…</option>
                {orderRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.run_number} — {r.requested_quantity.toLocaleString()} units
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Total & Per Unit */}
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-muted">Total Invoice Amount</span>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-muted">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={totalAmount}
                onChange={(e) => handleTotalChange(e.target.value)}
                placeholder="7,800.00"
                className="w-full rounded-lg border border-border bg-surface pl-7 pr-3 py-2 text-[14px] text-text outline-none focus:border-accent"
              />
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-muted">Per Unit Cost (auto)</span>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-muted">$</span>
              <input
                type="number"
                min="0"
                step="0.0001"
                value={perUnitCost}
                onChange={(e) => handlePerUnitChange(e.target.value)}
                placeholder="1.20"
                className="w-full rounded-lg border border-border bg-surface pl-7 pr-3 py-2 text-[14px] text-text outline-none focus:border-accent"
              />
            </div>
          </label>
        </div>

        {/* Auto-calculated info */}
        {unitCount > 0 && (
          <div className="rounded-lg border border-border bg-surface/50 px-4 py-2.5 text-[13px] text-muted">
            Total units: <span className="font-mono font-medium text-text">{unitCount.toLocaleString()}</span>
            {Number(totalAmount) > 0 && unitCount > 0 && (
              <span className="ml-4">
                Per unit cost: <span className="font-mono font-medium text-text">${(Number(totalAmount) / unitCount).toFixed(4)}</span>
              </span>
            )}
          </div>
        )}

        {/* Notes */}
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-muted">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Optional notes…"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-text placeholder:text-muted/50 outline-none focus:border-accent resize-none"
          />
        </label>

        {/* ── Payment Schedule ──────────────────────────────────── */}
        <div className="border-t border-border pt-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-base font-semibold uppercase tracking-wider text-muted">Payment Schedule</p>
            <div className="flex items-center gap-2">
              {Number(totalAmount) > 0 && activePayments.length === 0 && (
                <button
                  type="button"
                  onClick={markDepositPaid}
                  className="rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:text-text hover:bg-hover"
                >
                  + Mark Deposit Paid
                </button>
              )}
              {Number(totalAmount) > 0 && balance > 0 && (
                <button
                  type="button"
                  onClick={markFullyPaid}
                  className="rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:text-text hover:bg-hover"
                >
                  + Mark Fully Paid
                </button>
              )}
              <button
                type="button"
                onClick={addPayment}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-accent/10"
              >
                <Plus size={13} /> Add Payment
              </button>
            </div>
          </div>

          {activePayments.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-surface/50 text-muted">
                    <th className="px-3 py-2 text-left font-semibold">Type</th>
                    <th className="px-3 py-2 text-right font-semibold">Amount</th>
                    <th className="px-3 py-2 text-left font-semibold">Date</th>
                    <th className="px-3 py-2 text-left font-semibold">Method</th>
                    <th className="px-3 py-2 text-right font-semibold">Fee</th>
                    <th className="px-3 py-2 text-left font-semibold">Reference</th>
                    <th className="px-3 py-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p, idx) => {
                    if (p._deleted) return null
                    const melioFee = p.payment_method_used === 'Melio' ? Number(p.amount) * MELIO_FEE_PCT : 0
                    return (
                      <tr key={p.id ?? `new-${idx}`} className="border-b border-border last:border-0">
                        <td className="px-2 py-1.5">
                          <select
                            value={p.payment_type}
                            onChange={(e) => updatePayment(idx, 'payment_type', e.target.value)}
                            className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent"
                          >
                            {PAYMENT_TYPES.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={p.amount}
                            onChange={(e) => updatePayment(idx, 'amount', e.target.value)}
                            placeholder="0.00"
                            className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text text-right font-mono outline-none focus:border-accent"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="date"
                            value={p.payment_date}
                            onChange={(e) => updatePayment(idx, 'payment_date', e.target.value)}
                            className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <select
                            value={p.payment_method_used || p.payment_method}
                            onChange={(e) => updatePayment(idx, 'payment_method_used', e.target.value)}
                            className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent"
                          >
                            <option value="">—</option>
                            {PAYMENT_METHODS.map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-[12px]">
                          {melioFee > 0 ? <span className="text-pink-400">+{fmt$(melioFee)}</span> : '—'}
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="text"
                            value={p.reference_number}
                            onChange={(e) => updatePayment(idx, 'reference_number', e.target.value)}
                            placeholder="Ref #"
                            className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent"
                          />
                        </td>
                        <td className="px-1 py-1.5">
                          <button
                            type="button"
                            onClick={() => removePayment(idx)}
                            className="rounded p-1 text-muted transition-colors hover:text-red-400"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Payment totals */}
          {Number(totalAmount) > 0 && (
            <div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-surface/50 px-4 py-2.5 text-[13px]">
              <div className="flex items-center gap-4">
                <span className="text-muted">
                  Total: <span className="font-mono font-medium text-text">{fmt$(Number(totalAmount))}</span>
                </span>
                <span className="text-muted">
                  Paid: <span className="font-mono font-medium" style={{ color: '#22C55E' }}>{fmt$(totalPaid)}</span>
                </span>
                <span className="text-muted">
                  Due: <span className="font-mono font-medium" style={{ color: balance > 0 ? '#F59E0B' : '#22C55E' }}>{fmt$(balance)}</span>
                </span>
              </div>
              <Badge color={STATUS_BADGE[computedStatus] ?? 'gray'}>
                {computedStatus === 'paid' ? '✓ Paid' : computedStatus === 'partial' ? 'Partial' : 'Pending'}
              </Badge>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? 'Saving…' : editing ? 'Update Invoice' : 'Save Invoice'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
