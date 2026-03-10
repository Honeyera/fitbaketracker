import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Mail, Phone, Copy, Star, ExternalLink, UserPlus, Info } from 'lucide-react'
import { useToast } from './Toast'
import type { Supplier, SupplierContact } from '../types/database'

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  due_on_receipt: 'Due on Receipt', prepaid: 'Prepaid', wire: 'Wire Transfer',
  ach: 'ACH', check: 'Check', credit_card: 'Credit Card', melio: 'Melio',
  cash: 'Cash', net_15: 'Net 15', net_20: 'Net 20', net_30: 'Net 30',
  net_45: 'Net 45', net_60: 'Net 60', net_90: 'Net 90',
}

interface Props {
  supplier: Supplier
  contacts: SupplierContact[]
  poNumber?: string
  onViewSupplier?: () => void
  /** When true, render a small info icon instead of the supplier name text */
  triggerIcon?: boolean
}

export default function SupplierPopover({ supplier, contacts, poNumber, onViewSupplier, triggerIcon }: Props) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const toast = useToast()

  /* ── Position the panel ─────────────────────────────────── */

  useLayoutEffect(() => {
    if (!open || !panelRef.current || !triggerRef.current) return
    const trig = triggerRef.current.getBoundingClientRect()
    const panel = panelRef.current
    const pw = 320
    const ph = panel.offsetHeight
    const pad = 8
    const gap = 6

    // Vertical: prefer below, flip above if not enough room
    let top = trig.bottom + gap
    if (top + ph > window.innerHeight - pad) {
      top = trig.top - gap - ph
      if (top < pad) top = pad
    }

    // Horizontal: align left edge with trigger, clamp to viewport
    let left = trig.left
    if (left + pw > window.innerWidth - pad) left = window.innerWidth - pad - pw
    if (left < pad) left = pad

    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    panel.style.opacity = '1'
  }, [open])

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

  /* ── Derived data ───────────────────────────────────────── */

  const sorted = [...contacts].sort((a, b) => (a.is_primary === b.is_primary ? 0 : a.is_primary ? -1 : 1))
  const primary = sorted.find((c) => c.is_primary) ?? sorted[0] ?? null

  /* ── Actions ────────────────────────────────────────────── */

  function emailPrimary() {
    if (!primary?.email) return
    const subject = poNumber ? `Follow up: PO ${poNumber}` : 'Follow up'
    window.open(`mailto:${primary.email}?subject=${encodeURIComponent(subject)}`, '_self')
  }

  function copyPhone() {
    if (!primary?.phone) return
    navigator.clipboard.writeText(primary.phone).then(() => {
      toast.success('Copied!')
    })
  }

  function viewSupplier() {
    setOpen(false)
    onViewSupplier?.()
  }

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <>
      {triggerIcon ? (
        <button
          ref={triggerRef}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
          className="inline-flex items-center justify-center rounded p-0.5 cursor-pointer transition-colors hover:bg-hover-strong shrink-0"
          style={{ color: 'var(--color-brand)' }}
          title={`${supplier.name} contacts`}
        >
          <Info size={14} />
        </button>
      ) : (
        <button
          ref={triggerRef}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
          className="text-[14px] font-medium text-left cursor-pointer hover:underline"
          style={{ color: 'var(--color-brand)' }}
        >
          {supplier.name}
        </button>
      )}

      {open && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            zIndex: 50,
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
              <span className="font-semibold text-[14px] truncate">{supplier.name}</span>
              <button
                onClick={handleClose}
                className="rounded-lg p-1 text-muted transition-colors hover:bg-hover-strong hover:text-text shrink-0"
              >
                <X size={15} />
              </button>
            </div>

            <div className="mx-3 border-t border-border" />

            {/* Contacts */}
            <div className="px-4 py-2.5 space-y-3 max-h-[240px] overflow-y-auto">
              {sorted.length === 0 ? (
                <div className="text-center py-3">
                  <p className="text-muted text-[12px] mb-2">No contacts on file</p>
                  {onViewSupplier && (
                    <button
                      onClick={viewSupplier}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-hover"
                    >
                      <UserPlus size={13} /> Add Contact
                    </button>
                  )}
                </div>
              ) : sorted.map((c) => (
                <div key={c.id} className="space-y-0.5">
                  <div className="flex items-center gap-1.5 font-medium text-[13px]">
                    {c.is_primary && <Star size={12} className="text-amber-400 fill-amber-400 shrink-0" />}
                    <span className="truncate">{c.name}</span>
                    {c.is_primary && <span className="text-[10px] text-amber-400 font-semibold shrink-0">(Primary)</span>}
                  </div>
                  {c.email && (
                    <a
                      href={`mailto:${c.email}`}
                      className="flex items-center gap-1.5 text-[12px] text-accent hover:underline truncate"
                    >
                      <Mail size={11} className="shrink-0" />
                      {c.email}
                    </a>
                  )}
                  {c.phone && (
                    <div className="flex items-center gap-1.5 text-[12px] text-muted">
                      <Phone size={11} className="shrink-0" />
                      {c.phone}
                    </div>
                  )}
                  {c.role && (
                    <div className="text-[11px] text-muted">
                      Role: {c.role}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Supplier metadata */}
            {(supplier.lead_time_days != null || supplier.payment_terms || (supplier as any).default_payment_method || supplier.notes) && (
              <>
                <div className="mx-3 border-t border-border" />
                <div className="px-4 py-2 space-y-1 text-[12px] text-muted">
                  {supplier.lead_time_days != null && (
                    <div>Lead Time: <span className="text-text">{supplier.lead_time_days} day{supplier.lead_time_days !== 1 ? 's' : ''}</span></div>
                  )}
                  {supplier.payment_terms && (
                    <div>Payment Terms: <span className="text-text">{supplier.payment_terms}</span></div>
                  )}
                  {(supplier as any).default_payment_method && (
                    <div>Payment: <span className="text-text">
                      {PAYMENT_METHOD_LABELS[(supplier as any).default_payment_method] ?? (supplier as any).default_payment_method}
                      {(supplier as any).default_card_used && ` (${(supplier as any).default_card_used})`}
                    </span></div>
                  )}
                  {supplier.notes && (
                    <div>Notes: <span className="text-text">{supplier.notes}</span></div>
                  )}
                </div>
              </>
            )}

            {/* Action buttons */}
            <div className="mx-3 border-t border-border" />
            <div className="px-3 py-2.5 flex items-center gap-2 flex-wrap">
              {primary?.email && (
                <button
                  onClick={emailPrimary}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-text transition-colors hover:bg-hover"
                >
                  <Mail size={12} /> Email Primary
                </button>
              )}
              {primary?.phone && (
                <button
                  onClick={copyPhone}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-text transition-colors hover:bg-hover"
                >
                  <Copy size={12} /> Copy Phone
                </button>
              )}
              {onViewSupplier && (
                <button
                  onClick={viewSupplier}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-text transition-colors hover:bg-hover"
                >
                  <ExternalLink size={12} /> View Supplier
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
