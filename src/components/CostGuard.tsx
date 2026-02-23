import type { ReactNode } from 'react'
import { useAuth } from '../contexts/AuthContext'

/** Renders children if user can view costs, else shows a dash placeholder */
export default function CostGuard({ children }: { children: ReactNode }) {
  const { can } = useAuth()
  if (!can('view_costs')) return <span className="text-muted">—</span>
  return <>{children}</>
}
