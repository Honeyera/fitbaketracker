import { useState, useEffect, useCallback } from 'react'
import { format } from 'date-fns'
import Badge from './Badge'
import CardUsedPicker from './CardUsedPicker'
import { useToast } from './Toast'
import { sanitize } from '../lib/sanitizePayload'
import { dbInsertSingle, dbUpdate, dbDelete } from '../lib/dbWrite'
import { supabase } from '../lib/supabase'
import { fmt$, fmtDate } from '../lib/format'
import { Plus, Trash2, Check } from 'lucide-react'
import type { POPayment } from '../types/database'

/* ── Constants ─────────────────────────────────────────────────── */

const MELIO_FEE_PCT = 0.029

const PAYMENT_TYPES = ['Deposit', 'Partial Payment', 'Balance / Final Payment', 'Prepayment']
const ROW_PAYMENT_METHODS = ['Wire Transfer', 'ACH', 'Check', 'Credit Card', 'Melio', 'Cash', 'Other']

/* ── Due date calculator ───────────────────────────────────────── */

function calculateDueDate(orderDate: string | null, terms: string): string | null {
  if (!orderDate || !terms) return null
  const date = new Date(orderDate + 'T00:00:00')
  switch (terms) {
    case 'net_15': date.setDate(date.getDate() + 15); break
    case 'net_20': date.setDate(date.getDate() + 20); break
    case 'net_30': date.setDate(date.getDate() + 30); break
    case 'net_45': date.setDate(date.getDate() + 45); break
    case 'net_60': date.setDate(date.getDate() + 60); break
    case 'net_90': date.setDate(date.getDate() + 90); break
    default: return null
  }
  return date.toISOString().split('T')[0]
}

/* ── Payment row state ─────────────────────────────────────────── */

interface PaymentRow {
  id: string | null
  payment_type: string
  amount: string
  payment_date: string
  due_date: string
  payment_method: string
  payment_method_used: string
  card_used: string
  processing_fee: number
  reference_number: string
  notes: string
  status: string
  _deleted?: boolean
}

function emptyPaymentRow(): PaymentRow {
  return {
    id: null,
    payment_type: 'Deposit',
    amount: '',
    payment_date: format(new Date(), 'yyyy-MM-dd'),
    due_date: '',
    payment_method: '',
    payment_method_used: '',
    card_used: '',
    processing_fee: 0,
    reference_number: '',
    notes: '',
    status: 'pending',
  }
}

/* ── Component ─────────────────────────────────────────────────── */

