import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import Badge from '../components/Badge'
import AIChatPanel from '../components/AIChatPanel'
import type { Permission } from '../lib/permissions'
import {
  LayoutDashboard,
  Factory,
  FlaskConical,
  Truck,
  Send,
  Warehouse,
  Cog,
  Scale,
  Package,
  BookOpen,
  BarChart3,
  Menu,
  X,
  Upload,
  Calculator,
  Users,
  LogOut,
  Sun,
  Moon,
} from 'lucide-react'

/* ── Nav item type ───────────────────────────────────────────── */

interface NavItem {
  to: string
  label: string
  icon: typeof LayoutDashboard
  badgeKey?: 'dashboard' | 'ingredients' | 'reconciliation'
  permission?: Permission
}

const navGroups: { items: NavItem[] }[] = [
  {
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, badgeKey: 'dashboard' },
    ],
  },
  {
    items: [
      { to: '/co-packers', label: 'Co-Packers', icon: Factory },
      { to: '/suppliers', label: 'Suppliers & POs', icon: Truck },
    ],
  },
  {
    items: [
      { to: '/ingredients', label: 'Ingredients', icon: FlaskConical, badgeKey: 'ingredients' },
      { to: '/recipes', label: 'Recipes / BOM', icon: BookOpen },
    ],
  },
  {
    items: [
      { to: '/shipments', label: 'Shipments to CP', icon: Send },
      { to: '/cp-inventory', label: 'CP Inventory', icon: Warehouse },
      { to: '/production-runs', label: 'Production Orders', icon: Cog },
      { to: '/production-planner', label: 'Production Planner', icon: Calculator },
    ],
  },
  {
    items: [
      { to: '/finished-goods', label: 'Finished Goods', icon: Package },
      { to: '/reconciliation', label: 'Reconciliation', icon: Scale, badgeKey: 'reconciliation' },
    ],
  },
  {
    items: [
      { to: '/reports', label: 'Reports', icon: BarChart3, permission: 'view_reports' },
    ],
  },
  {
    items: [
      { to: '/import', label: 'Import Data', icon: Upload, permission: 'import_data' },
    ],
  },
  {
    items: [
      { to: '/users', label: 'User Management', icon: Users, permission: 'manage_users' },
    ],
  },
]

/* ── Badge counts ────────────────────────────────────────────── */

interface BadgeCounts {
  dashboard: number
  ingredients: number
  reconciliation: number
}

function useBadgeCounts(): BadgeCounts {
  const [counts, setCounts] = useState<BadgeCounts>({
    dashboard: 0,
    ingredients: 0,
    reconciliation: 0,
  })

  useEffect(() => {
    async function load() {
      const [reconRes, ingRes, invRes] = await Promise.all([
        // Unreconciled: complete + flagged runs
        supabase
          .from('production_runs')
          .select('id', { count: 'exact', head: true })
          .in('status', ['complete', 'flagged']),
        // Ingredients below reorder point
        supabase.from('ingredients').select('id, reorder_point'),
        supabase.from('ingredient_inventory').select('ingredient_id, quantity, location_type'),
      ])

      const unreconCount = reconRes.count ?? 0

      // ingredients below reorder
      const ings = ingRes.data ?? []
      const inv = invRes.data ?? []
      let lowIngCount = 0
      for (const ing of ings) {
        if (!ing.reorder_point) continue
        const total = inv
          .filter((iv) => iv.ingredient_id === ing.id)
          .reduce((s, iv) => s + (iv.quantity ?? 0), 0)
        if (total < ing.reorder_point) lowIngCount++
      }

      // Dashboard badge = unreconciled + low stock ingredients
      const dashCount = unreconCount + lowIngCount

      setCounts({
        dashboard: dashCount,
        ingredients: lowIngCount,
        reconciliation: unreconCount,
      })
    }

    load()
    const interval = setInterval(load, 30000) // refresh every 30s
    return () => clearInterval(interval)
  }, [])

  return counts
}

/* ── Responsive hook ─────────────────────────────────────────── */

function useBreakpoint() {
  const [width, setWidth] = useState(window.innerWidth)
  useEffect(() => {
    const handler = () => setWidth(window.innerWidth)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])
  return { isMobile: width < 768, isTablet: width >= 768 && width < 1024, isDesktop: width >= 1024 }
}

/* ── Role badge colors ───────────────────────────────────────── */

const roleBadgeColor: Record<string, 'amber' | 'purple' | 'accent' | 'gray'> = {
  owner: 'amber',
  admin: 'purple',
  manager: 'accent',
  viewer: 'gray',
}

/* ════════════════════════════════════════════════════════════════ */

