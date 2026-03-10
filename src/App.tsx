import { Component, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import LoadingScreen from './components/LoadingScreen'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 40, fontFamily: 'monospace', color: '#f87171', background: '#1a1a1a', minHeight: '100vh' }}>
        <h1 style={{ fontSize: 20 }}>Page Error</h1>
        <pre style={{ whiteSpace: 'pre-wrap', marginTop: 16, fontSize: 14 }}>{this.state.error.message}</pre>
        <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 12, color: '#888' }}>{this.state.error.stack}</pre>
        <button onClick={() => { this.setState({ error: null }); window.location.reload() }} style={{ marginTop: 16, padding: '8px 16px', background: '#3B82F6', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Reload</button>
      </div>
    )
    return this.props.children
  }
}
import AppLayout from './layouts/AppLayout'
import Dashboard from './pages/Dashboard'
import CoPackers from './pages/CoPackers'
import Ingredients from './pages/Ingredients'
import Suppliers from './pages/Suppliers'
import Shipments from './pages/Shipments'
import CpInventory from './pages/CpInventory'
import ProductionRuns from './pages/ProductionRuns'
import Reconciliation from './pages/Reconciliation'
import FinishedGoods from './pages/FinishedGoods'
import Recipes from './pages/Recipes'
import Reports from './pages/Reports'
import ImportData from './pages/ImportData'
import ProductionPlanner from './pages/ProductionPlanner'
import Login from './pages/Login'
import Setup from './pages/Setup'
import UserManagement from './pages/UserManagement'

/* ── Route guards ─────────────────────────────────────────── */

function ProtectedRoute() {
  const { session, appUser, loading, needsSetup } = useAuth()
  if (loading) return <LoadingScreen />
  if (needsSetup) return <Navigate to="/setup" replace />
  if (!session) return <Navigate to="/login" replace />
  if (!appUser) return <Navigate to="/login" replace />
  return <Outlet />
}

function PublicOnlyRoute() {
  const { session, appUser, loading, needsSetup, passwordRecovery } = useAuth()
  if (loading) return <LoadingScreen />
  if (needsSetup) return <Navigate to="/setup" replace />
  if (session && appUser && !passwordRecovery) return <Navigate to="/" replace />
  return <Outlet />
}

function SetupRoute() {
  const { loading, needsSetup, session, appUser } = useAuth()
  if (loading) return <LoadingScreen />
  if (!needsSetup && session && appUser) return <Navigate to="/" replace />
  if (!needsSetup && !session) return <Navigate to="/login" replace />
  return <Setup />
}

/* ── App ──────────────────────────────────────────────────── */

export default function App() {
  return (
    <ErrorBoundary>
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route element={<PublicOnlyRoute />}>
          <Route path="login" element={<Login />} />
        </Route>

        {/* Setup */}
        <Route path="setup" element={<SetupRoute />} />

        {/* Protected routes */}
        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="co-packers" element={<CoPackers />} />
            <Route path="ingredients" element={<Ingredients />} />
            <Route path="suppliers" element={<Suppliers />} />
            <Route path="shipments" element={<Shipments />} />
            <Route path="cp-inventory" element={<CpInventory />} />
            <Route path="production-runs" element={<ProductionRuns />} />
            <Route path="production-planner" element={<ProductionPlanner />} />
            <Route path="reconciliation" element={<Reconciliation />} />
            <Route path="finished-goods" element={<FinishedGoods />} />
            <Route path="recipes" element={<Recipes />} />
            <Route path="reports" element={<Reports />} />
            <Route path="import" element={<ImportData />} />
            <Route path="users" element={<UserManagement />} />
          </Route>
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  )
}
