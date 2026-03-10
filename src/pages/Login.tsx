import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { useToast } from '../components/Toast'
import { logActivity } from '../lib/activityLog'
import { supabase } from '../lib/supabase'
import { Sun, Moon } from 'lucide-react'

export default function Login() {
  const { signIn, appUser, passwordRecovery, clearPasswordRecovery } = useAuth()
  const { theme, toggle: toggleTheme } = useTheme()
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showReset, setShowReset] = useState(false)
  const [resetEmail, setResetEmail] = useState('')
  const [resetSent, setResetSent] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)
  const [noAccount, setNoAccount] = useState(false)

  // Password recovery state
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [updatingPassword, setUpdatingPassword] = useState(false)

  // Show session-expired toast when redirected from safeQuery
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('expired') === '1') {
      toast.error('Your session has expired. Please sign in again.')
      // Clean up the URL
      window.history.replaceState({}, '', '/login')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setNoAccount(false)
    setLoading(true)
    try {
      const err = await signIn(email, password)
      if (err) {
        setError(err)
      }
      // onAuthStateChange handles the rest
    } catch (err: any) {
      setError(err?.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  // After successful auth, if appUser is still null, show "not authorized"
  // This is handled via the ProtectedRoute in App.tsx

  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    setResetLoading(true)
    const { error: err } = await supabase.auth.resetPasswordForEmail(resetEmail, {
      redirectTo: `${window.location.origin}/login`,
    })
    setResetLoading(false)
    if (err) {
      setError(err.message)
    } else {
      setResetSent(true)
    }
  }

  async function handleUpdatePassword(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setUpdatingPassword(true)
    const { error: err } = await supabase.auth.updateUser({ password: newPassword })
    setUpdatingPassword(false)

    if (err) {
      setError(err.message)
    } else {
      clearPasswordRecovery()
      setNewPassword('')
      setConfirmPassword('')
      toast.success('Password updated successfully. Please sign in.')
      // Sign out so user logs in with new password
      await supabase.auth.signOut()
    }
  }

  // Log activity after successful login (when appUser is set)
  if (appUser && !noAccount) {
    logActivity(appUser.id, 'login', 'user', appUser.id)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="fixed top-4 right-4 rounded-lg p-2 text-muted transition-colors hover:bg-hover-strong hover:text-text"
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-text">FitBake</h1>
          <p className="mt-1 text-xs text-muted">Multi Co-Packer Manager</p>
        </div>

        {passwordRecovery ? (
          <form onSubmit={handleUpdatePassword} className="space-y-4">
            <p className="text-sm text-text text-center">Enter your new password</p>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">New Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 focus:border-accent focus:outline-none"
                placeholder="••••••••"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Confirm Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 focus:border-accent focus:outline-none"
                placeholder="••••••••"
              />
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={updatingPassword}
              className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
            >
              {updatingPassword ? 'Updating...' : 'Update Password'}
            </button>
          </form>
        ) : showReset ? (
          resetSent ? (
            <div className="text-center">
              <p className="text-sm text-green-400">Password reset email sent.</p>
              <button
                onClick={() => { setShowReset(false); setResetSent(false) }}
                className="mt-4 text-xs text-accent hover:underline"
              >
                Back to login
              </button>
            </div>
          ) : (
            <form onSubmit={handleReset} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Email</label>
                <input
                  type="email"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  required
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 focus:border-accent focus:outline-none"
                  placeholder="you@company.com"
                />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={resetLoading}
                className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
              >
                {resetLoading ? 'Sending...' : 'Send Reset Link'}
              </button>
              <button
                type="button"
                onClick={() => { setShowReset(false); setError('') }}
                className="w-full text-xs text-muted hover:text-text"
              >
                Back to login
              </button>
            </form>
          )
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 focus:border-accent focus:outline-none"
                placeholder="you@company.com"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 focus:border-accent focus:outline-none"
                placeholder="••••••••"
              />
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            {noAccount && (
              <p className="text-xs text-red-400">Account not authorized. Contact your admin.</p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
            <button
              type="button"
              onClick={() => { setShowReset(true); setError('') }}
              className="w-full text-xs text-muted hover:text-text"
            >
              Forgot password?
            </button>
            <button
              type="button"
              onClick={() => {
                Object.keys(localStorage).forEach(key => {
                  if (key.includes('auth') || key.includes('supabase') || key.includes('fitbake')) {
                    localStorage.removeItem(key)
                  }
                })
                window.location.reload()
              }}
              className="w-full text-xs text-muted/50 hover:text-muted"
              style={{ marginTop: 12, fontSize: 11 }}
            >
              Having trouble? Click here to reset
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
