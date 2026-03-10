import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Check } from 'lucide-react'
import { useToast } from './Toast'
import { dbInsert, dbUpdate } from '../lib/dbWrite'
import { sanitize } from '../lib/sanitizePayload'
import { fmt$ } from '../lib/format'
import CardUsedPicker from './CardUsedPicker'
import type { PurchaseOrder, ProductionRunInvoice, ProductionRunPayment } from '../types/database'

const MELIO_FEE_PCT = 0.029

const PAYMENT_METHODS = [
  { value: 'wire', label: 'Wire Transfer' },
  { value: 'ach', label: 'ACH' },
  { value: 'check', label: 'Check' },
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'melio', label: 'Melio' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
] as const

interface LinkedPO {
  id: string
  po_number: string
  supplier_name: string
  total_cost: number
  shipping_cost: number
  amount_paid: number
  payment_status: string
  payment_method: string | null
  payment_due_date: string | null
}

interface CPInvoiceSummary {
  invoiceNumber: string
  totalAmount: number
  totalPaid: number
  balance: number
  invoiceId: string
}

interface Props {
  orderNumber: string
  linkedPOs: LinkedPO[]
  cpInvoices: CPInvoiceSummary[]
  onDone: () => void
  children: React.ReactNode
}

export default function OrderPaymentPopover({
  orderNumber,
  linkedPOs,
  cpInvoices,
  onDone,
  children,
}: Props) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const toast = useToast()

  const [method, setMethod] = useState('wire')
  const [cardUsed, setCardUsed] = useState('')
  const [saving, setSaving] = useState(false)

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setMethod('wire')
      setCardUsed('')
      setSaving(false)
    }
  }, [open])

  /* ── Position the panel ─────────────────────────────────── */
  useLayoutEffect(() => {
    if (!open || !panelRef.current || !triggerRef.current) return
    const trig = triggerRef.current.getBoundingClientRect()
    const panel = panelRef.current
    const pw = 420
    const ph = panel.offsetHeight
    const pad = 8
    const gap = 6

    let top = trig.bottom + gap
    if (top + ph > window.innerHeight - pad) {
      top = trig.top - gap - ph
      if (top < pad) top = pad
    }

    let left = trig.left
    if (left + pw > window.innerWidth - pad) left = window.innerWidth - pad - pw
    if (left < pad) left = pad

    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    panel.style.opacity = '1'
  }, [open, saving])

  /* ── Close on click outside / Escape ────────────────────── */
  const handleClose = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  /* ── Aggregate totals ─────────────────────────────────── */
  const poSubtotal = linkedPOs.reduce((s, po) => s + po.total_cost, 0)
  const poShipping = linkedPOs.reduce((s, po) => s + po.shipping_cost, 0)
  const poTotal = poSubtotal + poShipping
  const poPaid = linkedPOs.reduce((s, po) => s + po.amount_paid, 0)
  const poBalance = Math.max(0, poTotal - poPaid)

  const cpTotal = cpInvoices.reduce((s, inv) => s + inv.totalAmount, 0)
  const cpPaid = cpInvoices.reduce((s, inv) => s + inv.totalPaid, 0)
  const cpBalance = Math.max(0, cpTotal - cpPaid)

  const unpaidPOs = linkedPOs.filter((po) => po.payment_status !== 'paid')
  const unpaidCPInvoices = cpInvoices.filter((inv) => inv.balance > 0)

  /* ── Mark single PO paid ─────────────────────────────── */
  async function markPOPaid(po: LinkedPO) {
    setSaving(true)
    try {
      const poGrandTotal = po.total_cost + po.shipping_cost
      const balance = Math.max(0, poGrandTotal - po.amount_paid)
      if (balance <= 0) return
      const fee = method === 'melio' ? parseFloat((balance * MELIO_FEE_PCT).toFixed(2)) : 0
      const today = new Date().toISOString().split('T')[0]

      const paymentPayload = sanitize('po_payments', {
        purchase_order_id: po.id,
        payment_type: 'full',
        amount: balance,
        payment_date: today,
        payment_method: method,
        card_used: method === 'credit_card' ? cardUsed : null,
        processing_fee: fee,
        status: 'paid',
      })
      const { error: payErr } = await dbInsert('po_payments', paymentPayload)
      if (payErr) throw new Error(payErr.message)

      const poPayload = sanitize('purchase_orders', {
        amount_paid: parseFloat(poGrandTotal.toFixed(2)),
        payment_status: 'paid',
        processing_fee: fee > 0 ? fee : undefined,
      })
      const { error: poErr } = await dbUpdate('purchase_orders', poPayload, 'id', po.id)
      if (poErr) throw new Error(poErr.message)

      toast.success(`PO ${po.po_number} marked as paid`)
      onDone()
    } catch (err: any) {
      toast.error(err.message || 'Payment failed')
    } finally {
      setSaving(false)
    }
  }

  /* ── Mark single CP invoice paid ────────────────────── */
  async function markCPInvoicePaid(inv: CPInvoiceSummary) {
    setSaving(true)
    try {
      if (inv.balance <= 0) return
      const fee = method === 'melio' ? parseFloat((inv.balance * MELIO_FEE_PCT).toFixed(2)) : 0
      const today = new Date().toISOString().split('T')[0]

      const paymentPayload = sanitize('production_run_payments', {
        invoice_id: inv.invoiceId,
        payment_type: 'full',
        amount: inv.balance,
        payment_date: today,
        payment_method: method,
        card_used: method === 'credit_card' ? cardUsed : null,
        processing_fee: fee,
      })
      const { error: payErr } = await dbInsert('production_run_payments', paymentPayload)
      if (payErr) throw new Error(payErr.message)

      toast.success(`Invoice ${inv.invoiceNumber} marked as paid`)
      onDone()
    } catch (err: any) {
      toast.error(err.message || 'Payment failed')
    } finally {
      setSaving(false)
    }
  }

  /* ── Mark all POs paid ──────────────────────────────── */
  async function markAllPOsPaid() {
    setSaving(true)
    try {
      const today = new Date().toISOString().split('T')[0]
      let count = 0

      for (const po of unpaidPOs) {
        const poGrandTotal = po.total_cost + po.shipping_cost
        const balance = Math.max(0, poGrandTotal - po.amount_paid)
        if (balance <= 0) continue
        const fee = method === 'melio' ? parseFloat((balance * MELIO_FEE_PCT).toFixed(2)) : 0

        const paymentPayload = sanitize('po_payments', {
          purchase_order_id: po.id,
          payment_type: 'full',
          amount: balance,
          payment_date: today,
          payment_method: method,
          card_used: method === 'credit_card' ? cardUsed : null,
          processing_fee: fee,
          status: 'paid',
        })
        const { error: payErr } = await dbInsert('po_payments', paymentPayload)
        if (payErr) throw new Error(payErr.message)

        const poPayload = sanitize('purchase_orders', {
          amount_paid: parseFloat(poGrandTotal.toFixed(2)),
          payment_status: 'paid',
          processing_fee: fee > 0 ? fee : undefined,
        })
        const { error: poErr } = await dbUpdate('purchase_orders', poPayload, 'id', po.id)
        if (poErr) throw new Error(poErr.message)

        count++
      }

      toast.success(`${count} PO${count !== 1 ? 's' : ''} marked as paid — total ${fmt$(poBalance)}`)
      setOpen(false)
      onDone()
    } catch (err: any) {
      toast.error(err.message || 'Payment failed')
    } finally {
      setSaving(false)
    }
  }

  /* ── Render ─────────────────────────────────────────────── */

  const hasNoPOs = linkedPOs.length === 0
  const hasCPInvoices = cpInvoices.length > 0
  const combinedBalance = poBalance + cpBalance

  return (
    <>
      <button
        ref={triggerRef}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        className="cursor-pointer"
      >
        {children}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            zIndex: 9999,
            width: 420,
            left: 0,
            top: 0,
            opacity: 0,
            transition: 'opacity 150ms ease',
          }}
        >
          <div
            style={{
              background: 'var(--color-card)',
              border: '1px solid var(--color-border)',
              borderRadius: 12,
              boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
              color: 'var(--color-text)',
              fontSize: 13,
              lineHeight: 1.5,
              maxHeight: 'calc(100vh - 32px)',
              overflowY: 'auto',
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <span className="font-semibold text-[14px] truncate">
                {orderNumber} Payments
              </span>
              <button
                onClick={handleClose}
                className="rounded-lg p-1 text-muted transition-colors hover:bg-hover-strong hover:text-text shrink-0"
              >
                <X size={15} />
              </button>
            </div>

            {hasNoPOs && !hasCPInvoices ? (
              <div className="px-4 pb-4 pt-1 text-[13px] text-muted">No linked POs or invoices</div>
            ) : (
              <>
                {/* PO Summary */}
                {linkedPOs.length > 0 && (
                  <>
                    <div className="mx-3 border-t border-border" />
                    <div className="px-4 py-2.5 space-y-1.5">
                      <div className="flex justify-between text-[13px]">
                        <span className="text-muted">Total across {linkedPOs.length} PO{linkedPOs.length !== 1 ? 's' : ''}</span>
                        <span className="font-mono font-semibold">{fmt$(poTotal)}</span>
                      </div>
                      <div className="flex gap-3 text-[13px]">
                        <span className="text-muted">Paid: <span className="font-mono text-text">{fmt$(poPaid)}</span></span>
                        <span className="text-muted">Balance: <span className="font-mono text-red-400">{fmt$(poBalance)}</span></span>
                      </div>
                    </div>

                    {/* Per-PO rows */}
                    <div className="mx-3 border-t border-border" />
                    <div className="px-4 py-2 space-y-1.5">
                      {linkedPOs.map((po) => {
                        const poGT = po.total_cost + po.shipping_cost
                        const bal = Math.max(0, poGT - po.amount_paid)
                        const isPaid = po.payment_status === 'paid'
                        const isOverdue = !isPaid && po.payment_due_date && new Date(po.payment_due_date + 'T00:00:00') < new Date()
                        return (
                          <div key={po.id} className="flex items-center gap-2 text-[12px] py-1 rounded-lg px-2 hover:bg-hover/50">
                            <span className="font-mono font-medium text-accent shrink-0">{po.po_number}</span>
                            <span className="text-muted truncate flex-1">{po.supplier_name}</span>
                            <span className="font-mono shrink-0">
                              {fmt$(poGT)}
                              {po.shipping_cost > 0 && <span className="text-muted text-[10px] ml-0.5">(+{fmt$(po.shipping_cost)} ship)</span>}
                            </span>
                            {isPaid ? (
                              <span className="text-emerald-400 font-medium shrink-0 w-[72px] text-right">Paid ✓</span>
                            ) : (
                              <>
                                {po.amount_paid > 0 && (
                                  <span className="text-amber-400 shrink-0">{fmt$(po.amount_paid)} paid</span>
                                )}
                                {isOverdue && (
                                  <span className="text-red-400 text-[11px] shrink-0">Overdue</span>
                                )}
                                <button
                                  onClick={() => markPOPaid(po)}
                                  disabled={saving}
                                  className="shrink-0 inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] font-medium text-text transition-colors hover:bg-hover disabled:opacity-40"
                                >
                                  <Check size={11} className="text-emerald-400" /> Mark Paid
                                </button>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>

                    {/* Mark All Paid button */}
                    {unpaidPOs.length > 1 && (
                      <>
                        <div className="mx-3 border-t border-border" />
                        <div className="px-4 py-2">
                          <button
                            onClick={markAllPOsPaid}
                            disabled={saving}
                            className="w-full flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-text transition-colors hover:bg-hover disabled:opacity-40"
                          >
                            <Check size={14} className="text-emerald-400" /> Mark All Paid ({unpaidPOs.length} POs)
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* CP Invoices */}
                {hasCPInvoices && (
                  <>
                    <div className="mx-3 border-t border-border" />
                    <div className="px-4 py-2.5 space-y-1.5">
                      <div className="text-[12px] text-muted font-medium uppercase tracking-wider">CP Invoices</div>
                      {cpInvoices.map((inv) => {
                        const isPaid = inv.balance <= 0
                        return (
                          <div key={inv.invoiceId} className="flex items-center gap-2 text-[12px] py-1 rounded-lg px-2 hover:bg-hover/50">
                            <span className="font-mono font-medium text-accent shrink-0">{inv.invoiceNumber}</span>
                            <span className="font-mono text-muted shrink-0">{fmt$(inv.totalAmount)}</span>
                            {isPaid ? (
                              <span className="text-emerald-400 font-medium shrink-0 ml-auto">Paid ✓</span>
                            ) : (
                              <>
                                {inv.totalPaid > 0 && (
                                  <span className="text-amber-400 shrink-0">{fmt$(inv.totalPaid)} paid</span>
                                )}
                                <span className="text-muted flex-1 text-right">Bal: {fmt$(inv.balance)}</span>
                                <button
                                  onClick={() => markCPInvoicePaid(inv)}
                                  disabled={saving}
                                  className="shrink-0 inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] font-medium text-text transition-colors hover:bg-hover disabled:opacity-40"
                                >
                                  <Check size={11} className="text-emerald-400" /> Mark Paid
                                </button>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}

                {/* Combined outstanding */}
                {linkedPOs.length > 0 && hasCPInvoices && combinedBalance > 0 && (
                  <>
                    <div className="mx-3 border-t border-border" />
                    <div className="px-4 py-2.5 space-y-1 text-[12px]">
                      <div className="font-medium text-muted uppercase tracking-wider">Total Outstanding</div>
                      <div className="flex justify-between">
                        <span className="text-muted">Supplier POs</span>
                        <span className="font-mono text-text">{fmt$(poBalance)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted">CP Invoices</span>
                        <span className="font-mono text-text">{fmt$(cpBalance)}</span>
                      </div>
                      <div className="flex justify-between font-semibold pt-1 border-t border-border">
                        <span className="text-muted">Combined</span>
                        <span className="font-mono text-red-400">{fmt$(combinedBalance)}</span>
                      </div>
                    </div>
                  </>
                )}

                {/* Payment Method */}
                {(unpaidPOs.length > 0 || unpaidCPInvoices.length > 0) && (
                  <>
                    <div className="mx-3 border-t border-border" />
                    <div className="px-4 py-2.5">
                      <div className="text-[11px] text-muted font-medium mb-1">Payment Method</div>
                      <select
                        value={method}
                        onChange={(e) => setMethod(e.target.value)}
                        className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[13px] text-text outline-none focus:border-accent"
                      >
                        {PAYMENT_METHODS.map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                      {method === 'credit_card' && (
                        <div className="mt-1.5">
                          <CardUsedPicker value={cardUsed} onChange={setCardUsed} />
                        </div>
                      )}
                      {method === 'melio' && (
                        <div className="mt-1.5 text-[12px] font-medium" style={{ color: '#E91E7B' }}>
                          Fee (2.9%): +{fmt$(combinedBalance * MELIO_FEE_PCT)}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

/* ── Helper to build linked PO data for the popover ──────── */

export function buildLinkedPOs(
  productionOrderId: string,
  purchaseOrders: PurchaseOrder[],
  suppliers: { id: string; name: string }[],
): LinkedPO[] {
  return purchaseOrders
    .filter((po) => po.production_order_id === productionOrderId)
    .map((po) => {
      const sup = suppliers.find((s) => s.id === po.supplier_id)
      return {
        id: po.id,
        po_number: po.po_number,
        supplier_name: sup?.name ?? '—',
        total_cost: po.total_cost ?? 0,
        shipping_cost: (po as any).shipping_cost ?? 0,
        amount_paid: (po as any).amount_paid ?? 0,
        payment_status: (po as any).payment_status || 'unpaid',
        payment_method: po.payment_method ?? null,
        payment_due_date: (po as any).payment_due_date ?? null,
      }
    })
}

export function buildCPInvoiceSummaries(
  productionOrderId: string,
  invoices: ProductionRunInvoice[],
  payments: ProductionRunPayment[],
): CPInvoiceSummary[] {
  return invoices
    .filter((inv) => inv.production_order_id === productionOrderId)
    .map((inv) => {
      const invPayments = payments.filter((p) => p.invoice_id === inv.id)
      const totalPaid = invPayments.reduce((s, p) => s + Number(p.amount), 0)
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number ?? `INV-${inv.id.slice(0, 6)}`,
        totalAmount: Number(inv.total_amount),
        totalPaid,
        balance: Math.max(0, Number(inv.total_amount) - totalPaid),
      }
    })
}

export function getOrderPOPaymentSummary(
  productionOrderId: string,
  purchaseOrders: PurchaseOrder[],
) {
  const linked = purchaseOrders.filter((po) => po.production_order_id === productionOrderId)
  if (linked.length === 0) return { status: 'no_pos' as const, total: 0, paid: 0, balance: 0, hasOverdue: false, poCount: 0 }

  const total = linked.reduce((s, po) => s + (po.total_cost ?? 0) + ((po as any).shipping_cost ?? 0), 0)
  const paid = linked.reduce((s, po) => s + ((po as any).amount_paid ?? 0), 0)
  const balance = Math.max(0, total - paid)

  let status: 'unpaid' | 'partial' | 'paid' = 'unpaid'
  if (paid >= total && total > 0) status = 'paid'
  else if (paid > 0) status = 'partial'

  const hasOverdue = linked.some((po) => {
    const dueDate = (po as any).payment_due_date
    return dueDate && new Date(dueDate + 'T00:00:00') < new Date() && (po as any).payment_status !== 'paid'
  })

  return { status, total, paid, balance, hasOverdue, poCount: linked.length }
}
