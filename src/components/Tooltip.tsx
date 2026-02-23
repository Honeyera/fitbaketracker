import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  content: ReactNode
  children: ReactNode
  delay?: number
  maxWidth?: number
}

export default function Tooltip({ content, children, delay = 0, maxWidth = 280 }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const arrowRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(null)
  const aboveRef = useRef(true)
  const centerXRef = useRef(0)

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!triggerRef.current) return
      const rect = triggerRef.current.getBoundingClientRect()
      aboveRef.current = rect.top > 120
      centerXRef.current = rect.left + rect.width / 2
      setVisible(true)
    }, delay)
  }, [delay])

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setVisible(false)
  }, [])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  useLayoutEffect(() => {
    if (!visible || !tooltipRef.current || !triggerRef.current) return
    const tt = tooltipRef.current
    const trigRect = triggerRef.current.getBoundingClientRect()
    const ttWidth = tt.offsetWidth
    const ttHeight = tt.offsetHeight
    const pad = 8
    const gap = 8
    const cx = centerXRef.current

    // Vertical — prefer above, flip if no room
    let isAbove = aboveRef.current
    let top: number
    if (isAbove) {
      top = trigRect.top - gap - ttHeight
      if (top < pad) {
        isAbove = false
        top = trigRect.bottom + gap
      }
    } else {
      top = trigRect.bottom + gap
    }

    // Horizontal — center on trigger, clamp to viewport
    let left = cx - ttWidth / 2
    if (left < pad) left = pad
    if (left + ttWidth > window.innerWidth - pad) left = window.innerWidth - pad - ttWidth

    tt.style.left = `${left}px`
    tt.style.top = `${top}px`
    tt.style.opacity = '1'

    // Arrow
    if (arrowRef.current) {
      const arrowX = cx - left
      const clamped = Math.max(10, Math.min(arrowX, ttWidth - 10))
      arrowRef.current.style.left = `${clamped}px`
      if (isAbove) {
        arrowRef.current.style.bottom = '-5px'
        arrowRef.current.style.top = 'auto'
        arrowRef.current.style.borderTop = '5px solid var(--color-border)'
        arrowRef.current.style.borderBottom = 'none'
      } else {
        arrowRef.current.style.top = '-5px'
        arrowRef.current.style.bottom = 'auto'
        arrowRef.current.style.borderBottom = '5px solid var(--color-border)'
        arrowRef.current.style.borderTop = 'none'
      }
    }
  }, [visible])

  return (
    <>
      <span ref={triggerRef} onMouseEnter={show} onMouseLeave={hide} style={{ display: 'inline-flex' }}>
        {children}
      </span>
      {visible && createPortal(
        <div
          ref={tooltipRef}
          style={{
            position: 'fixed',
            zIndex: 9999,
            left: 0,
            top: 0,
            opacity: 0,
            pointerEvents: 'none',
          }}
        >
          <div
            ref={arrowRef}
            style={{
              position: 'absolute',
              left: '50%',
              width: 0,
              height: 0,
              borderLeft: '5px solid transparent',
              borderRight: '5px solid transparent',
            }}
          />
          <div style={{
            background: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            padding: '10px 14px',
            maxWidth,
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            color: 'var(--color-text)',
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'normal',
          }}>
            {content}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