export default function AppLayout() {
  const badges = useBadgeCounts()
  const { isMobile, isTablet } = useBreakpoint()
  const { theme, toggle: toggleTheme } = useTheme()
  const [mobileOpen, setMobileOpen] = useState(false)
  const { appUser, role, can, signOut } = useAuth()

  // Collapsed = icon-only sidebar for tablet
  const collapsed = isTablet

  // Close mobile menu on nav
  function handleNavClick() {
    if (isMobile) setMobileOpen(false)
  }

  // Filter nav items by permission
  function filterItems(items: NavItem[]): NavItem[] {
    return items.filter((item) => !item.permission || can(item.permission))
  }

  /* ── Badge component ─────────────────────────────────────── */

  function NavBadge({ count }: { count: number }) {
    if (count === 0) return null
    const color = count >= 3 ? 'bg-red-500' : 'bg-amber-500'
    return (
      <span
        className={`ml-auto flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white ${color}`}
      >
        {count > 99 ? '99+' : count}
      </span>
    )
  }

  /* ── User section component ─────────────────────────────── */

  function UserSection() {
    if (!appUser) return null
    const initials = appUser.full_name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)

    if (collapsed) {
      return (
        <div className="border-t border-border px-3 py-3 flex flex-col items-center gap-2">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/20 text-xs font-bold text-accent"
            title={`${appUser.full_name} (${role})`}
          >
            {initials}
          </div>
          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-text"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            onClick={signOut}
            title="Sign out"
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-text"
          >
            <LogOut size={16} />
          </button>
        </div>
      )
    }

    return (
      <div className="border-t border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/20 text-xs font-bold text-accent">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text">{appUser.full_name}</p>
            {role && (
              <Badge color={roleBadgeColor[role] ?? 'gray'}>
                {role}
              </Badge>
            )}
          </div>
          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-text"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            onClick={signOut}
            title="Sign out"
            className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-text"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    )
  }

  /* ── Sidebar content (shared between mobile overlay & desktop) */

  function SidebarContent() {
    return (
      <>
        {/* Logo */}
        <div className={`px-5 pt-6 pb-4 ${collapsed ? 'px-3 text-center' : ''}`}>
          <h1 className={`font-bold tracking-tight text-text ${collapsed ? 'text-sm' : 'text-lg'}`}>
            {collapsed ? 'FB' : 'FitBake'}
          </h1>
          {!collapsed && (
            <p className="text-xs text-muted mt-0.5">Multi Co-Packer Manager</p>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {navGroups.map((group, gi) => {
            const filtered = filterItems(group.items)
            if (filtered.length === 0) return null
            return (
              <div key={gi}>
                {gi > 0 && (
                  <div className="my-2 mx-2 border-t border-border" />
                )}
                <ul className="space-y-0.5">
                  {filtered.map((item) => {
                    const badgeCount = item.badgeKey ? badges[item.badgeKey] : 0
                    return (
                      <li key={item.to} className="relative">
                        <NavLink
                          to={item.to}
                          end={item.to === '/'}
                          onClick={handleNavClick}
                          title={collapsed ? item.label : undefined}
                          className={({ isActive }) =>
                            `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                              collapsed ? 'justify-center' : ''
                            } ${
                              isActive
                                ? 'bg-accent/15 text-accent font-medium'
                                : 'text-muted hover:text-text hover:bg-hover'
                            }`
                          }
                        >
                          <item.icon size={18} />
                          {!collapsed && item.label}
                          {!collapsed && <NavBadge count={badgeCount} />}
                          {collapsed && badgeCount > 0 && (
                            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-red-500" />
                          )}
                        </NavLink>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </nav>

        {/* User section */}
        <UserSection />
      </>
    )
  }

  /* ── Mobile overlay sidebar ────────────────────────────────── */

  if (isMobile) {
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
          <button
            onClick={() => setMobileOpen(true)}
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-text"
          >
            <Menu size={20} />
          </button>
          <h1 className="text-sm font-bold text-text">FitBake</h1>
        </header>

        {/* Overlay */}
        {mobileOpen && (
          <div className="fixed inset-0 z-50 flex">
            <div className="absolute inset-0 bg-overlay" onClick={() => setMobileOpen(false)} />
            <aside className="relative z-10 w-[260px] shrink-0 bg-surface flex flex-col border-r border-border">
              <div className="flex justify-end px-3 pt-3">
                <button
                  onClick={() => setMobileOpen(false)}
                  className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-text"
                >
                  <X size={18} />
                </button>
              </div>
              <SidebarContent />
            </aside>
          </div>
        )}

        <main className="flex-1 overflow-y-auto bg-bg p-4">
          <Outlet />
        </main>
        <AIChatPanel />
      </div>
    )
  }

  /* ── Desktop / Tablet layout ───────────────────────────────── */

  return (
    <div className="flex h-screen overflow-hidden">
      <aside
        className={`shrink-0 bg-surface flex flex-col border-r border-border transition-all duration-200 ${
          collapsed ? 'w-[60px]' : 'w-[220px]'
        }`}
      >
        <SidebarContent />
      </aside>

      <main className="flex-1 overflow-y-auto bg-bg p-8">
        <Outlet />
      </main>
      <AIChatPanel />
    </div>
  )
}
