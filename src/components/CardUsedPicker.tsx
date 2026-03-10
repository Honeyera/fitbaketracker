import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

let _cachedCards: string[] | null = null

export default function CardUsedPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const [savedCards, setSavedCards] = useState<string[]>(_cachedCards ?? [])
  const [showNew, setShowNew] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (_cachedCards) return
    supabase
      .from('purchase_orders')
      .select('card_used')
      .not('card_used', 'is', null)
      .neq('card_used', '')
      .then(({ data }) => {
        const unique = [...new Set(data?.map((d: any) => d.card_used as string).filter(Boolean))]
        unique.sort()
        _cachedCards = unique
        setSavedCards(unique)
      })
  }, [])

  useEffect(() => {
    if (showNew) inputRef.current?.focus()
  }, [showNew])

  function handleSelect(v: string) {
    if (v === '__new__') {
      setDraft('')
      setShowNew(true)
    } else {
      onChange(v)
      setShowNew(false)
    }
  }

  function handleSaveNew() {
    const trimmed = draft.trim()
    if (!trimmed) return
    onChange(trimmed)
    // Add to cache so it appears immediately in both modals
    if (_cachedCards && !_cachedCards.includes(trimmed)) {
      _cachedCards = [..._cachedCards, trimmed].sort()
      setSavedCards(_cachedCards)
    }
    setShowNew(false)
    setDraft('')
  }

  function handleCancelNew() {
    setShowNew(false)
    setDraft('')
  }

  // If current value isn't in savedCards and isn't empty, it's a previously saved value not yet in cache
  const allOptions = savedCards.includes(value) || !value ? savedCards : [value, ...savedCards]

  if (showNew) {
    return (
      <div className="flex items-end gap-1.5">
        <label className="block flex-1">
          <span className="mb-1 block text-[13px] font-medium text-muted">Card Used</span>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveNew() } if (e.key === 'Escape') handleCancelNew() }}
            placeholder="e.g., Amex 1004, Chase Visa 4521"
            className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text placeholder:text-muted/50 outline-none focus:border-accent"
          />
        </label>
        <button
          type="button"
          onClick={handleSaveNew}
          disabled={!draft.trim()}
          className="mb-px rounded-lg bg-accent px-2.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
        >
          Save
        </button>
        <button
          type="button"
          onClick={handleCancelNew}
          className="mb-px rounded-lg border border-border px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:text-text"
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-muted">Card Used</span>
      <select
        value={allOptions.includes(value) ? value : ''}
        onChange={(e) => handleSelect(e.target.value)}
        className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[14px] text-text outline-none focus:border-accent"
      >
        <option value="">Select card...</option>
        {allOptions.map((card) => (
          <option key={card} value={card}>{card}</option>
        ))}
        <option disabled>──────────</option>
        <option value="__new__">+ Add new card</option>
      </select>
    </label>
  )
}
