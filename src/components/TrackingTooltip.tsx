import { useState, useRef, useLayoutEffect, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink } from 'lucide-react'
import { useToast } from './Toast'
import { fmt$, fmtDate } from '../lib/format'

/* ── Tracking URL builders ─────────────────────────────── */

const CARRIER_URLS: Record<string, (t: string) => string> = {
  fedex: (t) => `https://www.fedex.com/fedextrack/?trknbr=${t}`,
  ups: (t) => `https://www.ups.com/track?tracknum=${t}`,
  usps: (t) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`,
}

function getTrackingUrl(carrier: string | null, tracking: string): string | null {
  if (!carrier) return null
  const key = carrier.toLowerCase()
  for (const [name, builder] of Object.entries(CARRIER_URLS)) {
    if (key.includes(name)) return builder(tracking)
  }
  return null
}

/* ── Status icons ───────────────────────────────────────── */

const STATUS_ICON: Record<string, string> = {
  draft: '📋',
  ordered: '📋',
  in_transit: '🚚',
  received: '✅',
  confirmed: '✅',
  cancelled: '❌',
}

/* ── Types ──────────────────────────────────────────────── */

export interface ShipmentInfo {
  id: string
  source: 'po' | 'shipment'
  label: string           // PO#1006 or SH-005
  supplierName: string
  carrier: string | null
  method: string | null
  tracking: string | null
  shipDate: string | null
  eta: string | null
  receivedDate: string | null
  status: string
  shippingCost: number | null
}

interface Props {
  shipments: ShipmentInfo[]
  children: React.ReactNode
}

export default function TrackingTooltip({ shipments, children }: Props) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toast = useToast()

  function handleEnter() {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setOpen(true), 300)
  }

  function handleLeave() {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setOpen(false), 150)
  }

  // Keep tooltip open if mouse enters the panel
  function handlePanelEnter() {
    if (timerRef.current) clearTimeout(timerRef.current)
  }
  function handlePanelLeave() {
    timerRef.current = setTimeout(() => setOpen(false), 150)
  }

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  /* ── Position ───────────────────────────────────────────── */
  useLayoutEffect(() => {
    if (!open || !panelRef.current || !triggerRef.current) return
    const trig = triggerRef.current.getBoundingClientRect()
    const panel = panelRef.current
    const pw = 340
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
  }, [open])

  /* ── Close on Escape ────────────────────────────────────── */
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  /* ── Tracking click handler ─────────────────────────────── */
  function handleTrackingClick(carrier: string | null, tracking: string) {
    const url = getTrackingUrl(carrier, tracking)
    if (url) {
      window.open(url, '_blank', 'noopener')
    } else {
      navigator.clipboard.writeText(tracking).then(() => {
        toast.success('Tracking number copied')
      })
    }
  }

  /* ── Render tracking number ─────────────────────────────── */
  function renderTracking(carrier: string | null, tracking: string) {
    const url = getTrackingUrl(carrier, tracking)
    return (
      <button
        onClick={(e) => { e.stopPropagation(); handleTrackingClick(carrier, tracking) }}
        className="inline-flex items-center gap-1 font-mono text-accent hover:underline cursor-pointer"
        title={url ? 'Open tracking' : 'Copy tracking number'}
      >
        {tracking}
        {url && <ExternalLink size={10} className="shrink-0" />}
      </button>
    )
  }

  const single = shipments.length === 1
  const totalShipping = shipments.reduce((s, sh) => s + (sh.shippingCost ?? 0), 0)

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        className="cursor-default"
      >
        {children}
      </span>

      {open && createPortal(
        <div
          ref={panelRef}
          onMouseEnter={handlePanelEnter}
          onMouseLeave={handlePanelLeave}
          style={{
            position: 'fixed',
            zIndex: 9999,
            width: 340,
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
            <div className="px-4 pt-3 pb-2 font-semibold text-[14px]">
              📦 {single ? 'Shipment Details' : `${shipments.length} Shipments`}
            </div>
            <div className="mx-3 border-t border-border" />

            {single ? (
              /* ── Single shipment detail ────────────── */
              <div className="px-4 py-2.5 space-y-1.5 text-[13px]">
                <div className="flex justify-between">
                  <span className="text-muted">{shipments[0].source === 'po' ? 'PO' : 'Shipment'}</span>
                  <span className="font-mono font-medium text-accent">{shipments[0].label}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Supplier</span>
                  <span className="text-text">{shipments[0].supplierName}</span>
                </div>
                {shipments[0].carrier && (
                  <div className="flex justify-between">
                    <span className="text-muted">Carrier</span>
                    <span className="text-text">{shipments[0].carrier}</span>
                  </div>
                )}
                {shipments[0].method && (
                  <div className="flex justify-between">
                    <span className="text-muted">Method</span>
                    <span className="text-text">{shipments[0].method}</span>
                  </div>
                )}
                {shipments[0].tracking && (
                  <div className="flex justify-between">
                    <span className="text-muted">Tracking</span>
                    {renderTracking(shipments[0].carrier, shipments[0].tracking)}
                  </div>
                )}
                {shipments[0].shipDate && (
                  <div className="flex justify-between">
                    <span className="text-muted">Ship Date</span>
                    <span className="text-text">{fmtDate(shipments[0].shipDate)}</span>
                  </div>
                )}
                {shipments[0].eta && (
                  <div className="flex justify-between">
                    <span className="text-muted">ETA</span>
                    <span className="text-text">{fmtDate(shipments[0].eta)}</span>
                  </div>
                )}
                {shipments[0].receivedDate && (
                  <div className="flex justify-between">
                    <span className="text-muted">Received</span>
                    <span className="text-text">{fmtDate(shipments[0].receivedDate)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted">Status</span>
                  <span className="text-text">{STATUS_ICON[shipments[0].status] ?? ''} {formatStatus(shipments[0].status)}</span>
                </div>
                {shipments[0].shippingCost != null && shipments[0].shippingCost > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted">Shipping Cost</span>
                    <span className="font-mono text-text">{fmt$(shipments[0].shippingCost)}</span>
                  </div>
                )}
              </div>
            ) : (
              /* ── Multiple shipments ────────────────── */
              <div className="px-4 py-2.5 space-y-3">
                {shipments.map((sh, i) => (
                  <div key={sh.id} className="space-y-0.5">
                    <div className="flex items-center gap-2 text-[13px]">
                      <span className="text-muted">{i + 1}.</span>
                      <span className="font-mono font-medium text-accent">{sh.label}</span>
                      <span className="text-muted">—</span>
                      <span className="text-muted truncate">{sh.supplierName}</span>
                    </div>
                    <div className="ml-4 text-[12px] text-muted space-y-0.5">
                      {sh.carrier && (
                        <div>
                          Carrier: <span className="text-text">{sh.carrier}</span>
                          {sh.tracking && (
                            <> | Track: {renderTracking(sh.carrier, sh.tracking)}</>
                          )}
                        </div>
                      )}
                      {!sh.carrier && sh.tracking && (
                        <div>Track: {renderTracking(sh.carrier, sh.tracking)}</div>
                      )}
                      <div>
                        Status: <span className="text-text">{STATUS_ICON[sh.status] ?? ''} {formatStatus(sh.status)}</span>
                        {sh.receivedDate && <> | {fmtDate(sh.receivedDate)}</>}
                        {!sh.receivedDate && sh.eta && <> | ETA {fmtDate(sh.eta)}</>}
                        {!sh.receivedDate && !sh.eta && sh.shipDate && <> | Shipped {fmtDate(sh.shipDate)}</>}
                      </div>
                    </div>
                    {i < shipments.length - 1 && <div className="border-t border-border/50 mt-2" />}
                  </div>
                ))}
                {totalShipping > 0 && (
                  <>
                    <div className="border-t border-border" />
                    <div className="flex justify-between text-[13px]">
                      <span className="text-muted">Total Shipping</span>
                      <span className="font-mono font-semibold text-text">{fmt$(totalShipping)}</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function formatStatus(s: string): string {
  if (s === 'in_transit') return 'In Transit'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/* ── Helper to build shipment info from POs and shipments ── */

export function buildOrderShipments(
  orderId: string,
  purchaseOrders: { id: string; production_order_id: string | null; po_number: string; tracking_number: string | null; shipping_carrier: string | null; shipping_method: string | null; shipping_cost: number | null; eta_date: string | null; order_date: string | null; status: string | null; supplier_id: string | null }[],
  shipmentsList: { id: string; production_order_id: string | null; purchase_order_id: string | null; shipment_number: string; tracking_number: string | null; carrier: string | null; shipping_cost: number | null; ship_date: string | null; received_date: string | null; status: string | null; supplier_id: string | null }[],
  suppliers: { id: string; name: string }[],
): ShipmentInfo[] {
  const result: ShipmentInfo[] = []
  const seenIds = new Set<string>()

  // POs linked to this production order
  const linkedPOs = purchaseOrders.filter((po) => po.production_order_id === orderId)
  const linkedPOIds = new Set(linkedPOs.map((po) => po.id))

  // Shipments linked to this order (directly or via PO)
  const linkedShipments = shipmentsList.filter(
    (s) => s.production_order_id === orderId || (s.purchase_order_id && linkedPOIds.has(s.purchase_order_id)),
  )

  // Add shipment records first (they're more specific)
  for (const s of linkedShipments) {
    seenIds.add(s.id)
    const sup = s.supplier_id ? suppliers.find((sp) => sp.id === s.supplier_id) : null
    // If no direct supplier, try via linked PO
    let supplierName = sup?.name ?? ''
    if (!supplierName && s.purchase_order_id) {
      const po = purchaseOrders.find((p) => p.id === s.purchase_order_id)
      if (po?.supplier_id) {
        supplierName = suppliers.find((sp) => sp.id === po.supplier_id)?.name ?? ''
      }
    }

    result.push({
      id: s.id,
      source: 'shipment',
      label: s.shipment_number,
      supplierName: supplierName || '—',
      carrier: s.carrier,
      method: null,
      tracking: s.tracking_number,
      shipDate: s.ship_date,
      eta: null,
      receivedDate: s.received_date,
      status: s.status ?? 'ordered',
      shippingCost: s.shipping_cost,
    })
  }

  // Add POs that have tracking but no corresponding shipment record
  for (const po of linkedPOs) {
    if (po.tracking_number) {
      // Check if a shipment already covers this PO
      const hasShipment = linkedShipments.some((s) => s.purchase_order_id === po.id)
      if (!hasShipment) {
        const sup = po.supplier_id ? suppliers.find((sp) => sp.id === po.supplier_id) : null
        result.push({
          id: po.id,
          source: 'po',
          label: po.po_number,
          supplierName: sup?.name ?? '—',
          carrier: po.shipping_carrier,
          method: po.shipping_method,
          tracking: po.tracking_number,
          shipDate: null,
          eta: po.eta_date,
          receivedDate: null,
          status: po.status ?? 'draft',
          shippingCost: po.shipping_cost,
        })
      }
    }
  }

  return result
}
