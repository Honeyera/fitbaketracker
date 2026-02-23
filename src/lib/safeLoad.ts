/**
 * Wraps an async load function with a safety timeout.
 * If the load takes longer than `timeoutMs`, `setLoading(false)` is called
 * so the page doesn't stay stuck on the skeleton loader forever.
 * Returns a cleanup function for use in useEffect.
 */
export function safeLoad(
  loadFn: () => Promise<void>,
  setLoading: (v: boolean) => void,
  timeoutMs = 10000,
): () => void {
  let cancelled = false
  const timer = setTimeout(() => {
    if (!cancelled) setLoading(false)
  }, timeoutMs)

  loadFn()
    .catch(() => {
      if (!cancelled) setLoading(false)
    })
    .finally(() => {
      if (!cancelled) clearTimeout(timer)
    })

  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}
