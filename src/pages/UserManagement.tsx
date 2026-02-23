import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase, supabaseUrl, supabaseAnonKey } from '../lib/supabase'
import { sanitize } from '../lib/sanitizePayload'
import { dbUpdate } from '../lib/dbWrite'
import { safeQuery } from '../lib/safeQuery'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import { logActivity } from '../lib/activityLog'
import { fmtDateTime } from '../lib/format'
import PageHeader from '../components/PageHeader'
import DataTable, { type Column } from '../components/DataTable'
import Modal from '../components/Modal'
import Badge from '../components/Badge'
import ConfirmDialog from '../components/ConfirmDialog'
import type { AppUser, AppUserRole, ActivityLog } from '../types/database'
import { UserPlus } from 'lucide-react'

/* ── Row types for DataTable (needs Record<string, unknown>) ── */

type UserRow = AppUser & Record<string, unknown>
type ActivityRow = ActivityLog & { user_name?: string } & Record<string, unknown>

/* ── Role badge colors ─────────────────────────────────────── */

const roleBadgeColor: Record<string, 'amber' | 'purple' | 'accent' | 'gray'> = {
  owner: 'amber',
  admin: 'purple',
  manager: 'accent',
  viewer: 'gray',
}

const statusBadgeColor: Record<string, 'green' | 'amber' | 'red'> = {
  active: 'green',
  invited: 'amber',
  disabled: 'red',
}

/* ════════════════════════════════════════════════════════════════ */

