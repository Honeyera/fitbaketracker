import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Check, DollarSign, FileText, Undo2 } from 'lucide-react'
import { useToast } from './Toast'
import { dbInsert, dbUpdate, dbDelete } from '../lib/dbWrite'
import { sanitize } from '../lib/sanitizePayload'
import { supabase } from '../lib/supabase'
import { fmt$ } from '../lib/format'
import CardUsedPicker from './CardUsedPicker'

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

interface Props {
  poId: string
  poNumber: string
  supplierName: string
  subtotal: number
  shippingCost: number
  amountPaid: number
  paymentStatus: string
  paymentMethod: string | null
  onDone: () => void
  children: React.ReactNode
}

export default function PaymentPopover({
  poId,
  poNumber,
  supplierName,
  subtotal,
  shippingCost,
  amountPaid,
  paymentStatus,
  paymentMethod,
  onDone,
  children,
}: Props) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const toast = useToast()

  const [mode, setMode] = useState<'actions' | 'deposit' | 'partial'>('actions')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState(paymentMethod || 'wire')
  const [cardUsed, setCardUsed] = useState('')
  const [saving, setSaving] = useState(false)

  // For paid POs - fetch last payment info
  const [lastPayment, setLastPayment] = useState<any>(null)

  const grandTotal = subtotal + shippingCost
  const balance = Math.max(0, grandTotal - amountPaid)
  const isPaid = paymentStatus === 'paid'

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setMode('actions')
      setAmount('')
      setMethod(paymentMethod || 'wire')
      setCardUsed('')
      setSaving(false)
      if (isPaid) {
        supabase
          .from('po_payments')
          .select('*')
          .eq('purchase_order_id', poId)
          .order('created_at', { ascending: false })
          .limit(1)
          .then(({ data }) => setLastPayment(data?.[0] ?? null))
      }
    }
  }, [open, poId, isPaid, paymentMethod])

  /* ── Position the panel ─────────────────────────────────── */
  useLayoutEffect(() => {
    if (!open || !panelRef.current || !triggerRef.current) return
    const trig = triggerRef.current.getBoundingClientRect()
    const panel = panelRef.current
    const pw = 320
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
  }, [open, mode, amount])

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

  /* ── Payment actions ────────────────────────────────────── */

  const melioFee = method === 'melio' ? parseFloat((balance * MELIO_FEE_PCT).toFixed(2)) : 0

  async function recordPayment(paymentAmount: number, paymentType: string) {
    setSaving(true)
    try {
      const fee = method === 'melio' ? parseFloat((paymentAmount * MELIO_FEE_PCT).toFixed(2)) : 0
      const today = new Date().toISOString().split('T')[0]

      const paymentPayload = sanitize('po_payments', {
        purchase_order_id: poId,
        payment_type: paymentType,
        amount: paymentAmount,
        payment_date: today,
        payment_method: method,
        card_used: (method === 'credit_card' || method === 'melio') ? cardUsed : null,
        processing_fee: fee,
        status: 'paid',
      })

      const { error: payErr } = await dbInsert('po_payments', paymentPayload)
      if (payErr) throw new Error(payErr.message)

      const newAmountPaid = amountPaid + paymentAmount
      const newStatus = newAmountPaid >= grandTotal ? 'paid' : 'partial'

      const poPayload = sanitize('purchase_orders', {
        amount_paid: parseFloat(newAmountPaid.toFixed(2)),
        payment_status: newStatus,
        processing_fee: fee > 0 ? fee : undefined,
      })

      const { error: poErr } = await dbUpdate('purchase_orders', poPayload, 'id', poId)
      if (poErr) throw new Error(poErr.message)

      const label = paymentType === 'full' ? 'marked as paid' : paymentType === 'deposit' ? `Deposit of ${fmt$(paymentAmount)} recorded` : `Payment of ${fmt$(paymentAmount)} recorded`
      toast.success(paymentType === 'full' ? `PO ${poNumber} marked as paid` : label)

      setOpen(false)
      onDone()
    } catch (err: any) {
      toast.error(err.message || 'Payment failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleMarkFullyPaid() {
    await recordPayment(balance, 'full')
  }

  async function handleRecordDeposit() {
    const val = parseFloat(amount)
    if (!val || val <= 0 || val > balance) {
      toast.error('Enter a valid amount')
      return
    }
    await recordPayment(val, 'deposit')
  }

  async function handleRecordPartial() {
    const val = parseFloat(amount)
    if (!val || val <= 0 || val > balance) {
      toast.error('Enter a valid amount')
      return
    }
    await recordPayment(val, 'partial')
  }

  async function handleUndoPayment() {
    if (!lastPayment) return
    setSaving(true)
    try {
      const { error: delErr } = await dbDelete('po_payments', 'id', lastPayment.id)
      if (delErr) throw new Error(delErr.message)

      const undoneAmount = lastPayment.amount as number
      const newAmountPaid = Math.max(0, amountPaid - undoneAmount)
      const newStatus = newAmountPaid <= 0 ? 'unpaid' : newAmountPaid >= grandTotal ? 'paid' : 'partial'

      const poPayload = sanitize('purchase_orders', {
        amount_paid: parseFloat(newAmountPaid.toFixed(2)),
        payment_status: newStatus,
      })

      const { error: poErr } = await dbUpdate('purchase_orders', poPayload, 'id', poId)
      if (poErr) throw new Error(poErr.message)

      toast.success(`Payment of ${fmt$(undoneAmount)} undone`)
      setOpen(false)
      onDone()
    } catch (err: any) {
      toast.error(err.message || 'Undo failed')
    } finally {
      setSaving(false)
    }
  }

  /* ── Render ─────────────────────────────────────────────── */

  const methodLabel = PAYMENT_METHODS.find((m) => m.value === method)?.label ?? method

  return (
    <>
      <button
        ref={triggerRef}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        className="cursor-pointer w-full"
      >
        {children}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            zIndex: 9999,
            width: 320,
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
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <span className="font-semibold text-[14px] truncate">
                PO {poNumber} — {supplierName}
              </span>
              <button
                onClick={handleClose}
                className="rounded-lg p-1 text-muted transition-colors hover:bg-hover-strong hover:text-text shrink-0"
              >
                <X size={15} />
              </button>
            </div>

            <div className="mx-3 border-t border-border" />

            {isPaid ? (
              /* ── Paid view ─────────────────────────── */
              <div className="px-4 py-3 space-y-2">
                <div className="flex justify-between text-[13px]">
                  <span className="text-muted">Subtotal</span>
                  <span className="font-mono">{fmt$(subtotal)}</span>
                </div>
                {shippingCost > 0 && (
                  <div className="flex justify-between text-[13px]">
                    <span className="text-muted">Shipping</span>
                    <span className="font-mono">{fmt$(shippingCost)}</span>
                  </div>
                )}
                <div className="flex justify-between text-[13px] font-semibold">
                  <span className="text-muted">Grand Total</span>
                  <span className="font-mono">{fmt$(grandTotal)}</span>
                </div>
                <div className="flex items-center gap-2 text-emerald-400 font-medium text-[14px]">
                  <Check size={16} /> Fully Paid
                </div>
                {lastPayment && (
                  <>
                    <div className="text-[12px] text-muted">
                      Paid on: {lastPayment.payment_date ? new Date(lastPayment.payment_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                    </div>
                    <div className="text-[12px] text-muted">
                      Method: {PAYMENT_METHODS.find((m) => m.value === lastPayment.payment_method)?.label ?? lastPayment.payment_method ?? '—'}
                    </div>
                  </>
                )}
                <div className="mx-0 border-t border-border mt-2 pt-2">
                  <button
                    onClick={handleUndoPayment}
                    disabled={saving || !lastPayment}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium text-text transition-colors hover:bg-hover disabled:opacity-40"
                  >
                    <Undo2 size={13} /> Undo Payment
                  </button>
                </div>
              </div>
            ) : (
              /* ── Unpaid / Partial view ─────────────── */
              <div className="px-4 py-3 space-y-2">
                {/* Summary */}
                <div className="flex justify-between text-[13px]">
                  <span className="text-muted">Subtotal</span>
                  <span className="font-mono">{fmt$(subtotal)}</span>
                </div>
                {shippingCost > 0 && (
                  <div className="flex justify-between text-[13px]">
                    <span className="text-muted">Shipping</span>
                    <span className="font-mono">{fmt$(shippingCost)}</span>
                  </div>
                )}
                <div className="flex justify-between text-[13px] font-semibold">
                  <span className="text-muted">Grand Total</span>
                  <span className="font-mono">{fmt$(grandTotal)}</span>
                </div>
                <div className="border-t border-border my-1" />
                <div className="flex justify-between text-[13px]">
                  <span className="text-muted">Paid</span>
                  <span className="font-mono">{fmt$(amountPaid)}</span>
                </div>
                <div className="flex justify-between text-[13px] font-semibold">
                  <span className="text-muted">Balance</span>
                  <span className="font-mono text-red-400">{fmt$(balance)}</span>
                </div>

                <div className="border-t border-border my-2" />

                {mode === 'actions' && (
                  <>
                    <div className="text-[12px] text-muted font-medium mb-1.5">Quick Actions</div>
                    <div className="space-y-1.5">
                      <button
                        onClick={handleMarkFullyPaid}
                        disabled={saving}
                        className="w-full flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-text transition-colors hover:bg-hover disabled:opacity-40"
                      >
                        <Check size={14} className="text-emerald-400" /> Mark Fully Paid
                      </button>
                      <button
                        onClick={() => { setMode('deposit'); setAmount((balance * 0.5).toFixed(2)) }}
                        disabled={saving}
                        className="w-full flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-text transition-colors hover:bg-hover disabled:opacity-40"
                      >
                        <DollarSign size={14} className="text-amber-400" /> Record Deposit
                      </button>
                      <button
                        onClick={() => { setMode('partial'); setAmount('') }}
                        disabled={saving}
                        className="w-full flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-text transition-colors hover:bg-hover disabled:opacity-40"
                      >
                        <FileText size={14} className="text-blue-400" /> Record Partial Payment
                      </button>
                    </div>
                  </>
                )}

                {(mode === 'deposit' || mode === 'partial') && (
                  <>
                    <div className="text-[12px] text-muted font-medium mb-1">
                      {mode === 'deposit' ? 'Deposit Amount' : 'Payment Amount'}
                    </div>
                    <div className="relative">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-[13px]">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        max={balance}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        autoFocus
                        className="w-full rounded-lg border border-border bg-surface pl-6 pr-3 py-1.5 text-[14px] font-mono text-text outline-none focus:border-accent"
                        placeholder="0.00"
                      />
                    </div>
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={mode === 'deposit' ? handleRecordDeposit : handleRecordPartial}
                        disabled={saving || !amount || parseFloat(amount) <= 0}
                        className="flex-1 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
                      >
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        onClick={() => setMode('actions')}
                        className="rounded-lg border border-border px-3 py-1.5 text-[13px] text-muted transition-colors hover:text-text hover:bg-hover"
                      >
                        Back
                      </button>
                    </div>
                  </>
                )}

                {/* Payment Method selector */}
                <div className="border-t border-border my-2 pt-2">
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
                  {(method === 'credit_card' || method === 'melio') && (
                    <div className="mt-1.5">
                      <CardUsedPicker value={cardUsed} onChange={setCardUsed} />
                    </div>
                  )}
                  {method === 'melio' && (
                    <div className="mt-1.5 text-[12px] font-medium" style={{ color: '#E91E7B' }}>
                      Fee (2.9%): +{fmt$(mode === 'deposit' || mode === 'partial' ? parseFloat(amount || '0') * MELIO_FEE_PCT : melioFee)}
                    </div>
                  )}
                </div>

                {/* Cancel */}
                <div className="pt-1">
                  <button
                    onClick={handleClose}
                    className="w-full rounded-lg border border-border px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-text hover:bg-hover"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
