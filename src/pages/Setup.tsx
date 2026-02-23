import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { sanitize } from '../lib/sanitizePayload'
import { dbInsert } from '../lib/dbWrite'
import { useAuth } from '../contexts/AuthContext'

export default function Setup() {
  const navigate = useNavigate()
  const { refreshAppUser } = useAuth()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }

    setLoading(true)
    try {
      // 1. Sign up (or reuse existing auth user)
      let authUid: string
      const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({
        email,
        password,
      })
      if (signUpErr) {
        // If user already registered, try signing in directly
        if (signUpErr.message.includes('already registered')) {
          const { data: signInData, error: signInErr2 } = await supabase.auth.signInWithPassword({ email, password })
          if (signInErr2 || !signInData.user) {
            setError(signInErr2?.message ?? 'Sign in failed')
            return
          }
          authUid = signInData.user.id
        } else {
          setError(signUpErr.message)
          return
        }
      } else if (!signUpData.user) {
        setError('Sign up failed')
        return
      } else {
        authUid = signUpData.user.id
        // 2. Sign in immediately so the client is authenticated for the insert
        const { error: signInErr } = await supabase.auth.signInWithPassword({
          email,
          password,
        })
        if (signInErr) {
          setError(signInErr.message)
          return
        }
      }

      // 3. Insert app_users row as owner (now running as authenticated)
      const { error: insertErr } = await dbInsert('app_users',
        sanitize('app_users', {
          auth_id: authUid,
          email,
          full_name: fullName,
          role: 'owner',
          status: 'active',
          last_login: new Date().toISOString(),
        }),
      )
      if (insertErr) {
        setError(insertErr.message)
        return
      }

      // 4. Refresh context and redirect
      await refreshAppUser()
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-text">FitBake</h1>
          <p className="mt-1 text-xs text-muted">Create Owner Account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Full Name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 focus:border-accent focus:outline-none"
              placeholder="Jane Doe"
            />
          </div>
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
            disabled={loading}
            className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
          >
            {loading ? 'Creating Account...' : 'Create Owner Account'}
          </button>
        </form>
      </div>
    </div>
  )
}
