import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface StatusOption {
  value: string
  label: string
  dotColor?: string
}

interface Props {
  /** The trigger element (typically a Badge button) */
  trigger: React.ReactNode
  options: StatusOption[]
  onSelect: (value: string) => void
  /** Width of the dropdown menu */
  width?: number
  /** Alignment relative to the trigger */
  align?: 'left' | 'center' | 'right'
}

export default function StatusDropdown({ trigger, options, onSelect, width = 200, align = 'left' }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const open = () => {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const estimatedHeight = options.length * 40 + 8

    let top: number
    if (spaceBelow < estimatedHeight && rect.top > estimatedHeight) {
      top = rect.top - estimatedHeight - 4
    } else {
      top = rect.bottom + 4
    }

    let left: number
    if (align === 'center') {
      left = rect.left + rect.width / 2 - width / 2
    } else if (align === 'right') {
      left = rect.right - width
    } else {
      left = rect.left
    }

    // Clamp to viewport
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8
    if (left < 8) left = 8

    setPos({ top, left })
    setIsOpen(true)
  }

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('[data-status-dropdown]') && !btnRef.current?.contains(target)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen])

  // Reposition on scroll/resize while open
  useLayoutEffect(() => {
    if (!isOpen || !btnRef.current) return
    const reposition = () => {
      if (!btnRef.current) return
      const rect = btnRef.current.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      const estimatedHeight = options.length * 40 + 8

      let top: number
      if (spaceBelow < estimatedHeight && rect.top > estimatedHeight) {
        top = rect.top - estimatedHeight - 4
      } else {
        top = rect.bottom + 4
      }

      let left: number
      if (align === 'center') {
        left = rect.left + rect.width / 2 - width / 2
      } else if (align === 'right') {
        left = rect.right - width
      } else {
        left = rect.left
      }

      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8
      if (left < 8) left = 8

      setPos({ top, left })
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [isOpen, options.length, width, align])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); isOpen ? setIsOpen(false) : open() }}
        className="cursor-pointer transition-all hover:scale-105 hover:brightness-125"
      >
        {trigger}
      </button>
      {isOpen && pos && createPortal(
        <div data-status-dropdown>
          {/* Backdrop */}
          <div className="fixed inset-0 z-[9998]" onClick={() => setIsOpen(false)} />
          {/* Menu */}
          <div
            className="fixed z-[9999] rounded-lg border border-border bg-card py-1 shadow-xl"
            style={{ top: pos.top, left: pos.left, width }}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                onClick={(e) => { e.stopPropagation(); setIsOpen(false); onSelect(opt.value) }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-text transition-colors hover:bg-hover"
              >
                {opt.dotColor && (
                  <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: opt.dotColor }} />
                )}
                {opt.label}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
