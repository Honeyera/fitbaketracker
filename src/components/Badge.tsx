import type { ReactNode } from 'react'

const colors = {
  accent: '#3B82F6',
  green:  '#22C55E',
  red:    '#EF4444',
  amber:  '#F59E0B',
  purple: '#A78BFA',
  cyan:   '#06B6D4',
  gray:   '#7A8599',
} as const

type BadgeColor = keyof typeof colors

export default function Badge({ color = 'accent', children }: { color?: BadgeColor; children: ReactNode }) {
  const hex = colors[color]
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[13px] font-medium"
      style={{ backgroundColor: `${hex}1F`, color: hex }}
    >
      {children}
    </span>
  )
}
