/** Generate a CSV from an array of objects and trigger a browser download */
export function downloadCSV(
  data: Record<string, unknown>[],
  columns: { key: string; label: string }[],
  filename: string,
) {
  if (data.length === 0) return

  const header = columns.map((c) => `"${c.label}"`).join(',')

  const rows = data.map((row) =>
    columns
      .map((col) => {
        const val = row[col.key]
        if (val == null) return ''
        const str = String(val).replace(/"/g, '""')
        return `"${str}"`
      })
      .join(','),
  )

  const csv = [header, ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = url
  link.download = `${filename}.csv`
  link.click()

  URL.revokeObjectURL(url)
}
