import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import LoadingScreen from './components/LoadingScreen'
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
  const { session, appUser, loading, needsSetup } = useAuth()
  if (loading) return <LoadingScreen />
  if (needsSetup) return <Navigate to="/setup" replace />
  if (session && appUser) return <Navigate to="/" replace />
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
  )
}
