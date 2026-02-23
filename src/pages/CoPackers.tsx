import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { sanitize } from '../lib/sanitizePayload'
import { dbInsert, dbInsertSingle, dbUpdate, dbDelete, dbDeleteIn } from '../lib/dbWrite'
import { safeBatch } from '../lib/safeQuery'
import { safeLoad } from '../lib/safeLoad'
import { invalidateCPCache } from '../components/CPBadge'
import { useToast } from '../components/Toast'
import { useAuth } from '../contexts/AuthContext'
import { logActivity } from '../lib/activityLog'
import PageHeader from '../components/PageHeader'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import MiniBar from '../components/MiniBar'
import { PageSkeleton } from '../components/Skeleton'
import ConfirmDialog from '../components/ConfirmDialog'
import { fmtRate } from '../lib/format'
import { Plus, Mail, Phone, MapPin, Pencil, Factory, Trash2, X, Clock } from 'lucide-react'
import type { CoPacker, CoPackerInsert, CoPackerContact, Recipe, ProductionRun, FulfillmentCenter, FulfillmentCenterInsert } from '../types/database'

interface CPStats {
  totalRuns: number
  totalProduced: number
  avgWaste: number | null
}

const CONTACT_ROLES = [
  'Production Manager', 'Account Manager', 'Shipping', 'Owner',
  'Quality Control', 'Billing', 'Other',
]

interface ContactRow {
  id: string
  name: string
  email: string
  phone: string
  role: string
  is_primary: boolean
  _new?: boolean
}

let contactKey = 0

