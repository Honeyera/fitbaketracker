import { useCoPackers } from './CPBadge'

export default function CPFilterBar({
  selected,
  onSelect,
}: {
  selected: string
  onSelect: (id: string) => void
}) {
  const coPackers = useCoPackers()

  return (
    <div className="mb-6 flex items-center gap-2">
      <button
        onClick={() => onSelect('all')}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
          selected === 'all'
            ? 'bg-accent text-white'
            : 'border border-border text-muted hover:text-text hover:bg-hover'
        }`}
      >
        All
      </button>
      {coPackers.map((cp) => {
        const hex = cp.color ?? '#3B82F6'
        const active = selected === cp.id
        return (
          <button
            key={cp.id}
            onClick={() => onSelect(cp.id)}
            className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
            style={
              active
                ? { backgroundColor: hex, color: '#fff' }
                : {
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-muted)',
                  }
            }
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.color = 'var(--color-text)'
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.color = 'var(--color-muted)'
            }}
          >
            {cp.short_code}
          </button>
        )
      })}
    </div>
  )
}