export default function POPaymentSection({
  purchaseOrderId,
  totalCost,
  shippingCost,
  orderDate,
  paymentTerms: initialTerms,
  paymentDueDate: initialDueDate,
  onPaymentStatusChange,
}: {
  purchaseOrderId: string
  totalCost: number
  shippingCost: number
  orderDate: string | null
  paymentTerms: string
  paymentDueDate: string
  onPaymentStatusChange: (status: string, amountPaid: number, terms: string, dueDate: string) => void
}) {
  const toast = useToast()
  const grandTotal = totalCost + shippingCost

  /* ── Due date state ──────────────────────────────────────────── */
  const terms = initialTerms
  const [dueDate, setDueDate] = useState(initialDueDate)

  // Auto-calc due date when terms or order date change
  useEffect(() => {
    if (terms && orderDate) {
      const calc = calculateDueDate(orderDate, terms)
      if (calc) setDueDate(calc)
    }
  }, [terms, orderDate])

  /* ── Payment rows ────────────────────────────────────────────── */
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [loadingPayments, setLoadingPayments] = useState(true)

  const loadPayments = useCallback(async () => {
    const { data } = await supabase
      .from('po_payments')
      .select('*')
      .eq('purchase_order_id', purchaseOrderId)
      .order('created_at')
    if (data) {
      setPayments(
        data.map((p: POPayment) => ({
          id: p.id,
          payment_type: p.payment_type,
          amount: String(p.amount),
          payment_date: p.payment_date ?? '',
          due_date: p.due_date ?? '',
          payment_method: p.payment_method ?? '',
          payment_method_used: (p as any).payment_method_used ?? '',
          card_used: (p as any).card_used ?? '',
          processing_fee: Number((p as any).processing_fee ?? 0),
          reference_number: p.reference_number ?? '',
          notes: p.notes ?? '',
          status: p.status ?? 'pending',
        })),
      )
    }
    setLoadingPayments(false)
  }, [purchaseOrderId])

  useEffect(() => { loadPayments() }, [loadPayments])

  /* ── Derived totals ──────────────────────────────────────────── */
  const activePayments = payments.filter((p) => !p._deleted)
  const totalPaid = activePayments
    .filter((p) => p.status === 'paid')
    .reduce((s, p) => s + Number(p.amount), 0)
  const balance = Math.max(0, grandTotal - totalPaid)

  const paymentStatus = totalPaid === 0 ? 'unpaid' : totalPaid >= grandTotal ? 'paid' : 'partial'

  // Notify parent of status changes
  useEffect(() => {
    onPaymentStatusChange(paymentStatus, totalPaid, terms, dueDate)
  }, [paymentStatus, totalPaid, terms, dueDate])

  /* ── Due date urgency ────────────────────────────────────────── */
  const dueDateUrgency = (() => {
    if (!dueDate || paymentStatus === 'paid') return 'normal'
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const due = new Date(dueDate + 'T00:00:00')
    const diff = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    if (diff < 0) return 'overdue'
    if (diff <= 7) return 'soon'
    return 'normal'
  })()

  /* ── CRUD handlers ───────────────────────────────────────────── */

  async function savePayment(row: PaymentRow) {
    const fee = row.payment_method_used === 'Melio' ? parseFloat((Number(row.amount) * MELIO_FEE_PCT).toFixed(2)) : 0
    const payload = sanitize('po_payments', {
      purchase_order_id: purchaseOrderId,
      payment_type: row.payment_type,
      amount: Number(row.amount),
      payment_date: row.payment_date || null,
      due_date: row.due_date || null,
      payment_method: row.payment_method || null,
      payment_method_used: row.payment_method_used || null,
      card_used: (row.payment_method_used === 'Credit Card' || row.payment_method_used === 'Melio') ? (row.card_used || null) : null,
      processing_fee: fee,
      reference_number: row.reference_number || null,
      notes: row.notes || null,
      status: row.status,
    })

    if (row.id) {
      const { error } = await dbUpdate('po_payments', payload, 'id', row.id)
      if (error) throw error
    } else {
      const { error } = await dbInsertSingle('po_payments', payload)
      if (error) throw error
    }
  }

  async function handleAddPayment(type: string, amount: number, status: string = 'pending') {
    try {
      const payload = sanitize('po_payments', {
        purchase_order_id: purchaseOrderId,
        payment_type: type,
        amount,
        payment_date: status === 'paid' ? format(new Date(), 'yyyy-MM-dd') : null,
        due_date: dueDate || null,
        payment_method: null,
        payment_method_used: null,
        card_used: null,
        processing_fee: 0,
        reference_number: null,
        notes: null,
        status,
      })
      const { error } = await dbInsertSingle('po_payments', payload)
      if (error) throw error
      await loadPayments()
      toast.success('Payment added')
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to add payment')
    }
  }

  async function handleDeletePayment(id: string) {
    try {
      const { error } = await dbDelete('po_payments', 'id', id)
      if (error) throw error
      await loadPayments()
      toast.success('Payment removed')
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to delete payment')
    }
  }

  async function handleMarkPaid(row: PaymentRow) {
    try {
      const payload = sanitize('po_payments', {
        status: 'paid',
        payment_date: format(new Date(), 'yyyy-MM-dd'),
      })
      const { error } = await dbUpdate('po_payments', payload, 'id', row.id!)
      if (error) throw error
      await loadPayments()
      toast.success('Payment marked as paid')
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to update payment')
    }
  }

  /* ── Inline edit state ───────────────────────────────────────── */
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editRow, setEditRow] = useState<PaymentRow | null>(null)

  function startEdit(idx: number) {
    setEditingIdx(idx)
    setEditRow({ ...activePayments[idx] })
  }

  async function saveEdit() {
    if (!editRow) return
    try {
      await savePayment(editRow)
      await loadPayments()
      setEditingIdx(null)
      setEditRow(null)
      toast.success('Payment updated')
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to update')
    }
  }

  function cancelEdit() {
    setEditingIdx(null)
    setEditRow(null)
  }

  /* ── Add payment form state ──────────────────────────────────── */
  const [showAddForm, setShowAddForm] = useState(false)
  const [newPayment, setNewPayment] = useState<PaymentRow>(emptyPaymentRow())

  async function handleSaveNewPayment() {
    if (!newPayment.amount || Number(newPayment.amount) <= 0) {
      toast.error('Amount is required')
      return
    }
    try {
      await savePayment(newPayment)
      await loadPayments()
      setShowAddForm(false)
      setNewPayment(emptyPaymentRow())
      toast.success('Payment added')
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to add payment')
    }
  }

  /* ── Quick actions ───────────────────────────────────────────── */

  function handleMarkFullyPaid() {
    if (balance <= 0) return
    handleAddPayment('Balance / Final Payment', Math.round(balance * 100) / 100, 'paid')
  }

  function handleMarkDepositPaid() {
    const depositAmt = Math.round(grandTotal * 0.5 * 100) / 100
    handleAddPayment('Deposit', depositAmt, 'paid')
  }

  /* ── Payment method + Melio fee sub-form ─────────────────────── */

  function PaymentMethodFields({ row, onChange }: { row: PaymentRow; onChange: (r: PaymentRow) => void }) {
    const amt = Number(row.amount) || 0
    const fee = amt * MELIO_FEE_PCT
    return (
      <>
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-muted">Payment Method</span>
            <select
              value={row.payment_method_used}
              onChange={(e) => onChange({ ...row, payment_method_used: e.target.value, card_used: '', processing_fee: e.target.value === 'Melio' ? parseFloat((amt * MELIO_FEE_PCT).toFixed(2)) : 0 })}
              className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent"
            >
              <option value="">—</option>
              {ROW_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          {(row.payment_method_used === 'Credit Card' || row.payment_method_used === 'Melio') && (
            <CardUsedPicker value={row.card_used} onChange={(v) => onChange({ ...row, card_used: v })} />
          )}
        </div>
        {row.payment_method_used === 'Melio' && amt > 0 && (
          <div className="rounded-lg border border-border bg-surface/50 px-3 py-2">
            <div className="flex items-center gap-3 text-[13px]">
              <span className="text-muted">Melio Fee (2.9%):</span>
              <span className="font-mono font-semibold text-pink-400">+{fmt$(fee)}</span>
              <span className="text-muted/70">Total charged: <span className="font-mono text-text">{fmt$(amt + fee)}</span></span>
            </div>
          </div>
        )}
      </>
    )
  }

  /* ── Render ──────────────────────────────────────────────────── */

  const STATUS_BADGE: Record<string, 'gray' | 'amber' | 'green'> = {
    pending: 'gray',
    paid: 'green',
  }

  const PAYMENT_STATUS_BADGE: Record<string, 'gray' | 'amber' | 'green'> = {
    unpaid: 'gray',
    partial: 'amber',
    paid: 'green',
  }

  if (loadingPayments) {
    return (
      <div className="pt-1">
        <p className="text-[13px] text-muted">Loading payments...</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* ── Due Date row ────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-muted">Due Date</span>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent"
          />
        </label>
        <div className="flex items-end pb-0.5">
          {terms && orderDate && dueDate && (
            <span className="text-[13px] text-muted">
              {terms.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
              <span className="ml-1 text-text">
                — {new Date(dueDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            </span>
          )}
        </div>
      </div>

      {/* ── Summary bar ─────────────────────────────────────────── */}
      {grandTotal > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-surface/50 px-4 py-2.5 text-[13px]">
          <div className="flex items-center gap-4">
            <span className="text-muted">
              PO Total: <span className="font-mono font-medium text-text">{fmt$(grandTotal)}</span>
            </span>
            <span className="text-muted">
              Paid: <span className="font-mono font-medium" style={{ color: '#22C55E' }}>{fmt$(totalPaid)}</span>
            </span>
            <span className="text-muted">
              Balance: <span
                className="font-mono font-medium"
                style={{
                  color: dueDateUrgency === 'overdue' ? '#EF4444'
                    : dueDateUrgency === 'soon' ? '#F59E0B'
                    : balance > 0 ? '#F59E0B' : '#22C55E',
                }}
              >
                {fmt$(balance)}
                {dueDateUrgency === 'overdue' && <span className="ml-1 text-[12px]">(OVERDUE)</span>}
              </span>
            </span>
          </div>
          <Badge color={PAYMENT_STATUS_BADGE[paymentStatus] ?? 'gray'}>
            {paymentStatus === 'paid' ? '✓ Paid' : paymentStatus === 'partial' ? 'Partial' : 'Unpaid'}
          </Badge>
        </div>
      )}

      {/* ── Quick action buttons ────────────────────────────────── */}
      <div className="flex items-center gap-2">
        {grandTotal > 0 && activePayments.length === 0 && (
          <button
            type="button"
            onClick={handleMarkDepositPaid}
            className="rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:text-text hover:bg-hover"
          >
            + Mark Deposit Paid
          </button>
        )}
        {grandTotal > 0 && balance > 0 && (
          <button
            type="button"
            onClick={handleMarkFullyPaid}
            className="rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:text-text hover:bg-hover"
          >
            + Mark Fully Paid
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowAddForm(true)}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-accent/10"
        >
          <Plus size={13} /> Add Payment
        </button>
      </div>

      {/* ── Add payment form ────────────────────────────────────── */}
      {showAddForm && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 space-y-3">
          <p className="text-[13px] font-semibold text-text">New Payment</p>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted">Type</span>
              <select
                value={newPayment.payment_type}
                onChange={(e) => setNewPayment({ ...newPayment, payment_type: e.target.value })}
                className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent"
              >
                {PAYMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted">Amount</span>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[13px] text-muted">$</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={newPayment.amount}
                  onChange={(e) => setNewPayment({ ...newPayment, amount: e.target.value })}
                  placeholder="0.00"
                  className="w-full rounded border border-border bg-surface pl-6 pr-2 py-1 text-[13px] text-text font-mono text-right outline-none focus:border-accent"
                />
              </div>
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted">Payment Date</span>
              <input
                type="date"
                value={newPayment.payment_date}
                onChange={(e) => setNewPayment({ ...newPayment, payment_date: e.target.value })}
                className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent"
              />
            </label>
          </div>
          <PaymentMethodFields row={newPayment} onChange={setNewPayment} />
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted">Reference #</span>
              <input
                type="text"
                value={newPayment.reference_number}
                onChange={(e) => setNewPayment({ ...newPayment, reference_number: e.target.value })}
                placeholder="TXN-456"
                className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted">Status</span>
              <select
                value={newPayment.status}
                onChange={(e) => setNewPayment({ ...newPayment, status: e.target.value })}
                className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent"
              >
                <option value="pending">Pending</option>
                <option value="paid">Paid</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted">Notes</span>
              <input
                type="text"
                value={newPayment.notes}
                onChange={(e) => setNewPayment({ ...newPayment, notes: e.target.value })}
                placeholder="Optional..."
                className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text placeholder:text-muted/50 outline-none focus:border-accent"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setShowAddForm(false); setNewPayment(emptyPaymentRow()) }}
              className="rounded-lg border border-border px-3 py-1.5 text-[13px] text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveNewPayment}
              className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Save Payment
            </button>
          </div>
        </div>
      )}

      {/* ── Payment table ─────────────────────────────────────────  */}
      {activePayments.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border bg-surface/50 text-muted">
                <th className="px-3 py-2 text-left font-semibold">Type</th>
                <th className="px-3 py-2 text-right font-semibold">Amount</th>
                <th className="px-3 py-2 text-left font-semibold">Method</th>
                <th className="px-3 py-2 text-right font-semibold">Fee</th>
                <th className="px-3 py-2 text-left font-semibold">Date</th>
                <th className="px-3 py-2 text-left font-semibold">Reference</th>
                <th className="px-3 py-2 text-center font-semibold">Status</th>
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {activePayments.map((p, idx) => {
                const isEditing = editingIdx === idx

                if (isEditing && editRow) {
                  return (
                    <tr key={p.id ?? `edit-${idx}`} className="border-b border-border last:border-0 bg-accent/5">
                      <td className="px-2 py-1.5">
                        <select value={editRow.payment_type} onChange={(e) => setEditRow({ ...editRow, payment_type: e.target.value })} className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent">
                          {PAYMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" min="0" step="0.01" value={editRow.amount} onChange={(e) => setEditRow({ ...editRow, amount: e.target.value })} className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text text-right font-mono outline-none focus:border-accent" />
                      </td>
                      <td className="px-2 py-1.5">
                        <select value={editRow.payment_method_used} onChange={(e) => setEditRow({ ...editRow, payment_method_used: e.target.value, card_used: '' })} className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent">
                          <option value="">—</option>
                          {ROW_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-[12px] text-pink-400">
                        {editRow.payment_method_used === 'Melio' ? `+${fmt$(Number(editRow.amount) * MELIO_FEE_PCT)}` : '—'}
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="date" value={editRow.payment_date} onChange={(e) => setEditRow({ ...editRow, payment_date: e.target.value })} className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent" />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="text" value={editRow.reference_number} onChange={(e) => setEditRow({ ...editRow, reference_number: e.target.value })} className="w-full rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent" />
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <select value={editRow.status} onChange={(e) => setEditRow({ ...editRow, status: e.target.value })} className="rounded border border-border bg-surface px-2 py-1 text-[13px] text-text outline-none focus:border-accent">
                          <option value="pending">Pending</option>
                          <option value="paid">Paid</option>
                        </select>
                      </td>
                      <td className="px-1 py-1.5">
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={saveEdit} className="rounded p-1 text-accent transition-colors hover:bg-accent/10" title="Save"><Check size={13} /></button>
                          <button type="button" onClick={cancelEdit} className="rounded p-1 text-muted transition-colors hover:text-red-400" title="Cancel">✕</button>
                        </div>
                      </td>
                    </tr>
                  )
                }

                const fee = p.processing_fee || (p.payment_method_used === 'Melio' ? Number(p.amount) * MELIO_FEE_PCT : 0)
                return (
                  <tr key={p.id ?? `row-${idx}`} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 text-text">{p.payment_type}</td>
                    <td className="px-3 py-2 text-right font-mono font-medium text-text">{fmt$(Number(p.amount))}</td>
                    <td className="px-3 py-2 text-muted">
                      {p.payment_method_used || p.payment_method || '—'}
                      {(p.payment_method_used === 'Credit Card' || p.payment_method_used === 'Melio') && p.card_used && (
                        <span className="ml-1 text-[11px] text-muted/70">({p.card_used})</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[12px]">
                      {fee > 0 ? <span className="text-pink-400">+{fmt$(fee)}</span> : '—'}
                    </td>
                    <td className="px-3 py-2 text-muted">{p.payment_date ? fmtDate(p.payment_date) : '—'}</td>
                    <td className="px-3 py-2 text-muted font-mono">{p.reference_number || '—'}</td>
                    <td className="px-3 py-2 text-center">
                      <Badge color={STATUS_BADGE[p.status] ?? 'gray'}>
                        {p.status === 'paid' ? '✓ Paid' : 'Pending'}
                      </Badge>
                    </td>
                    <td className="px-1 py-2">
                      <div className="flex items-center gap-0.5">
                        {p.status === 'pending' && (
                          <button type="button" onClick={() => handleMarkPaid(p)} className="rounded p-1 text-muted transition-colors hover:text-green-400" title="Mark Paid"><Check size={13} /></button>
                        )}
                        <button type="button" onClick={() => startEdit(idx)} className="rounded p-1 text-muted transition-colors hover:text-accent" title="Edit">✎</button>
                        <button type="button" onClick={() => p.id && handleDeletePayment(p.id)} className="rounded p-1 text-muted transition-colors hover:text-red-400" title="Delete"><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
