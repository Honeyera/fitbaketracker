import type { ReactNode } from 'react'
import Tooltip from './Tooltip'

interface HelpTipProps {
  text: string
  children?: ReactNode
}

export default function HelpTip({ text, children }: HelpTipProps) {
  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <Tooltip content={text} delay={200}>
        <span
          className="inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border border-muted/40 text-[9px] font-semibold leading-none text-muted transition-colors hover:border-accent hover:text-accent"
        >
          ?
        </span>
      </Tooltip>
    </span>
  )
}
