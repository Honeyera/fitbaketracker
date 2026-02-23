import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'

export interface Column<T> {
  label: ReactNode
  key: string
  width?: string
  align?: 'left' | 'center' | 'right'
  render?: (row: T) => ReactNode
}

export default function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  onRowClick,
  highlightRow,
  highlightColor = '#3B82F6',
  emptyIcon,
  emptyMessage = 'No data yet',
  emptyHint,
}: {
  columns: Column<T>[]
  data: T[]
  onRowClick?: (row: T) => void
  highlightRow?: (row: T) => boolean
  highlightColor?: string
  emptyIcon?: ReactNode
  emptyMessage?: string
  emptyHint?: string
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-[14px]">
        <thead>
          <tr className="border-b border-border bg-surface">
            {columns.map((col) => (
              <th
                key={col.key}
                className="px-4 py-3 text-left text-[13px] font-semibold uppercase tracking-wider text-muted"
                style={{
                  width: col.width,
                  textAlign: col.align ?? 'left',
                }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => {
            const highlighted = highlightRow?.(row) ?? false
            return (
              <tr
                key={i}
                onClick={() => onRowClick?.(row)}
                className={`border-b border-border transition-colors ${
                  onRowClick ? 'cursor-pointer' : ''
                } ${!highlighted ? 'hover:bg-hover' : ''}`}
                style={{
                  ...(highlighted ? { backgroundColor: `${highlightColor}1F` } : {}),
                  minHeight: 48,
                }}
              >
                {columns.map((col) => {
                  const isNumeric =
                    col.align === 'right' ||
                    typeof (row as Record<string, unknown>)[col.key] === 'number'
                  return (
                    <td
                      key={col.key}
                      className={`px-4 py-3 min-h-[48px] ${isNumeric ? 'font-mono' : ''}`}
                      style={{ textAlign: col.align ?? 'left' }}
                    >
                      {col.render
                        ? col.render(row)
                        : String(
                            (row as Record<string, unknown>)[col.key] ?? '—',
                          )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
          {data.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-12 text-center"
              >
                <div className="flex flex-col items-center gap-2">
                  <span className="text-muted/50">
                    {emptyIcon ?? <Inbox size={32} />}
                  </span>
                  <p className="text-[16px] font-medium text-muted">{emptyMessage}</p>
                  {emptyHint && (
                    <p className="text-sm text-muted/70">{emptyHint}</p>
                  )}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
