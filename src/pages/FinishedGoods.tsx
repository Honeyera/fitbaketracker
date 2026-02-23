import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { sanitize } from '../lib/sanitizePayload'
import { dbUpdate, dbInsertSingle } from '../lib/dbWrite'
import { safeBatch } from '../lib/safeQuery'
import { safeLoad } from '../lib/safeLoad'
import { format } from 'date-fns'
import { useToast } from '../components/Toast'
import { fmt$, fmtDate } from '../lib/format'
import { downloadCSV } from '../lib/csv'
import PageHeader from '../components/PageHeader'
import CPFilterBar from '../components/CPFilterBar'
import StatCard from '../components/StatCard'
import DataTable, { type Column } from '../components/DataTable'
import CPBadge from '../components/CPBadge'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import RecipeIcon from '../components/RecipeIcon'
import { PageSkeleton } from '../components/Skeleton'
import { ArrowRight, Download } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { logActivity } from '../lib/activityLog'
import type {
  FinishedGoodsMovement,
  FinishedGoodsMovementInsert,
  CoPacker,
  Recipe,
  ProductionRun,
  FulfillmentCenter,
} from '../types/database'

/* ── Row type ───────────────────────────────────────────────── */

interface Row extends Record<string, unknown> {
  id: string
  date: string
  co_packer_id: string | null
  recipe_id: string | null
  recipeName: string
  quantity: number
  from_location: string
  to_location: string
  tracking_number: string | null
  status: string | null
  notes: string | null
  production_run_id: string | null
  shipping_cost: number | null
  freight_per_unit: number | null
  freight_leg: string | null
  sales_channel: string | null
  fulfillment_center_id: string | null
}

/* ── Helpers ─────────────────────────────────────────────────── */

function fmtLocation(loc: string, coPackers: CoPacker[], fulfillmentCenters: FulfillmentCenter[]) {
  const lower = loc.toLowerCase()
  if (lower === 'copacker') return 'Co-Packer'
  const cp = coPackers.find((c) => c.id === loc || c.short_code?.toLowerCase() === lower)
  if (cp) return cp.short_code ?? cp.name
  const fc = fulfillmentCenters.find((f) => f.id === loc)
  if (fc) return fc.code ?? fc.name
  return loc
}

const STATUS_CONFIG: Record<string, { color: 'cyan' | 'green' | 'amber'; label: string }> = {
  in_transit: { color: 'cyan', label: 'IN TRANSIT' },
  received: { color: 'green', label: 'RECEIVED' },
  delivered: { color: 'green', label: 'DELIVERED' },
}

const CHANNEL_BADGE: Record<string, { color: 'amber' | 'green' | 'gray'; label: string }> = {
  amazon: { color: 'amber', label: 'AMAZON' },
  shopify: { color: 'green', label: 'SHOPIFY' },
}

/* ================================================================ */

