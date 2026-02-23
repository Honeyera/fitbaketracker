export default function StatCard({
  label,
  value,
  sub,
  trend,
  trendGood,
}: {
  label: string
  value: string | number
  sub?: string
  trend?: string
  trendGood?: boolean
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted">
        {label}
      </p>
      <p className="mt-1 font-mono text-2xl font-semibold text-text">{value}</p>
      <div className="mt-1 flex items-center gap-2">
        {sub && <p className="text-xs text-muted">{sub}</p>}
        {trend && (
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{
              backgroundColor: trendGood ? '#22C55E1F' : '#EF44441F',
              color: trendGood ? '#22C55E' : '#EF4444',
            }}
          >
            {trend}
          </span>
        )}
      </div>
    </div>
  )
}
