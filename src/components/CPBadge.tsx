import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { safeQuery } from '../lib/safeQuery'
import type { CoPacker } from '../types/database'

let cpCache: CoPacker[] | null = null
let cpPromise: Promise<CoPacker[]> | null = null

function fetchCoPackers(): Promise<CoPacker[]> {
  if (cpCache) return Promise.resolve(cpCache)
  if (cpPromise) return cpPromise
  const p = safeQuery(() =>
    supabase
      .from('co_packers')
      .select('*')
      .order('name')
  ).then(({ data }) => {
    cpCache = (data as CoPacker[] | null) ?? []
    return cpCache
  })
  cpPromise = p
  return p
}

export function invalidateCPCache() {
  cpCache = null
  cpPromise = null
}

export function useCoPacker(id: string | undefined): CoPacker | undefined {
  const [cp, setCp] = useState<CoPacker | undefined>(() =>
    cpCache?.find((c) => c.id === id),
  )
  useEffect(() => {
    if (!id) return
    let cancelled = false
    fetchCoPackers().then((list) => {
      if (!cancelled) setCp(list.find((c) => c.id === id))
    })
    return () => { cancelled = true }
  }, [id])
  return cp
}

export function useCoPackers(): CoPacker[] {
  const [list, setList] = useState<CoPacker[]>(cpCache ?? [])
  useEffect(() => {
    let cancelled = false
    fetchCoPackers().then((data) => {
      if (!cancelled) setList(data)
    })
    return () => { cancelled = true }
  }, [])
  return list
}

export default function CPBadge({
  coPackerId,
  coPacker,
}: {
  coPackerId?: string
  coPacker?: CoPacker
}) {
  const fetched = useCoPacker(coPacker ? undefined : coPackerId)
  const cp = coPacker ?? fetched
  if (!cp) return null
  const hex = cp.color ?? '#3B82F6'
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{ backgroundColor: `${hex}1F`, color: hex }}
    >
      {cp.short_code}
    </span>
  )
}