export default function FinishedGoods() {
  const { appUser } = useAuth()
  const [movements, setMovements] = useState<FinishedGoodsMovement[]>([])
  const [coPackers, setCoPackers] = useState<CoPacker[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [productionRuns, setProductionRuns] = useState<ProductionRun[]>([])
  const [fulfillmentCenters, setFulfillmentCenters] = useState<FulfillmentCenter[]>([])
  const [cpFilter, setCpFilter] = useState('all')
  const [channelFilter, setChannelFilter] = useState<'all' | 'amazon' | 'shopify' | 'other'>('all')
  const [loading, setLoading] = useState(true)
  const toast = useToast()

  /* ── Modals ──────────────────────────────────────────────────── */
  const [editRow, setEditRow] = useState<Row | null>(null)
  const [saving, setSaving] = useState(false)

  /* ── Ship to FBA form state ────────────────────────────────── */
  const [showShipFba, setShowShipFba] = useState(false)
  const [fbaCp, setFbaCp] = useState('')
  const [fbaRun, setFbaRun] = useState('')
  const [fbaRecipe, setFbaRecipe] = useState('')
  const [fbaQty, setFbaQty] = useState('')
  const [fbaDate, setFbaDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [fbaFC, setFbaFC] = useState('')
  const [fbaTracking, setFbaTracking] = useState('')
  const [fbaNotes, setFbaNotes] = useState('')
  const [fbaShipCost, setFbaShipCost] = useState('')

  /* ── Ship to 3PL form state ────────────────────────────────── */
  const [showShip3pl, setShowShip3pl] = useState(false)
  const [tplCp, setTplCp] = useState('')
  const [tplRun, setTplRun] = useState('')
  const [tplRecipe, setTplRecipe] = useState('')
  const [tplQty, setTplQty] = useState('')
  const [tplDate, setTplDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [tplFC, setTplFC] = useState('')
  const [tplTracking, setTplTracking] = useState('')
  const [tplNotes, setTplNotes] = useState('')
  const [tplShipCost, setTplShipCost] = useState('')

  /* ── Other Shipment form state ─────────────────────────────── */
  const [showOther, setShowOther] = useState(false)
  const [othCp, setOthCp] = useState('')
  const [othRun, setOthRun] = useState('')
  const [othRecipe, setOthRecipe] = useState('')
  const [othQty, setOthQty] = useState('')
  const [othDate, setOthDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [othDestination, setOthDestination] = useState('')
  const [othChannel, setOthChannel] = useState('')
  const [othTracking, setOthTracking] = useState('')
  const [othNotes, setOthNotes] = useState('')
  const [othShipCost, setOthShipCost] = useState('')

  /* ── Edit form state ─────────────────────────────────────────── */
  const [editStatus, setEditStatus] = useState('')
  const [editTracking, setEditTracking] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [editShipCost, setEditShipCost] = useState('')

  /* ── Data loading ────────────────────────────────────────────── */

  async function load() {
    const [mvRes, cpRes, recRes, prRes, fcRes] = await safeBatch(() => Promise.all([
      supabase.from('finished_goods_movements').select('*').order('date', { ascending: false }),
      supabase.from('co_packers').select('*').order('name'),
      supabase.from('recipes').select('*'),
      supabase.from('production_runs').select('*'),
      supabase.from('fulfillment_centers').select('*').order('name'),
    ]))
    setMovements(mvRes.data ?? [])
    setCoPackers(cpRes.data ?? [])
    setRecipes(recRes.data ?? [])
    setProductionRuns(prRes.data ?? [])
    setFulfillmentCenters(fcRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => safeLoad(load, setLoading), [])

  /* ── Filtered movements ──────────────────────────────────────── */

  const filteredMovements = useMemo(() => {
    let filtered = movements
    if (cpFilter !== 'all') filtered = filtered.filter((m) => m.co_packer_id === cpFilter)
    if (channelFilter !== 'all') {
      if (channelFilter === 'amazon') {
        filtered = filtered.filter((m) => m.sales_channel === 'amazon' || m.freight_leg === 'cp_to_fba')
      } else if (channelFilter === 'shopify') {
        filtered = filtered.filter((m) => m.sales_channel === 'shopify' || m.freight_leg === 'cp_to_3pl')
      } else {
        filtered = filtered.filter((m) => !m.sales_channel || (m.sales_channel !== 'amazon' && m.sales_channel !== 'shopify'))
      }
    }
    return filtered
  }, [movements, cpFilter, channelFilter])

  /* ── Build table rows ────────────────────────────────────────── */

  const rows: Row[] = useMemo(() => {
    return filteredMovements.map((m) => {
      const recipe = recipes.find((r) => r.id === m.recipe_id)
      return {
        id: m.id,
        date: m.date,
        co_packer_id: m.co_packer_id,
        recipe_id: m.recipe_id,
        recipeName: recipe ? `${recipe.name} (${recipe.sku})` : '—',
        quantity: m.quantity,
        from_location: m.from_location,
        to_location: m.to_location,
        tracking_number: m.tracking_number,
        status: m.status,
        notes: m.notes,
        production_run_id: m.production_run_id,
        shipping_cost: m.shipping_cost,
        freight_per_unit: m.freight_per_unit,
        freight_leg: m.freight_leg,
        sales_channel: m.sales_channel,
        fulfillment_center_id: m.fulfillment_center_id,
      }
    })
  }, [filteredMovements, recipes])

  /* ── Stats ───────────────────────────────────────────────────── */

  const stats = useMemo(() => {
    // At Co-Packers: completed runs not yet shipped out
    const completedRuns = productionRuns.filter(
      (r) => r.status === 'complete' || r.status === 'reconciled',
    )
    const shippedRunIds = new Set(
      movements
        .filter((m) => m.from_location === 'copacker' && m.production_run_id)
        .map((m) => m.production_run_id),
    )
    const atCoPacker = completedRuns
      .filter((r) => !shippedRunIds.has(r.id))
      .reduce((s, r) => s + (r.produced_quantity ?? 0), 0)

    // In Transit
    const inTransit = movements
      .filter((m) => m.status === 'in_transit')
      .reduce((s, m) => s + m.quantity, 0)

    // At FBA: delivered + amazon channel
    const atFba = movements
      .filter(
        (m) =>
          m.status === 'delivered' &&
          (m.sales_channel === 'amazon' || m.freight_leg === 'cp_to_fba'),
      )
      .reduce((s, m) => s + m.quantity, 0)

    // At 3PL: delivered + shopify channel
    const at3pl = movements
      .filter(
        (m) =>
          m.status === 'delivered' &&
          (m.sales_channel === 'shopify' || m.freight_leg === 'cp_to_3pl'),
      )
      .reduce((s, m) => s + m.quantity, 0)

    return { atCoPacker, inTransit, atFba, at3pl }
  }, [movements, productionRuns])

  /* ── Runs available for shipping (complete/reconciled, not yet shipped) ── */

  const availableRuns = useMemo(() => {
    const usedRunIds = new Set(
      movements
        .filter((m) => m.from_location === 'copacker' && m.production_run_id)
        .map((m) => m.production_run_id),
    )
    return (cpId: string) =>
      productionRuns
        .filter(
          (r) =>
            (r.status === 'complete' || r.status === 'reconciled') &&
            !usedRunIds.has(r.id) &&
            (cpId === '' || r.co_packer_id === cpId),
        )
        .sort((a, b) => a.run_number.localeCompare(b.run_number))
  }, [productionRuns, movements])

  /* ── Table columns ───────────────────────────────────────────── */

  const columns: Column<Row>[] = useMemo(
    () => [
      {
        label: 'Date',
        key: 'date',
        width: '100px',
        render: (row) => (
          <span className="text-xs text-muted">
            {format(new Date(row.date), 'MMM d, yyyy')}
          </span>
        ),
      },
      {
        label: 'CP',
        key: 'co_packer_id',
        width: '80px',
        render: (row) =>
          row.co_packer_id ? (
            <CPBadge coPackerId={row.co_packer_id as string} />
          ) : (
            <span className="text-muted">—</span>
          ),
      },
      {
        label: 'SKU',
        key: 'recipeName',
        render: (row) => {
          const recipe = recipes.find((r) => r.id === row.recipe_id)
          const cp = coPackers.find((c) => c.id === row.co_packer_id)
          return (
            <div className="flex items-center gap-2">
              <RecipeIcon imageUrl={recipe?.image_url} recipeName={recipe?.name ?? '—'} coPackerColor={cp?.color} size="sm" />
              <span className="font-medium text-text">{row.recipeName}</span>
            </div>
          )
        },
      },
      {
        label: 'Qty',
        key: 'quantity',
        align: 'right',
        width: '80px',
        render: (row) => (
          <span className="font-mono font-medium text-text">
            {row.quantity.toLocaleString()}
          </span>
        ),
      },
      {
        label: 'To',
        key: 'to_location',
        width: '120px',
        render: (row) => {
          const fc = fulfillmentCenters.find((f) => f.id === row.fulfillment_center_id)
          return (
            <span className="text-xs text-text">
              {fc ? (fc.code ?? fc.name) : fmtLocation(row.to_location, coPackers, fulfillmentCenters)}
            </span>
          )
        },
      },
      {
        label: 'Channel',
        key: 'sales_channel',
        align: 'center',
        width: '100px',
        render: (row) => {
          const ch = row.sales_channel as string | null
          const cfg = ch ? CHANNEL_BADGE[ch] : null
          if (cfg) return <Badge color={cfg.color}>{cfg.label}</Badge>
          return <span className="text-muted">—</span>
        },
      },
      {
        label: 'Tracking',
        key: 'tracking_number',
        width: '130px',
        render: (row) => (
          <span className="font-mono text-xs text-muted">
            {row.tracking_number || '—'}
          </span>
        ),
      },
      {
        label: 'Ship Cost',
        key: 'shipping_cost',
        align: 'right' as const,
        width: '90px',
        render: (row: Row) => (
          <span className="font-mono text-muted">{row.shipping_cost != null ? fmt$(row.shipping_cost) : '—'}</span>
        ),
      },
      {
        label: '/Unit',
        key: 'freight_per_unit',
        align: 'right' as const,
        width: '70px',
        render: (row: Row) => (
          <span className="font-mono text-muted">{row.freight_per_unit != null ? fmt$(row.freight_per_unit) : '—'}</span>
        ),
      },
      {
        label: 'Status',
        key: 'status',
        align: 'center',
        width: '100px',
        render: (row) => {
          const cfg = STATUS_CONFIG[row.status ?? '']
          if (!cfg) return <span className="text-muted">—</span>
          return <Badge color={cfg.color}>{cfg.label}</Badge>
        },
      },
    ],
    [coPackers, recipes, fulfillmentCenters],
  )

  /* ── Open edit modal ─────────────────────────────────────────── */

  function openEdit(row: Row) {
    setEditRow(row)
    setEditStatus(row.status ?? 'in_transit')
    setEditTracking(row.tracking_number ?? '')
    setEditNotes(row.notes ?? '')
    setEditShipCost(String(row.shipping_cost ?? ''))
  }

  /* ── Save edit ───────────────────────────────────────────────── */

  async function handleEditSave(e: FormEvent) {
    e.preventDefault()
    if (!editRow) return
    setSaving(true)
    try {
      const { error } = await dbUpdate('finished_goods_movements', sanitize('finished_goods_movements', {
          status: editStatus,
          tracking_number: editTracking || null,
          notes: editNotes || null,
          shipping_cost: editShipCost ? Number(editShipCost) : null,
          freight_per_unit: editShipCost && editRow?.quantity ? Number(editShipCost) / editRow.quantity : null,
        }), 'id', editRow.id)
      if (error) throw error

      setEditRow(null)
      toast.success('Movement updated')
      logActivity(appUser?.id, 'update_fg_movement', 'finished_goods_movement', editRow.id)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update movement')
    } finally {
      setSaving(false)
    }
  }

  /* ── Generic ship handler ──────────────────────────────────── */

  async function handleShip(
    cp: string,
    runId: string,
    recipeId: string,
    qty: string,
    date: string,
    fcId: string,
    toLocation: string,
    tracking: string,
    notes: string,
    shipCost: string,
    salesChannel: string,
    freightLeg: string,
    onDone: () => void,
  ) {
    setSaving(true)
    try {
      const run = runId ? productionRuns.find((r) => r.id === runId) : null
      const qtyNum = Number(qty) || (run?.produced_quantity ?? 0)

      const insert: FinishedGoodsMovementInsert = {
        date,
        co_packer_id: (run?.co_packer_id ?? cp) || null,
        recipe_id: (run?.recipe_id ?? recipeId) || null,
        production_run_id: runId || null,
        quantity: qtyNum,
        from_location: 'copacker',
        to_location: fcId || toLocation,
        status: 'in_transit',
        tracking_number: tracking || null,
        notes: notes || null,
        shipping_cost: shipCost ? Number(shipCost) : null,
        freight_per_unit: shipCost && qtyNum ? Number(shipCost) / qtyNum : null,
        freight_leg: freightLeg,
        sales_channel: salesChannel || null,
        fulfillment_center_id: fcId || null,
      }

      const { data: inserted, error } = await dbInsertSingle('finished_goods_movements', sanitize('finished_goods_movements', insert))
      if (error) throw error
      onDone()
      if (inserted) logActivity(appUser?.id, 'create_fg_movement', 'finished_goods_movement', inserted.id)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create shipment')
    } finally {
      setSaving(false)
    }
  }

  /* ── Ship to FBA submit ────────────────────────────────────── */

  async function handleShipFba(e: FormEvent) {
    e.preventDefault()
    await handleShip(
      fbaCp, fbaRun, fbaRecipe, fbaQty, fbaDate, fbaFC, 'fba',
      fbaTracking, fbaNotes, fbaShipCost, 'amazon', 'cp_to_fba',
      () => { setShowShipFba(false); toast.success('Shipment to FBA created') },
    )
  }

  /* ── Ship to 3PL submit ────────────────────────────────────── */

  async function handleShip3pl(e: FormEvent) {
    e.preventDefault()
    await handleShip(
      tplCp, tplRun, tplRecipe, tplQty, tplDate, tplFC, '3pl',
      tplTracking, tplNotes, tplShipCost, 'shopify', 'cp_to_3pl',
      () => { setShowShip3pl(false); toast.success('Shipment to 3PL created') },
    )
  }

  /* ── Other shipment submit ─────────────────────────────────── */

  async function handleOtherShip(e: FormEvent) {
    e.preventDefault()
    await handleShip(
      othCp, othRun, othRecipe, othQty, othDate, '', othDestination,
      othTracking, othNotes, othShipCost, othChannel, 'other',
      () => { setShowOther(false); toast.success('Shipment created') },
    )
  }

  /* ── Run auto-fill helpers ─────────────────────────────────── */

  function selectRunAndFill(
    runId: string,
    setRun: (v: string) => void,
    setQty: (v: string) => void,
    setRecipeId: (v: string) => void,
  ) {
    setRun(runId)
    const run = productionRuns.find((r) => r.id === runId)
    if (run?.produced_quantity) setQty(String(run.produced_quantity))
    if (run?.recipe_id) setRecipeId(run.recipe_id)
  }

  /* ── Reset helpers ─────────────────────────────────────────── */

  function resetFbaForm() {
    setFbaCp(''); setFbaRun(''); setFbaRecipe(''); setFbaQty('')
    setFbaDate(format(new Date(), 'yyyy-MM-dd')); setFbaFC('')
    setFbaTracking(''); setFbaNotes(''); setFbaShipCost('')
  }

  function reset3plForm() {
    setTplCp(''); setTplRun(''); setTplRecipe(''); setTplQty('')
    setTplDate(format(new Date(), 'yyyy-MM-dd')); setTplFC('')
    setTplTracking(''); setTplNotes(''); setTplShipCost('')
  }

  function resetOtherForm() {
    setOthCp(''); setOthRun(''); setOthRecipe(''); setOthQty('')
    setOthDate(format(new Date(), 'yyyy-MM-dd')); setOthDestination('')
    setOthChannel(''); setOthTracking(''); setOthNotes(''); setOthShipCost('')
  }

  /* ── CSV export ─────────────────────────────────────────────── */

  function handleExportCSV() {
    const exportData = rows.map((r) => ({
      date: fmtDate(r.date),
      recipe: r.recipeName,
      quantity: r.quantity,
      from: r.from_location,
      to: r.to_location,
      channel: r.sales_channel ?? '',
      status: r.status,
      tracking: r.tracking_number ?? '',
    }))
    downloadCSV(exportData, [
      { key: 'date', label: 'Date' },
      { key: 'recipe', label: 'Product' },
      { key: 'quantity', label: 'Quantity' },
      { key: 'from', label: 'From' },
      { key: 'to', label: 'To' },
      { key: 'channel', label: 'Channel' },
      { key: 'status', label: 'Status' },
      { key: 'tracking', label: 'Tracking' },
    ], 'finished-goods')
  }

  /* ── Render ──────────────────────────────────────────────────── */

  if (loading) return <PageSkeleton />

  const fbaFCs = fulfillmentCenters.filter((f) => f.type === 'fba' && f.status === 'active')
  const tplFCs = fulfillmentCenters.filter((f) => f.type === '3pl' && f.status === 'active')

  return (
    <div>
      <PageHeader
        title="Finished Goods"
        subtitle="Track finished goods from co-packers to FBA and 3PL fulfillment"
      >
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-text hover:bg-hover"
          >
            <Download size={14} />
            CSV
          </button>
          <button
            onClick={() => { resetFbaForm(); setShowShipFba(true) }}
            className="flex items-center gap-2 rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-sm font-medium text-amber-300 transition-colors hover:bg-amber-900/40"
          >
            <ArrowRight size={14} />
            Ship to FBA
          </button>
          <button
            onClick={() => { reset3plForm(); setShowShip3pl(true) }}
            className="flex items-center gap-2 rounded-lg border border-green-800/50 bg-green-950/30 px-3 py-2 text-sm font-medium text-green-300 transition-colors hover:bg-green-900/40"
          >
            <ArrowRight size={14} />
            Ship to 3PL
          </button>
          <button
            onClick={() => { resetOtherForm(); setShowOther(true) }}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-text hover:bg-hover"
          >
            <ArrowRight size={14} />
            Other
          </button>
        </div>
      </PageHeader>

      <CPFilterBar selected={cpFilter} onSelect={setCpFilter} />

      {/* Flow Diagram */}
      <div className="mb-6 rounded-xl border border-border bg-card px-6 py-4">
        <div className="relative flex items-center justify-between">
          {/* Node: Supplier */}
          <div className="z-10 rounded-lg border border-blue-800/50 bg-blue-950/30 px-4 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wider text-muted">Source</p>
            <p className="text-sm font-semibold text-blue-300">Supplier</p>
          </div>

          {/* Arrow */}
          <div className="mx-1 flex flex-1 items-center">
            <div className="h-px flex-1 bg-blue-800/50" />
            <svg className="h-2.5 w-2.5 shrink-0 text-blue-700" fill="currentColor" viewBox="0 0 12 12">
              <path d="M2 6l8-4v8z" />
            </svg>
          </div>

          {/* Node: Co-Packer */}
          <div className="z-10 rounded-lg border border-cyan-800/50 bg-cyan-950/30 px-4 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wider text-muted">Production</p>
            <p className="text-sm font-semibold text-cyan-300">Co-Packer</p>
          </div>

          {/* Branching arrows */}
          <div className="mx-1 flex flex-1 flex-col items-stretch gap-1">
            {/* Top arrow: → FBA */}
            <div className="flex items-center">
              <div className="h-px flex-1 bg-amber-800/50" />
              <span className="mx-1.5 whitespace-nowrap text-[10px] text-amber-600">→ FBA</span>
              <div className="h-px flex-1 bg-amber-800/50" />
              <svg className="h-2.5 w-2.5 shrink-0 text-amber-700" fill="currentColor" viewBox="0 0 12 12">
                <path d="M2 6l8-4v8z" />
              </svg>
            </div>
            {/* Bottom arrow: → 3PL */}
            <div className="flex items-center">
              <div className="h-px flex-1 bg-green-800/50" />
              <span className="mx-1.5 whitespace-nowrap text-[10px] text-green-600">→ 3PL</span>
              <div className="h-px flex-1 bg-green-800/50" />
              <svg className="h-2.5 w-2.5 shrink-0 text-green-700" fill="currentColor" viewBox="0 0 12 12">
                <path d="M2 6l8-4v8z" />
              </svg>
            </div>
          </div>

          {/* Destination nodes */}
          <div className="z-10 flex flex-col gap-1">
            <div className="rounded-lg border border-amber-800/50 bg-amber-950/30 px-4 py-1.5 text-center">
              <p className="text-[10px] uppercase tracking-wider text-muted">Amazon</p>
              <p className="text-sm font-semibold text-amber-300">FBA</p>
            </div>
            <div className="rounded-lg border border-green-800/50 bg-green-950/30 px-4 py-1.5 text-center">
              <p className="text-[10px] uppercase tracking-wider text-muted">Shopify/DTC</p>
              <p className="text-sm font-semibold text-green-300">3PL</p>
            </div>
          </div>
        </div>
      </div>

      {/* Channel Filter Buttons */}
      <div className="mb-4 flex gap-2">
        {(['all', 'amazon', 'shopify', 'other'] as const).map((ch) => {
          const labels: Record<typeof ch, string> = { all: 'All', amazon: 'Amazon/FBA', shopify: 'Shopify/3PL', other: 'Other' }
          return (
            <button
              key={ch}
              onClick={() => setChannelFilter(ch)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                channelFilter === ch
                  ? 'bg-accent text-white'
                  : 'border border-border text-muted hover:text-text'
              }`}
            >
              {labels[ch]}
            </button>
          )
        })}
      </div>

      {/* Stat Cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="At Co-Packers"
          value={stats.atCoPacker.toLocaleString()}
          sub="units produced, not shipped"
          trend={stats.atCoPacker > 0 ? 'Ready to ship' : undefined}
          trendGood={stats.atCoPacker === 0}
        />
        <StatCard
          label="In Transit"
          value={stats.inTransit.toLocaleString()}
          sub="units shipping"
          trend={stats.inTransit > 0 ? 'On the way' : undefined}
          trendGood={true}
        />
        <StatCard
          label="At FBA"
          value={stats.atFba.toLocaleString()}
          sub="Amazon units delivered"
        />
        <StatCard
          label="At 3PL"
          value={stats.at3pl.toLocaleString()}
          sub="Shopify/DTC units delivered"
        />
      </div>

      {/* Movement Log Table */}
      <DataTable
        columns={columns}
        data={rows}
        onRowClick={openEdit}
        emptyMessage="No finished goods movements"
        emptyHint="Ship to FBA or 3PL to start tracking"
      />

      {/* ── Ship to FBA Modal ─────────────────────────────────────── */}
      <Modal
        isOpen={showShipFba}
        onClose={() => setShowShipFba(false)}
        title="Ship to FBA"
      >
        <form onSubmit={handleShipFba} className="space-y-4">
          <ShipFormFields
            cpId={fbaCp} setCpId={setFbaCp}
            runId={fbaRun} setRunId={(v) => selectRunAndFill(v, setFbaRun, setFbaQty, setFbaRecipe)}
            recipeId={fbaRecipe} setRecipeId={setFbaRecipe}
            qty={fbaQty} setQty={setFbaQty}
            date={fbaDate} setDate={setFbaDate}
            tracking={fbaTracking} setTracking={setFbaTracking}
            notes={fbaNotes} setNotes={setFbaNotes}
            shipCost={fbaShipCost} setShipCost={setFbaShipCost}
            coPackers={coPackers}
            recipes={recipes}
            productionRuns={productionRuns}
            availableRuns={availableRuns}
          />
          {/* FC picker */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">
              FBA Fulfillment Center <span className="text-red-400">*</span>
            </label>
            <select
              value={fbaFC}
              onChange={(e) => setFbaFC(e.target.value)}
              required
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
            >
              <option value="">Select FBA center…</option>
              {fbaFCs.map((fc) => (
                <option key={fc.id} value={fc.id}>
                  {fc.name} {fc.code ? `(${fc.code})` : ''} {fc.location ? `— ${fc.location}` : ''}
                </option>
              ))}
            </select>
            {fbaFCs.length === 0 && (
              <p className="mt-1 text-xs text-muted">No FBA centers added yet — add one on the Co-Packers page</p>
            )}
          </div>
          <SubmitButtons saving={saving} onCancel={() => setShowShipFba(false)} label="Ship to FBA" />
        </form>
      </Modal>

      {/* ── Ship to 3PL Modal ─────────────────────────────────────── */}
      <Modal
        isOpen={showShip3pl}
        onClose={() => setShowShip3pl(false)}
        title="Ship to 3PL"
      >
        <form onSubmit={handleShip3pl} className="space-y-4">
          <ShipFormFields
            cpId={tplCp} setCpId={setTplCp}
            runId={tplRun} setRunId={(v) => selectRunAndFill(v, setTplRun, setTplQty, setTplRecipe)}
            recipeId={tplRecipe} setRecipeId={setTplRecipe}
            qty={tplQty} setQty={setTplQty}
            date={tplDate} setDate={setTplDate}
            tracking={tplTracking} setTracking={setTplTracking}
            notes={tplNotes} setNotes={setTplNotes}
            shipCost={tplShipCost} setShipCost={setTplShipCost}
            coPackers={coPackers}
            recipes={recipes}
            productionRuns={productionRuns}
            availableRuns={availableRuns}
          />
          {/* FC picker */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">
              3PL Fulfillment Center <span className="text-red-400">*</span>
            </label>
            <select
              value={tplFC}
              onChange={(e) => setTplFC(e.target.value)}
              required
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
            >
              <option value="">Select 3PL center…</option>
              {tplFCs.map((fc) => (
                <option key={fc.id} value={fc.id}>
                  {fc.name} {fc.code ? `(${fc.code})` : ''} {fc.location ? `— ${fc.location}` : ''}
                </option>
              ))}
            </select>
            {tplFCs.length === 0 && (
              <p className="mt-1 text-xs text-muted">No 3PL centers added yet — add one on the Co-Packers page</p>
            )}
          </div>
          <SubmitButtons saving={saving} onCancel={() => setShowShip3pl(false)} label="Ship to 3PL" />
        </form>
      </Modal>

      {/* ── Other Shipment Modal ──────────────────────────────────── */}
      <Modal
        isOpen={showOther}
        onClose={() => setShowOther(false)}
        title="Other Shipment"
      >
        <form onSubmit={handleOtherShip} className="space-y-4">
          <ShipFormFields
            cpId={othCp} setCpId={setOthCp}
            runId={othRun} setRunId={(v) => selectRunAndFill(v, setOthRun, setOthQty, setOthRecipe)}
            recipeId={othRecipe} setRecipeId={setOthRecipe}
            qty={othQty} setQty={setOthQty}
            date={othDate} setDate={setOthDate}
            tracking={othTracking} setTracking={setOthTracking}
            notes={othNotes} setNotes={setOthNotes}
            shipCost={othShipCost} setShipCost={setOthShipCost}
            coPackers={coPackers}
            recipes={recipes}
            productionRuns={productionRuns}
            availableRuns={availableRuns}
          />
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">
              Destination <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={othDestination}
              onChange={(e) => setOthDestination(e.target.value)}
              required
              placeholder="e.g. Direct to customer, Pop-up event"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Sales Channel</label>
            <input
              type="text"
              value={othChannel}
              onChange={(e) => setOthChannel(e.target.value)}
              placeholder="e.g. wholesale, event, sample"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </div>
          <SubmitButtons saving={saving} onCancel={() => setShowOther(false)} label="Create Shipment" />
        </form>
      </Modal>

      {/* ── Edit Movement Modal ─────────────────────────────────── */}
      <Modal
        isOpen={editRow !== null}
        onClose={() => setEditRow(null)}
        title="Edit Movement"
      >
        {editRow && (
          <form onSubmit={handleEditSave} className="space-y-4">
            <div className="rounded-lg border border-border bg-surface/30 px-4 py-3">
              <div className="flex items-center gap-3">
                {editRow.co_packer_id && (
                  <CPBadge coPackerId={editRow.co_packer_id as string} />
                )}
                <span className="font-medium text-text">{editRow.recipeName}</span>
                {editRow.sales_channel && (
                  <Badge color={CHANNEL_BADGE[editRow.sales_channel as string]?.color ?? 'gray'}>
                    {CHANNEL_BADGE[editRow.sales_channel as string]?.label ?? editRow.sales_channel}
                  </Badge>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted">
                <span>
                  Quantity:{' '}
                  <span className="font-mono text-text">
                    {editRow.quantity.toLocaleString()}
                  </span>
                </span>
                <span>
                  Date:{' '}
                  <span className="text-text">
                    {format(new Date(editRow.date), 'MMM d, yyyy')}
                  </span>
                </span>
                <span>
                  From:{' '}
                  <span className="text-text">
                    {fmtLocation(editRow.from_location, coPackers, fulfillmentCenters)}
                  </span>
                </span>
                <span>
                  To:{' '}
                  <span className="text-text">
                    {fmtLocation(editRow.to_location, coPackers, fulfillmentCenters)}
                  </span>
                </span>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Status</label>
              <select
                value={editStatus}
                onChange={(e) => setEditStatus(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              >
                <option value="in_transit">In Transit</option>
                <option value="received">Received</option>
                <option value="delivered">Delivered</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Tracking Number</label>
              <input
                type="text"
                value={editTracking}
                onChange={(e) => setEditTracking(e.target.value)}
                placeholder="Tracking number"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Notes</label>
              <textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                placeholder="Notes…"
              />
            </div>

            <label className="block">
              <span className="mb-1 block text-xs text-muted">Shipping Cost</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={editShipCost}
                onChange={(e) => setEditShipCost(e.target.value)}
                placeholder="e.g. 245.00"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent"
              />
              {editShipCost && editRow?.quantity && editRow.quantity > 0 && (
                <p className="mt-1 text-xs text-accent">
                  = {fmt$(Number(editShipCost) / editRow.quantity)} per unit
                </p>
              )}
            </label>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setEditRow(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}

/* ── Shared Ship Form Fields ──────────────────────────────────── */

function ShipFormFields({
  cpId, setCpId, runId, setRunId, recipeId, setRecipeId,
  qty, setQty, date, setDate, tracking, setTracking,
  notes, setNotes, shipCost, setShipCost,
  coPackers, recipes, productionRuns: _productionRuns, availableRuns,
}: {
  cpId: string; setCpId: (v: string) => void
  runId: string; setRunId: (v: string) => void
  recipeId: string; setRecipeId: (v: string) => void
  qty: string; setQty: (v: string) => void
  date: string; setDate: (v: string) => void
  tracking: string; setTracking: (v: string) => void
  notes: string; setNotes: (v: string) => void
  shipCost: string; setShipCost: (v: string) => void
  coPackers: CoPacker[]
  recipes: Recipe[]
  productionRuns: ProductionRun[]
  availableRuns: (cpId: string) => ProductionRun[]
}) {
  const runs = availableRuns(cpId)

  return (
    <>
      {/* Co-Packer */}
      <div>
        <label className="mb-1 block text-xs font-medium text-muted">Co-Packer</label>
        <select
          value={cpId}
          onChange={(e) => { setCpId(e.target.value); setRunId('') }}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
        >
          <option value="">All co-packers</option>
          {coPackers.map((cp) => (
            <option key={cp.id} value={cp.id}>
              {cp.name} ({cp.short_code})
            </option>
          ))}
        </select>
      </div>

      {/* Production Run */}
      <div>
        <label className="mb-1 block text-xs font-medium text-muted">Production Run</label>
        <select
          value={runId}
          onChange={(e) => setRunId(e.target.value)}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
        >
          <option value="">Select a completed run… (optional)</option>
          {runs.map((run) => {
            const recipe = recipes.find((r) => r.id === run.recipe_id)
            const cp = coPackers.find((c) => c.id === run.co_packer_id)
            return (
              <option key={run.id} value={run.id}>
                {run.run_number} — {recipe?.name ?? '?'} ({recipe?.sku ?? '?'})
                {cp ? ` @ ${cp.short_code}` : ''} — {run.produced_quantity?.toLocaleString() ?? '?'} units
              </option>
            )
          })}
        </select>
      </div>

      {/* Recipe (if no run selected) */}
      {!runId && (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted">
            Product (SKU) <span className="text-red-400">*</span>
          </label>
          <select
            value={recipeId}
            onChange={(e) => setRecipeId(e.target.value)}
            required
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
          >
            <option value="">Select product…</option>
            {recipes
              .filter((r) => r.status === 'active')
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.sku})
                </option>
              ))}
          </select>
        </div>
      )}

      {/* Quantity + Date */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted">
            Quantity <span className="text-red-400">*</span>
          </label>
          <input
            type="number"
            min="1"
            step="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted">Ship Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </div>
      </div>

      {/* Tracking */}
      <div>
        <label className="mb-1 block text-xs font-medium text-muted">Tracking Number</label>
        <input
          type="text"
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          placeholder="Optional"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
        />
      </div>

      {/* Shipping Cost */}
      <label className="block">
        <span className="mb-1 block text-xs text-muted">Shipping Cost</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={shipCost}
          onChange={(e) => setShipCost(e.target.value)}
          placeholder="e.g. 245.00"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent"
        />
        {shipCost && qty && Number(qty) > 0 && (
          <p className="mt-1 text-xs text-accent">
            = {fmt$(Number(shipCost) / Number(qty))} per unit
          </p>
        )}
      </label>

      {/* Notes */}
      <div>
        <label className="mb-1 block text-xs font-medium text-muted">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
          placeholder="Optional notes…"
        />
      </div>
    </>
  )
}

/* ── Submit Buttons ───────────────────────────────────────────── */

function SubmitButtons({ saving, onCancel, label }: { saving: boolean; onCancel: () => void; label: string }) {
  return (
    <div className="flex justify-end gap-3 pt-2">
      <button
        type="button"
        onClick={onCancel}
        className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        {saving ? 'Saving…' : label}
      </button>
    </div>
  )
}
