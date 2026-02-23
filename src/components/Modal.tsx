import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  wide,
}: {
  isOpen: boolean
  onClose: () => void
  title: string
  children: ReactNode
  wide?: boolean | 'xl' | 'xxl' | '3xl' | '4xl'
}) {
  if (!isOpen) return null

  const widthClass = wide === '4xl' ? 'max-w-[min(1200px,95vw)]' : wide === '3xl' ? 'max-w-[min(1100px,95vw)]' : wide === 'xxl' ? 'max-w-[min(950px,90vw)]' : wide === 'xl' ? 'max-w-[min(900px,90vw)]' : wide ? 'max-w-2xl' : 'max-w-lg'
  const heightClass = wide === '4xl' ? 'max-h-[92vh]' : wide === '3xl' || wide === 'xxl' || wide === 'xl' ? 'max-h-[90vh]' : 'max-h-[90vh]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* overlay */}
      <div
        className="absolute inset-0 bg-overlay"
        onClick={onClose}
      />
      {/* card */}
      <div className={`relative z-10 w-full ${widthClass} rounded-xl border border-border bg-card p-6 shadow-2xl ${heightClass} overflow-y-auto`}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold text-text">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-text"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