export default function CoPackers() {
  const [coPackers, setCoPackers] = useState<CoPacker[]>([])
  const [cpContacts, setCpContacts] = useState<CoPackerContact[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [runs, setRuns] = useState<ProductionRun[]>([])
  const [fulfillmentCenters, setFulfillmentCenters] = useState<FulfillmentCenter[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const toast = useToast()
  const { can, appUser } = useAuth()

  /* ── Fulfillment Center modal state ─────────────────────────── */
  const [fcModalOpen, setFcModalOpen] = useState(false)
  const [editFC, setEditFC] = useState<FulfillmentCenter | null>(null)
  const [fcForm, setFcForm] = useState({ name: '', type: 'fba', code: '', location: '', contact_name: '', contact_email: '', contact_phone: '', notes: '' })

  /* create form contacts */
  const [createContacts, setCreateContacts] = useState<ContactRow[]>([])

  /* edit modal */
  const [editCP, setEditCP] = useState<CoPacker | null>(null)
  const [editForm, setEditForm] = useState({
    name: '', short_code: '', color: '', location: '',
    fee_per_unit: '', payment_terms: '', min_order_qty: '', monthly_capacity: '',
    notes: '', status: '', receiving_hours: '', receiving_notes: '',
  })
  const [editContacts, setEditContacts] = useState<ContactRow[]>([])

  /* delete confirm */
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [pendingDeleteCP, setPendingDeleteCP] = useState<CoPacker | null>(null)

  async function load() {
    try {
      const [cpRes, ctRes, recRes, runRes, fcRes] = await safeBatch(() => Promise.all([
        supabase.from('co_packers').select('*').order('name'),
        supabase.from('co_packer_contacts').select('*'),
        supabase.from('recipes').select('*').order('name'),
        supabase.from('production_runs').select('*'),
        supabase.from('fulfillment_centers').select('*').order('name'),
      ]))
      setCoPackers(cpRes.data ?? [])
      setCpContacts(ctRes.data ?? [])
      setRecipes(recRes.data ?? [])
      setRuns(runRes.data ?? [])
      setFulfillmentCenters(fcRes.data ?? [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => safeLoad(load, setLoading), [])

  function recipesForCP(cpId: string): Recipe[] {
    return recipes.filter((r) => r.co_packer_id === cpId)
  }

  function statsForCP(cpId: string): CPStats {
    const cpRuns = runs.filter((r) => r.co_packer_id === cpId)
    const withWaste = cpRuns.filter((r) => r.waste_pct != null)
    const totalProduced = cpRuns.reduce((s, r) => s + (r.produced_quantity ?? 0), 0)
    const avgWaste =
      withWaste.length > 0
        ? withWaste.reduce((s, r) => s + (r.waste_pct ?? 0), 0) / withWaste.length
        : null
    return { totalRuns: cpRuns.length, totalProduced, avgWaste }
  }

  function primaryContactFor(cpId: string): CoPackerContact | undefined {
    return cpContacts.find((c) => c.co_packer_id === cpId && c.is_primary)
  }

  function contactCountFor(cpId: string): number {
    return cpContacts.filter((c) => c.co_packer_id === cpId).length
  }

  /* ── Create modal ─────────────────────────────────────────── */

  function openCreate() {
    setCreateContacts([{
      id: `new-${++contactKey}`, name: '', email: '', phone: '',
      role: 'Production Manager', is_primary: true, _new: true,
    }])
    setModalOpen(true)
  }

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    try {
      const fd = new FormData(e.currentTarget)
      const row: CoPackerInsert = {
        name: fd.get('name') as string,
        short_code: fd.get('short_code') as string,
        color: (fd.get('color') as string) || null,
        location: (fd.get('location') as string) || null,
        fee_per_unit: fd.get('fee_per_unit') ? Number(fd.get('fee_per_unit')) : null,
        payment_terms: (fd.get('payment_terms') as string) || null,
        min_order_qty: fd.get('min_order_qty') ? Number(fd.get('min_order_qty')) : null,
        monthly_capacity: fd.get('monthly_capacity') ? Number(fd.get('monthly_capacity')) : null,
        receiving_hours: (fd.get('receiving_hours') as string) || null,
        receiving_notes: (fd.get('receiving_notes') as string) || null,
      }
      const { data: cp, error } = await dbInsertSingle('co_packers', sanitize('co_packers', row) as typeof row)
      if (error || !cp) throw error ?? new Error('Failed to create co-packer')

      // Insert contacts
      const validContacts = createContacts.filter((c) => c.name.trim())
      if (validContacts.length > 0) {
        const { error: ctError } = await dbInsert('co_packer_contacts',
          validContacts.map((c) => sanitize('co_packer_contacts', {
            co_packer_id: cp.id,
            name: c.name.trim(),
            email: c.email.trim() || null,
            phone: c.phone.trim() || null,
            role: c.role || null,
            is_primary: c.is_primary,
          })),
        )
        if (ctError) throw ctError
      }

      invalidateCPCache()
      setModalOpen(false)
      toast.success('Co-packer added')
      logActivity(appUser?.id, 'create_copacker', 'co_packer', cp.id)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create co-packer')
    } finally {
      setSaving(false)
    }
  }

  /* ── Edit modal ───────────────────────────────────────────── */

  function openEdit(cp: CoPacker) {
    setEditCP(cp)
    setEditForm({
      name: cp.name,
      short_code: cp.short_code,
      color: cp.color ?? '',
      location: cp.location ?? '',
      fee_per_unit: cp.fee_per_unit != null ? String(cp.fee_per_unit) : '',
      payment_terms: cp.payment_terms ?? '',
      min_order_qty: cp.min_order_qty != null ? String(cp.min_order_qty) : '',
      monthly_capacity: cp.monthly_capacity != null ? String(cp.monthly_capacity) : '',
      notes: cp.notes ?? '',
      status: cp.status ?? 'active',
      receiving_hours: cp.receiving_hours ?? '',
      receiving_notes: cp.receiving_notes ?? '',
    })
    const contacts = cpContacts.filter((c) => c.co_packer_id === cp.id)
    setEditContacts(
      contacts.length > 0
        ? contacts.map((c) => ({
            id: c.id, name: c.name, email: c.email ?? '', phone: c.phone ?? '',
            role: c.role ?? 'Other', is_primary: c.is_primary,
          }))
        : [{
            id: `new-${++contactKey}`, name: '', email: '', phone: '',
            role: 'Production Manager', is_primary: true, _new: true,
          }],
    )
  }

  async function handleSaveEdit() {
    if (!editCP) return
    setSaving(true)
    try {
      const { error } = await dbUpdate('co_packers', sanitize('co_packers', {
        name: editForm.name,
        short_code: editForm.short_code,
        color: editForm.color || null,
        location: editForm.location || null,
        fee_per_unit: editForm.fee_per_unit ? Number(editForm.fee_per_unit) : null,
        payment_terms: editForm.payment_terms || null,
        min_order_qty: editForm.min_order_qty ? Number(editForm.min_order_qty) : null,
        monthly_capacity: editForm.monthly_capacity ? Number(editForm.monthly_capacity) : null,
        notes: editForm.notes || null,
        status: editForm.status || 'active',
        receiving_hours: editForm.receiving_hours || null,
        receiving_notes: editForm.receiving_notes || null,
      }), 'id', editCP.id)
      if (error) throw error

      // Diff contacts
      const existingIds = cpContacts.filter((c) => c.co_packer_id === editCP.id).map((c) => c.id)
      const keptIds = editContacts.filter((c) => !c._new).map((c) => c.id)
      const toDelete = existingIds.filter((id) => !keptIds.includes(id))
      if (toDelete.length > 0) {
        await dbDeleteIn('co_packer_contacts', 'id', toDelete)
      }

      for (const c of editContacts) {
        if (!c.name.trim()) continue
        if (c._new) {
          const { error: insErr } = await dbInsert('co_packer_contacts', sanitize('co_packer_contacts', {
            co_packer_id: editCP.id,
            name: c.name.trim(),
            email: c.email.trim() || null,
            phone: c.phone.trim() || null,
            role: c.role || null,
            is_primary: c.is_primary,
          }))
          if (insErr) throw insErr
        } else {
          const { error: updErr } = await dbUpdate('co_packer_contacts', sanitize('co_packer_contacts', {
            name: c.name.trim(),
            email: c.email.trim() || null,
            phone: c.phone.trim() || null,
            role: c.role || null,
            is_primary: c.is_primary,
          }), 'id', c.id)
          if (updErr) throw updErr
        }
      }

      invalidateCPCache()
      toast.success('Co-packer updated')
      logActivity(appUser?.id, 'update_copacker', 'co_packer', editCP.id)
      setEditCP(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update co-packer')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteCP() {
    if (!pendingDeleteCP) return
    setSaving(true)
    try {
      const { error } = await dbDelete('co_packers', 'id', pendingDeleteCP.id)
      if (error) throw error
      invalidateCPCache()
      toast.success(`Deleted ${pendingDeleteCP.name}`)
      logActivity(appUser?.id, 'delete_copacker', 'co_packer', pendingDeleteCP.id)
      setConfirmDeleteOpen(false)
      setPendingDeleteCP(null)
      if (editCP?.id === pendingDeleteCP.id) setEditCP(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete co-packer')
    } finally {
      setSaving(false)
    }
  }

  /* ── Fulfillment Center CRUD ──────────────────────────────── */

  function openCreateFC() {
    setEditFC(null)
    setFcForm({ name: '', type: 'fba', code: '', location: '', contact_name: '', contact_email: '', contact_phone: '', notes: '' })
    setFcModalOpen(true)
  }

  function openEditFC(fc: FulfillmentCenter) {
    setEditFC(fc)
    setFcForm({
      name: fc.name,
      type: fc.type,
      code: fc.code ?? '',
      location: fc.location ?? '',
      contact_name: fc.contact_name ?? '',
      contact_email: fc.contact_email ?? '',
      contact_phone: fc.contact_phone ?? '',
      notes: fc.notes ?? '',
    })
    setFcModalOpen(true)
  }

  async function handleSaveFC() {
    setSaving(true)
    try {
      const data: FulfillmentCenterInsert = {
        name: fcForm.name,
        type: fcForm.type,
        code: fcForm.code || null,
        location: fcForm.location || null,
        contact_name: fcForm.contact_name || null,
        contact_email: fcForm.contact_email || null,
        contact_phone: fcForm.contact_phone || null,
        notes: fcForm.notes || null,
      }
      if (editFC) {
        const { error } = await dbUpdate('fulfillment_centers', sanitize('fulfillment_centers', data), 'id', editFC.id)
        if (error) throw error
        toast.success('Fulfillment center updated')
      } else {
        const { error } = await dbInsert('fulfillment_centers', sanitize('fulfillment_centers', data) as typeof data)
        if (error) throw error
        toast.success('Fulfillment center added')
      }
      setFcModalOpen(false)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteFC(fc: FulfillmentCenter) {
    setSaving(true)
    try {
      const { error } = await dbDelete('fulfillment_centers', 'id', fc.id)
      if (error) throw error
      toast.success(`Deleted ${fc.name}`)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setSaving(false)
    }
  }

  /* ── Contact list helpers ─────────────────────────────────── */

  function updateContact(
    list: ContactRow[],
    setList: (v: ContactRow[]) => void,
    id: string,
    field: keyof ContactRow,
    value: string | boolean,
  ) {
    setList(list.map((c) => {
      if (c.id !== id) {
        if (field === 'is_primary' && value === true) return { ...c, is_primary: false }
        return c
      }
      return { ...c, [field]: value }
    }))
  }

  function removeContact(list: ContactRow[], setList: (v: ContactRow[]) => void, id: string) {
    const next = list.filter((c) => c.id !== id)
    if (next.length > 0 && !next.some((c) => c.is_primary)) {
      next[0].is_primary = true
    }
    setList(next)
  }

  function addContact(list: ContactRow[], setList: (v: ContactRow[]) => void) {
    setList([...list, {
      id: `new-${++contactKey}`, name: '', email: '', phone: '',
      role: 'Other', is_primary: list.length === 0, _new: true,
    }])
  }

  if (loading) return <PageSkeleton />

  return (
    <div>
      <PageHeader title="Co-Packers" subtitle="Manage co-packer profiles, terms, and performance">
        <button
          onClick={openCreate}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
        >
          <Plus size={16} />
          Add Co-Packer
        </button>
      </PageHeader>

      {/* Empty state */}
      {coPackers.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Factory size={40} className="mb-3 text-muted/40" />
          <p className="text-sm font-medium text-muted">No co-packers yet</p>
          <p className="mt-1 text-xs text-muted/70">Add your first co-packer to get started</p>
        </div>
      )}

      {/* Co-Packer Cards */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 2xl:grid-cols-3">
        {coPackers.map((cp) => {
          const cpRecipes = recipesForCP(cp.id)
          const stats = statsForCP(cp.id)
          const hex = cp.color ?? '#3B82F6'
          const capacityPct =
            cp.monthly_capacity && stats.totalProduced
              ? Math.round((stats.totalProduced / cp.monthly_capacity) * 100)
              : 0
          const primary = primaryContactFor(cp.id)
          const extraContacts = contactCountFor(cp.id) - (primary ? 1 : 0)

          return (
            <div
              key={cp.id}
              className="rounded-xl border border-border bg-card overflow-hidden"
            >
              {/* Color top border */}
              <div className="h-[3px]" style={{ backgroundColor: hex }} />

              <div className="p-5">
                {/* Header */}
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <h3 className="text-base font-semibold text-text">{cp.name}</h3>
                    <span
                      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
                      style={{ backgroundColor: `${hex}1F`, color: hex }}
                    >
                      {cp.short_code}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => openEdit(cp)}
                      className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-accent"
                      title="Edit"
                    >
                      <Pencil size={14} />
                    </button>
                    {can('delete_any') && (
                    <button
                      onClick={() => { setPendingDeleteCP(cp); setConfirmDeleteOpen(true) }}
                      className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-red-400"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                    )}
                  </div>
                </div>

                {/* Location */}
                {cp.location && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                    <MapPin size={12} />
                    {cp.location}
                  </div>
                )}

                {/* Receiving Hours */}
                {cp.receiving_hours && (
                  <div className="mt-1.5">
                    <div className="flex items-center gap-1.5 text-xs text-muted">
                      <Clock size={12} />
                      Receiving: {cp.receiving_hours}
                    </div>
                    {cp.receiving_notes && (
                      <p className="ml-[18px] mt-0.5 text-[10px] text-muted/70">{cp.receiving_notes}</p>
                    )}
                  </div>
                )}

                {/* Contact */}
                <div className="mt-4 space-y-1.5">
                  {primary ? (
                    <>
                      <p className="text-sm text-text">
                        <span className="text-xs text-muted">Primary:</span>{' '}
                        {primary.name}
                        {primary.email && <span className="text-muted"> · {primary.email}</span>}
                        {primary.phone && <span className="text-muted"> · {primary.phone}</span>}
                      </p>
                      {extraContacts > 0 && (
                        <p className="text-xs text-muted">+{extraContacts} more contact{extraContacts !== 1 ? 's' : ''}</p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-muted italic">No contacts</p>
                  )}
                </div>

                {/* Divider */}
                <div className="my-4 border-t border-border" />

                {/* Terms Grid */}
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted">Fee / Unit</p>
                    <p className="mt-0.5 font-mono font-medium text-text">
                      {fmtRate(cp.fee_per_unit)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted">Payment Terms</p>
                    <p className="mt-0.5 font-medium text-text">{cp.payment_terms ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted">Min Order Qty</p>
                    <p className="mt-0.5 font-mono font-medium text-text">
                      {cp.min_order_qty?.toLocaleString() ?? '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted">Monthly Capacity</p>
                    <p className="mt-0.5 font-mono font-medium text-text">
                      {cp.monthly_capacity?.toLocaleString() ?? '—'}
                    </p>
                  </div>
                </div>

                {/* Products */}
                {cpRecipes.length > 0 && (
                  <>
                    <div className="my-4 border-t border-border" />
                    <div>
                      <p className="mb-2 text-[10px] uppercase tracking-wider text-muted">
                        Products ({cpRecipes.length})
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {cpRecipes.map((r) => (
                          <Badge key={r.id} color="accent">
                            {r.sku}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {/* Performance */}
                <div className="my-4 border-t border-border" />
                <div>
                  <p className="mb-3 text-[10px] uppercase tracking-wider text-muted">
                    Performance
                  </p>
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <p className="text-muted">Avg Waste</p>
                      <p
                        className="mt-0.5 font-mono font-semibold"
                        style={{
                          color:
                            stats.avgWaste != null && stats.avgWaste > 3
                              ? '#EF4444'
                              : stats.avgWaste != null && stats.avgWaste > 2
                                ? '#F59E0B'
                                : '#22C55E',
                        }}
                      >
                        {stats.avgWaste != null ? `${stats.avgWaste.toFixed(1)}%` : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted">Total Runs</p>
                      <p className="mt-0.5 font-mono font-semibold text-text">
                        {stats.totalRuns}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted">Units Produced</p>
                      <p className="mt-0.5 font-mono font-semibold text-text">
                        {stats.totalProduced.toLocaleString()}
                      </p>
                    </div>
                  </div>
                  {cp.monthly_capacity && (
                    <div className="mt-3">
                      <div className="mb-1 flex items-center justify-between text-[10px] text-muted">
                        <span>Capacity utilization</span>
                        <span className="font-mono">{capacityPct}%</span>
                      </div>
                      <MiniBar value={capacityPct} color={hex} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Fulfillment Centers Section ──────────────────────────── */}
      <div className="mt-8">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text">Fulfillment Centers</h2>
            <p className="text-xs text-muted">FBA warehouses and 3PL partners for finished goods</p>
          </div>
          <button
            onClick={openCreateFC}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            <Plus size={16} />
            Add Fulfillment Center
          </button>
        </div>

        {fulfillmentCenters.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card py-12 text-center">
            <MapPin size={32} className="mb-3 text-muted/40" />
            <p className="text-sm font-medium text-muted">No fulfillment centers yet</p>
            <p className="mt-1 text-xs text-muted/70">Add FBA or 3PL centers to track finished goods destinations</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            {fulfillmentCenters.map((fc) => {
              const typeColor = fc.type === 'fba' ? '#F59E0B' : '#22C55E'
              const typeLabel = fc.type === 'fba' ? 'FBA' : '3PL'
              return (
                <div key={fc.id} className="rounded-xl border border-border bg-card overflow-hidden">
                  <div className="h-[3px]" style={{ backgroundColor: typeColor }} />
                  <div className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <h3 className="text-base font-semibold text-text">{fc.name}</h3>
                        <Badge color={fc.type === 'fba' ? 'amber' : 'green'}>{typeLabel}</Badge>
                        {fc.code && (
                          <span className="font-mono text-xs text-muted">{fc.code}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openEditFC(fc)}
                          className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-accent"
                          title="Edit"
                        >
                          <Pencil size={14} />
                        </button>
                        {can('delete_any') && (
                        <button
                          onClick={() => handleDeleteFC(fc)}
                          className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-red-400"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                        )}
                      </div>
                    </div>
                    {fc.location && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                        <MapPin size={12} />
                        {fc.location}
                      </div>
                    )}
                    {(fc.contact_name || fc.contact_email || fc.contact_phone) && (
                      <div className="mt-3 space-y-1 text-xs text-muted">
                        {fc.contact_name && <p className="text-text">{fc.contact_name}</p>}
                        {fc.contact_email && (
                          <p className="flex items-center gap-1.5"><Mail size={11} /> {fc.contact_email}</p>
                        )}
                        {fc.contact_phone && (
                          <p className="flex items-center gap-1.5"><Phone size={11} /> {fc.contact_phone}</p>
                        )}
                      </div>
                    )}
                    {fc.notes && (
                      <p className="mt-3 text-xs text-muted italic">{fc.notes}</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Fulfillment Center Modal ─────────────────────────────── */}
      <Modal
        isOpen={fcModalOpen}
        onClose={() => setFcModalOpen(false)}
        title={editFC ? `Edit ${editFC.name}` : 'Add Fulfillment Center'}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Name <span className="text-red-400">*</span></span>
              <input value={fcForm.name} onChange={(e) => setFcForm({ ...fcForm, name: e.target.value })} required className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" placeholder="e.g. Amazon ONT8" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Type <span className="text-red-400">*</span></span>
              <select value={fcForm.type} onChange={(e) => setFcForm({ ...fcForm, type: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent">
                <option value="fba">FBA (Amazon)</option>
                <option value="3pl">3PL (Shopify/DTC)</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Code</span>
              <input value={fcForm.code} onChange={(e) => setFcForm({ ...fcForm, code: e.target.value })} placeholder="e.g. ONT8, SB-CHI" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Location</span>
              <input value={fcForm.location} onChange={(e) => setFcForm({ ...fcForm, location: e.target.value })} placeholder="City, State" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
            </label>
          </div>
          <div className="border-t border-border pt-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">Contact</p>
            <div className="grid grid-cols-3 gap-4">
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Name</span>
                <input value={fcForm.contact_name} onChange={(e) => setFcForm({ ...fcForm, contact_name: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Email</span>
                <input value={fcForm.contact_email} onChange={(e) => setFcForm({ ...fcForm, contact_email: e.target.value })} type="email" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Phone</span>
                <input value={fcForm.contact_phone} onChange={(e) => setFcForm({ ...fcForm, contact_phone: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Notes</span>
            <textarea value={fcForm.notes} onChange={(e) => setFcForm({ ...fcForm, notes: e.target.value })} rows={2} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent resize-none" />
          </label>
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <button type="button" onClick={() => setFcModalOpen(false)} className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text">Cancel</button>
            <button type="button" onClick={handleSaveFC} disabled={saving || !fcForm.name.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">{saving ? 'Saving…' : editFC ? 'Save Changes' : 'Add Center'}</button>
          </div>
        </div>
      </Modal>

      {/* Add Co-Packer Modal */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Add Co-Packer" wide>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" name="name" required />
            <Field label="Short Code" name="short_code" required placeholder="e.g. PNC" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Color (hex)" name="color" placeholder="#06B6D4" />
            <Field label="Location" name="location" placeholder="City, State" />
          </div>

          {/* Contacts section */}
          <div className="border-t border-border pt-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">Contacts</p>
            <ContactEditor
              contacts={createContacts}
              onChange={setCreateContacts}
              onUpdate={(id, field, value) => updateContact(createContacts, setCreateContacts, id, field, value)}
              onRemove={(id) => removeContact(createContacts, setCreateContacts, id)}
              onAdd={() => addContact(createContacts, setCreateContacts)}
            />
          </div>

          <div className="border-t border-border pt-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">Terms</p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Fee per Unit ($)" name="fee_per_unit" type="number" step="0.01" />
              <Field label="Payment Terms" name="payment_terms" placeholder="Net 30" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <Field label="Min Order Qty" name="min_order_qty" type="number" step="1" />
              <Field label="Monthly Capacity" name="monthly_capacity" type="number" step="1" />
            </div>
          </div>
          <div className="border-t border-border pt-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">Receiving Information</p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Receiving Hours" name="receiving_hours" placeholder="Mon-Fri 7:00 AM - 3:00 PM" />
              <Field label="Receiving Notes" name="receiving_notes" placeholder="Use dock #3, ask for Mike" />
            </div>
          </div>
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Create Co-Packer'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Co-Packer Modal */}
      <Modal isOpen={!!editCP} onClose={() => setEditCP(null)} title={`Edit ${editCP?.name ?? 'Co-Packer'}`} wide>
        {editCP && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Name</span>
                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Short Code</span>
                <input value={editForm.short_code} onChange={(e) => setEditForm({ ...editForm, short_code: e.target.value })} required className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Color (hex)</span>
                <input value={editForm.color} onChange={(e) => setEditForm({ ...editForm, color: e.target.value })} placeholder="#06B6D4" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Location</span>
                <input value={editForm.location} onChange={(e) => setEditForm({ ...editForm, location: e.target.value })} placeholder="City, State" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
            </div>

            {/* Contacts section */}
            <div className="border-t border-border pt-4">
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">Contacts</p>
              <ContactEditor
                contacts={editContacts}
                onChange={setEditContacts}
                onUpdate={(id, field, value) => updateContact(editContacts, setEditContacts, id, field, value)}
                onRemove={(id) => removeContact(editContacts, setEditContacts, id)}
                onAdd={() => addContact(editContacts, setEditContacts)}
              />
            </div>

            <div className="border-t border-border pt-4">
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">Terms</p>
              <div className="grid grid-cols-2 gap-4">
                <label className="block">
                  <span className="mb-1 block text-xs text-muted">Fee per Unit ($)</span>
                  <input type="number" step="0.01" value={editForm.fee_per_unit} onChange={(e) => setEditForm({ ...editForm, fee_per_unit: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-muted">Payment Terms</span>
                  <input value={editForm.payment_terms} onChange={(e) => setEditForm({ ...editForm, payment_terms: e.target.value })} placeholder="Net 30" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
                </label>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <label className="block">
                  <span className="mb-1 block text-xs text-muted">Min Order Qty</span>
                  <input type="number" step="1" value={editForm.min_order_qty} onChange={(e) => setEditForm({ ...editForm, min_order_qty: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-muted">Monthly Capacity</span>
                  <input type="number" step="1" value={editForm.monthly_capacity} onChange={(e) => setEditForm({ ...editForm, monthly_capacity: e.target.value })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
                </label>
              </div>
            </div>
            <div className="border-t border-border pt-4">
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">Receiving Information</p>
              <div className="grid grid-cols-2 gap-4">
                <label className="block">
                  <span className="mb-1 block text-xs text-muted">Receiving Hours</span>
                  <input value={editForm.receiving_hours} onChange={(e) => setEditForm({ ...editForm, receiving_hours: e.target.value })} placeholder="Mon-Fri 7:00 AM - 3:00 PM" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-muted">Receiving Notes</span>
                  <input value={editForm.receiving_notes} onChange={(e) => setEditForm({ ...editForm, receiving_notes: e.target.value })} placeholder="Use dock #3, ask for Mike" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
                </label>
              </div>
            </div>
            <label className="block border-t border-border pt-4">
              <span className="mb-1 block text-xs text-muted">Notes</span>
              <textarea value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} rows={2} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent resize-none" />
            </label>
            <div className="flex items-center justify-between border-t border-border pt-4">
              {can('delete_any') && (
              <button
                type="button"
                onClick={() => { setPendingDeleteCP(editCP); setConfirmDeleteOpen(true) }}
                className="rounded-lg px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-400/10"
              >
                <span className="flex items-center gap-1.5"><Trash2 size={14} /> Delete</span>
              </button>
              )}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setEditCP(null)}
                  className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={saving || !editForm.name.trim() || !editForm.short_code.trim()}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Confirm Delete Co-Packer */}
      <ConfirmDialog
        isOpen={confirmDeleteOpen}
        title={`Delete ${pendingDeleteCP?.name ?? 'co-packer'}?`}
        message="This will permanently delete this co-packer. Recipes and production runs referencing it may be affected. This cannot be undone."
        confirmLabel="Delete Co-Packer"
        danger
        onConfirm={handleDeleteCP}
        onCancel={() => { setConfirmDeleteOpen(false); setPendingDeleteCP(null) }}
      />
    </div>
  )
}

/* ── Contact Editor Component ─────────────────────────────────── */

function ContactEditor({ contacts, onChange: _onChange, onUpdate, onRemove, onAdd }: {
  contacts: ContactRow[]
  onChange: (v: ContactRow[]) => void
  onUpdate: (id: string, field: keyof ContactRow, value: string | boolean) => void
  onRemove: (id: string) => void
  onAdd: () => void
}) {
  const { can } = useAuth()
  return (
    <div className="space-y-3">
      {contacts.map((c) => (
        <div key={c.id} className="rounded-lg border border-border bg-surface/50 p-3">
          <div className="flex items-start gap-3">
            <div className="grid flex-1 grid-cols-2 gap-3">
              <input
                value={c.name}
                onChange={(e) => onUpdate(c.id, 'name', e.target.value)}
                placeholder="Name"
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <input
                value={c.email}
                onChange={(e) => onUpdate(c.id, 'email', e.target.value)}
                placeholder="Email"
                type="email"
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <input
                value={c.phone}
                onChange={(e) => onUpdate(c.id, 'phone', e.target.value)}
                placeholder="Phone"
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <select
                value={c.role}
                onChange={(e) => onUpdate(c.id, 'role', e.target.value)}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              >
                {CONTACT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="flex flex-col items-center gap-1 pt-1">
              <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted">
                <input
                  type="radio"
                  checked={c.is_primary}
                  onChange={() => onUpdate(c.id, 'is_primary', true)}
                  className="accent-accent"
                />
                Primary
              </label>
              {can('delete_any') && (
              <button
                type="button"
                onClick={() => onRemove(c.id)}
                className="rounded p-1 text-muted transition-colors hover:text-red-400"
              >
                <X size={14} />
              </button>
              )}
            </div>
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-1.5 text-xs font-medium text-accent transition-colors hover:text-accent-hover"
      >
        <Plus size={14} />
        Add Contact
      </button>
    </div>
  )
}

/* ── Field helper ──────────────────────────────────────────────── */

function Field({
  label,
  name,
  type = 'text',
  required,
  placeholder,
  step,
}: {
  label: string
  name: string
  type?: string
  required?: boolean
  placeholder?: string
  step?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        step={step}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none transition-colors focus:border-accent"
      />
    </label>
  )
}