export default function UserManagement() {
  const { can, appUser, session } = useAuth()
  const toast = useToast()

  /* ── State ─────────────────────────────────────────────────── */
  const [tab, setTab] = useState<'users' | 'activity'>('users')
  const [users, setUsers] = useState<AppUser[]>([])
  const [activityLogs, setActivityLogs] = useState<(ActivityLog & { user_name?: string })[]>([])
  const [loading, setLoading] = useState(true)

  // Invite modal
  const [showInvite, setShowInvite] = useState(false)
  const [inviteForm, setInviteForm] = useState({
    email: '',
    full_name: '',
    role: 'viewer' as AppUserRole,
    phone: '',
    password: '',
  })
  const [inviteSaving, setInviteSaving] = useState(false)

  // Edit modal
  const [editUser, setEditUser] = useState<AppUser | null>(null)
  const [editForm, setEditForm] = useState({ role: 'viewer' as AppUserRole, status: 'active' as string })
  const [editSaving, setEditSaving] = useState(false)

  // Delete confirm
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteSaving, setDeleteSaving] = useState(false)

  // Activity filter
  const [activityFilterUser, setActivityFilterUser] = useState('')

  /* ── Loaders ───────────────────────────────────────────────── */

  const loadUsers = useCallback(async () => {
    const { data } = await safeQuery(() =>
      supabase
        .from('app_users')
        .select('*')
        .order('created_at', { ascending: true })
    )
    setUsers((data as AppUser[]) ?? [])
  }, [])

  const loadActivity = useCallback(async () => {
    const { data } = await safeQuery(() =>
      supabase
        .from('activity_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100)
    )

    if (data) {
      // Fetch user names
      const { data: allUsers } = await safeQuery(() => supabase.from('app_users').select('id, full_name'))
      const nameMap = new Map(((allUsers ?? []) as any[]).map((u: { id: string; full_name: string }) => [u.id, u.full_name]))
      const enriched = data.map((log: ActivityLog) => ({
        ...log,
        user_name: log.user_id ? nameMap.get(log.user_id) ?? 'Unknown' : 'System',
      }))
      setActivityLogs(enriched)
    }
  }, [])

  useEffect(() => {
    async function init() {
      setLoading(true)
      await Promise.all([loadUsers(), loadActivity()])
      setLoading(false)
    }
    init()
  }, [loadUsers, loadActivity])

  /* ── Permission gate ───────────────────────────────────────── */

  if (!can('manage_users')) return <Navigate to="/" replace />

  /* ── Invite user ───────────────────────────────────────────── */

  async function handleInvite() {
    if (!inviteForm.email || !inviteForm.full_name || !inviteForm.password) {
      toast.error('Email, name, and temporary password are required')
      return
    }
    if (inviteForm.password.length < 6) {
      toast.error('Password must be at least 6 characters')
      return
    }
    setInviteSaving(true)

    try {
      // Create auth user via direct fetch to avoid any Supabase client issues
      let newUserId: string
      const res = await fetch(`${supabaseUrl}/auth/v1/signup`, {
        method: 'POST',
        headers: { 'apikey': supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteForm.email, password: inviteForm.password }),
      })
      const body = await res.json()
      if (!res.ok || !body.user?.id) {
        toast.error(body.msg || body.error_description || 'Failed to create user')
        return
      }
      newUserId = body.user.id

      // Insert app_users row via direct fetch
      const accessToken = session?.access_token
      if (!accessToken) {
        toast.error('Session expired. Please log in again.')
        return
      }

      const sanitizedPayload = sanitize('app_users', {
        auth_id: newUserId,
        email: inviteForm.email,
        full_name: inviteForm.full_name,
        role: inviteForm.role,
        status: 'invited',
        phone: inviteForm.phone || null,
        invited_by: appUser?.id ?? null,
      })

      const insertRes = await fetch(`${supabaseUrl}/rest/v1/app_users`, {
        method: 'POST',
        headers: {
          'apikey': supabaseAnonKey,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify(sanitizedPayload),
      })
      if (!insertRes.ok) {
        const errBody = await insertRes.json().catch(() => ({}))
        toast.error(errBody.message || 'Failed to save user record')
        return
      }

      logActivity(appUser?.id, 'invite_user', 'user', newUserId, {
        email: inviteForm.email,
        role: inviteForm.role,
      })
      toast.success(`Invited ${inviteForm.full_name}`)
      setShowInvite(false)
      setInviteForm({ email: '', full_name: '', role: 'viewer', phone: '', password: '' })
      loadUsers()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to invite user')
    } finally {
      setInviteSaving(false)
    }
  }

  /* ── Edit user ─────────────────────────────────────────────── */

  function openEditUser(user: AppUser) {
    setEditUser(user)
    setEditForm({ role: user.role, status: user.status })
  }

  async function handleEditSave() {
    if (!editUser) return
    setEditSaving(true)
    try {
      const { error } = await dbUpdate('app_users', sanitize('app_users', {
          role: editForm.role,
          status: editForm.status,
          updated_at: new Date().toISOString(),
        }), 'id', editUser.id)
      if (error) {
        toast.error(error.message)
        return
      }
      logActivity(appUser?.id, 'update_user', 'user', editUser.id, {
        role: editForm.role,
        status: editForm.status,
      })
      toast.success(`Updated ${editUser.full_name}`)
      setEditUser(null)
      loadUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update user')
    } finally {
      setEditSaving(false)
    }
  }

  /* ── Disable user (soft delete) ────────────────────────────── */

  async function handleDisableUser() {
    if (!editUser) return
    setDeleteSaving(true)
    try {
      const { error } = await dbUpdate('app_users', sanitize('app_users', { status: 'disabled', updated_at: new Date().toISOString() }), 'id', editUser.id)
      if (error) {
        toast.error(error.message)
        return
      }
      logActivity(appUser?.id, 'disable_user', 'user', editUser.id)
      toast.success(`Disabled ${editUser.full_name}`)
      setConfirmDelete(false)
      setEditUser(null)
      loadUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to disable user')
    } finally {
      setDeleteSaving(false)
    }
  }

  /* ── Users table columns ───────────────────────────────────── */

  const userColumns: Column<UserRow>[] = [
    {
      key: 'full_name',
      label: 'Name',
      render: (row) => <span className="font-medium text-text">{row.full_name}</span>,
    },
    { key: 'email', label: 'Email' },
    {
      key: 'role',
      label: 'Role',
      render: (row) => (
        <Badge color={roleBadgeColor[row.role] ?? 'gray'}>{row.role}</Badge>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (row) => (
        <Badge color={statusBadgeColor[row.status] ?? 'gray'}>{row.status}</Badge>
      ),
    },
    {
      key: 'last_login',
      label: 'Last Login',
      render: (row) => (
        <span className="text-muted">{row.last_login ? fmtDateTime(row.last_login) : 'Never'}</span>
      ),
    },
  ]

  /* ── Activity table columns ────────────────────────────────── */

  const filteredLogs = activityFilterUser
    ? activityLogs.filter((l) => l.user_id === activityFilterUser)
    : activityLogs

  const activityColumns: Column<ActivityRow>[] = [
    {
      key: 'user_name',
      label: 'User',
      render: (row) => <span className="font-medium text-text">{row.user_name}</span>,
    },
    { key: 'action', label: 'Action' },
    {
      key: 'entity_type',
      label: 'Entity',
      render: (row) => (
        <span className="text-muted">
          {row.entity_type ? `${row.entity_type}` : '—'}
        </span>
      ),
    },
    {
      key: 'details',
      label: 'Details',
      render: (row) => (
        <span className="text-xs text-muted truncate max-w-[200px] inline-block">
          {row.details ? JSON.stringify(row.details) : '—'}
        </span>
      ),
    },
    {
      key: 'created_at',
      label: 'Time',
      render: (row) => <span className="text-muted">{fmtDateTime(row.created_at)}</span>,
    },
  ]

  /* ── Render ────────────────────────────────────────────────── */

  return (
    <>
      <PageHeader
        title="User Management"
        subtitle="Manage team members and view activity"
      />

      {/* Tabs */}
      <div className="mb-6 flex gap-1 rounded-lg bg-surface p-1 w-fit">
        <button
          onClick={() => setTab('users')}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            tab === 'users' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text'
          }`}
        >
          Users
        </button>
        <button
          onClick={() => setTab('activity')}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            tab === 'activity' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text'
          }`}
        >
          Activity Log
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-accent" />
        </div>
      ) : tab === 'users' ? (
        <>
          {/* Invite button */}
          <div className="mb-4 flex justify-end">
            <button
              onClick={() => setShowInvite(true)}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              <UserPlus size={16} /> Invite User
            </button>
          </div>

          <DataTable
            columns={userColumns}
            data={users as UserRow[]}
            onRowClick={(row) => openEditUser(row as AppUser)}
            emptyMessage="No users yet"
          />
        </>
      ) : (
        <>
          {/* Filter */}
          <div className="mb-4 flex items-center gap-3">
            <label className="text-xs text-muted">Filter by user:</label>
            <select
              value={activityFilterUser}
              onChange={(e) => setActivityFilterUser(e.target.value)}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text"
            >
              <option value="">All users</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </select>
          </div>

          <DataTable
            columns={activityColumns}
            data={filteredLogs as ActivityRow[]}
            emptyMessage="No activity recorded yet"
          />
        </>
      )}

      {/* ── Invite Modal ────────────────────────────────────── */}
      <Modal isOpen={showInvite} onClose={() => setShowInvite(false)} title="Invite User">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Full Name *</label>
            <input
              value={inviteForm.full_name}
              onChange={(e) => setInviteForm((p) => ({ ...p, full_name: e.target.value }))}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Email *</label>
            <input
              type="email"
              value={inviteForm.email}
              onChange={(e) => setInviteForm((p) => ({ ...p, email: e.target.value }))}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Role</label>
            <select
              value={inviteForm.role}
              onChange={(e) => setInviteForm((p) => ({ ...p, role: e.target.value as AppUserRole }))}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
            >
              <option value="admin">Admin</option>
              <option value="manager">Manager</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Phone</label>
            <input
              value={inviteForm.phone}
              onChange={(e) => setInviteForm((p) => ({ ...p, phone: e.target.value }))}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Temporary Password *</label>
            <input
              type="password"
              value={inviteForm.password}
              onChange={(e) => setInviteForm((p) => ({ ...p, password: e.target.value }))}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
              placeholder="Min 6 characters"
            />
            <p className="mt-1 text-[11px] text-muted">Share this with the user. They can reset via Forgot Password.</p>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => setShowInvite(false)}
              className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
            <button
              onClick={handleInvite}
              disabled={inviteSaving}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {inviteSaving ? 'Inviting...' : 'Send Invite'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Edit User Modal ─────────────────────────────────── */}
      <Modal isOpen={!!editUser} onClose={() => setEditUser(null)} title={editUser ? `Edit ${editUser.full_name}` : ''}>
        {editUser && (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Email</label>
              <p className="text-sm text-text">{editUser.email}</p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Role</label>
              <select
                value={editForm.role}
                onChange={(e) => setEditForm((p) => ({ ...p, role: e.target.value as AppUserRole }))}
                disabled={editUser.id === appUser?.id}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none disabled:opacity-50"
              >
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="manager">Manager</option>
                <option value="viewer">Viewer</option>
              </select>
              {editUser.id === appUser?.id && (
                <p className="mt-1 text-[11px] text-muted">You cannot change your own role</p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Status</label>
              <select
                value={editForm.status}
                onChange={(e) => setEditForm((p) => ({ ...p, status: e.target.value }))}
                disabled={editUser.id === appUser?.id}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none disabled:opacity-50"
              >
                <option value="active">Active</option>
                <option value="invited">Invited</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
            <div className="flex items-center justify-between pt-2">
              {editUser.role !== 'owner' && editUser.id !== appUser?.id ? (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="rounded-lg px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-400/10"
                >
                  Disable User
                </button>
              ) : (
                <div />
              )}
              <div className="flex gap-3">
                <button
                  onClick={() => setEditUser(null)}
                  className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-text"
                >
                  Cancel
                </button>
                <button
                  onClick={handleEditSave}
                  disabled={editSaving}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {editSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Disable Confirm ─────────────────────────────────── */}
      <ConfirmDialog
        isOpen={confirmDelete}
        title={`Disable ${editUser?.full_name}?`}
        message="This user will no longer be able to log in. You can re-enable them later."
        confirmLabel="Disable"
        danger
        loading={deleteSaving}
        onConfirm={handleDisableUser}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  )
}
