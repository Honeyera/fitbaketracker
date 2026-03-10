import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { sanitize } from '../lib/sanitizePayload'
import { dbUpdate } from '../lib/dbWrite'
import { can as canCheck, type Permission } from '../lib/permissions'
import type { AppUser, AppUserRole } from '../types/database'

/* ── Context shape ─────────────────────────────────────────── */

interface AuthCtx {
  session: Session | null
  appUser: AppUser | null
  role: AppUserRole | null
  loading: boolean
  needsSetup: boolean
  passwordRecovery: boolean
  clearPasswordRecovery: () => void
  can: (permission: Permission) => boolean
  signIn: (email: string, password: string) => Promise<string | null>
  signOut: () => Promise<void>
  refreshAppUser: () => Promise<void>
}

const Ctx = createContext<AuthCtx>({
  session: null,
  appUser: null,
  role: null,
  loading: true,
  needsSetup: false,
  passwordRecovery: false,
  clearPasswordRecovery: () => {},
  can: () => false,
  signIn: async () => null,
  signOut: async () => {},
  refreshAppUser: async () => {},
})

export const useAuth = () => useContext(Ctx)

/* ── Provider ──────────────────────────────────────────────── */

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [authReady, setAuthReady] = useState(false)
  const [passwordRecovery, setPasswordRecovery] = useState(false)

  const clearPasswordRecovery = useCallback(() => setPasswordRecovery(false), [])

  const role = appUser?.role ?? null

  /* Permission check */
  const can = useCallback(
    (permission: Permission) => canCheck(role, permission),
    [role],
  )

  /* Sign in */
  const signIn = useCallback(async (email: string, password: string) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) return error.message
      // onAuthStateChange handles setting session; appUser effect handles the rest
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'Sign-in failed. Please try again.'
    }
  }, [])

  /* Sign out */
  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setAppUser(null)
    setSession(null)
  }, [])

  /* Refresh appUser from DB */
  const refreshAppUser = useCallback(async () => {
    if (!session?.user?.id) return
    try {
      const { data } = await supabase
        .from('app_users')
        .select('*')
        .eq('auth_id', session.user.id)
        .single()
      setAppUser((data as AppUser) ?? null)
    } catch {
      // ignore
    }
  }, [session])

  /* ── Effect 1: Auth listener (sync only — NO Supabase DB calls) ── */
  useEffect(() => {
    const deadline = setTimeout(() => {
      console.warn('Auth init deadline reached — showing login')
      setAuthReady(true)
      setLoading(false)
    }, 3000)

    // Check if setup is needed (fire-and-forget, non-blocking)
    supabase
      .from('app_users')
      .select('id', { count: 'exact', head: true })
      .then(({ count, error }) => {
        setNeedsSetup(error ? true : (count ?? 0) === 0)
      })
      .catch(() => setNeedsSetup(true))

    // Single auth source: onAuthStateChange fires INITIAL_SESSION on
    // subscribe, then SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT later.
    // We intentionally do NOT call getSession() — that caused a race
    // condition with duplicate parallel appUser fetches.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, s) => {
        // Only touch React state here — no async Supabase calls.
        // The Supabase client's internal token may not be updated yet
        // when this callback fires, so DB queries here can use a stale
        // token and silently fail.
        if (event === 'PASSWORD_RECOVERY') {
          setPasswordRecovery(true)
        }
        setSession(s)
        setAuthReady((prev) => {
          if (!prev) clearTimeout(deadline)
          return true
        })
      },
    )

    return () => {
      clearTimeout(deadline)
      subscription.unsubscribe()
    }
  }, [])

  /* ── Effect 2: Fetch app_user whenever session changes ─────────── */
  /* Runs AFTER React re-render, so the Supabase client's internal    */
  /* token is guaranteed to be up-to-date.                            */
  useEffect(() => {
    if (!authReady) return

    let cancelled = false

    if (!session?.user?.id) {
      setAppUser(null)
      setLoading(false)
      return
    }

    supabase
      .from('app_users')
      .select('*')
      .eq('auth_id', session.user.id)
      .single()
      .then(({ data }) => {
        if (cancelled) return
        const u = (data as AppUser) ?? null
        setAppUser(u)
        if (u) {
          setNeedsSetup(false)
          // Update last_login (fire-and-forget)
          dbUpdate(
            'app_users',
            sanitize('app_users', {
              last_login: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
            'auth_id',
            session.user.id,
          )
        }
      })
      .catch(() => {
        if (!cancelled) setAppUser(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [session, authReady])

  return (
    <Ctx.Provider
      value={{ session, appUser, role, loading, needsSetup, passwordRecovery, clearPasswordRecovery, can, signIn, signOut, refreshAppUser }}
    >
      {children}
    </Ctx.Provider>
  )
}
