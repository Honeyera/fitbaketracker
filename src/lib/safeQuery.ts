import { supabase } from './supabase'
import { withTimeout } from './withTimeout'

const QUERY_TIMEOUT = 15000

/**
 * Wraps a Supabase query function with automatic timeout, auth-error detection,
 * session refresh, and one-time retry.
 *
 * If the query hangs, it will timeout after 15s with a clear error.
 * If the query fails due to an expired/invalid token, it will:
 *  1. Attempt to refresh the session
 *  2. Retry the query once (also with timeout)
 *  3. If refresh fails, sign out and redirect to /login
 *
 * Usage:
 *   const { data, error } = await safeQuery(() =>
 *     supabase.from('table').select('*')
 *   )
 */
export async function safeQuery<T>(
  queryFn: () => PromiseLike<{ data: T | null; error: any }>,
  label: string = 'Query',
): Promise<{ data: T | null; error: any }> {
  try {
    const result = await withTimeout(
      Promise.resolve(queryFn()),
      QUERY_TIMEOUT,
      label,
    )

    if (result.error && isAuthError(result.error)) {
      console.warn('Auth error detected — refreshing session:', result.error.message ?? result.error.code)

      const { error: refreshError } = await supabase.auth.refreshSession()

      if (refreshError) {
        console.error('Session refresh failed — signing out')
        await supabase.auth.signOut()
        window.location.href = '/login?expired=1'
        return result
      }

      // Retry the query once with the refreshed token
      return await withTimeout(
        Promise.resolve(queryFn()),
        QUERY_TIMEOUT,
        label + ' (retry)',
      )
    }

    return result
  } catch (err: any) {
    return { data: null, error: { message: err.message } }
  }
}

function isAuthError(error: any): boolean {
  const msg = (error?.message ?? '').toLowerCase()
  const code = String(error?.code ?? '')

  return (
    msg.includes('jwt') ||
    msg.includes('token') ||
    msg.includes('unauthorized') ||
    msg.includes('not authenticated') ||
    msg.includes('invalid claim') ||
    code === 'PGRST301' ||
    code === '401' ||
    error?.status === 401 ||
    error?.status === 403
  )
}

/**
 * Wraps a batch of Supabase queries (typically in a Promise.all) with
 * timeout, a single auth-error check, session refresh, and retry.
 *
 * Note: only include Supabase query results (with {data, error} shape).
 * Non-Supabase results (like loadConversions) should be fetched separately.
 *
 * Usage:
 *   const [cpRes, ingRes] = await safeBatch(() => Promise.all([
 *     supabase.from('co_packers').select('*'),
 *     supabase.from('ingredients').select('*'),
 *   ]))
 */
export async function safeBatch<T extends any[]>(
  batchFn: () => Promise<T>,
  label: string = 'Batch query',
): Promise<T> {
  try {
    const results = await withTimeout(batchFn(), QUERY_TIMEOUT, label)

    // Check only results that have the {data, error} shape
    const hasAuthErr = results.some(
      (r) => r && typeof r === 'object' && 'error' in r && r.error && isAuthError(r.error),
    )
    if (!hasAuthErr) return results

    console.warn('Auth error detected in batch — refreshing session')
    const { error: refreshError } = await supabase.auth.refreshSession()

    if (refreshError) {
      console.error('Session refresh failed — signing out')
      await supabase.auth.signOut()
      window.location.href = '/login?expired=1'
      return results
    }

    // Retry all queries once with refreshed token
    return await withTimeout(batchFn(), QUERY_TIMEOUT, label + ' (retry)')
  } catch (err: any) {
    // Return an empty array-like result that won't crash destructuring
    console.error(`safeBatch error (${label}):`, err.message)
    throw err
  }
}
