import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CheckCircle2, XCircle, Info, X } from 'lucide-react'

/* ── Types ───────────────────────────────────────────────────── */

interface Toast {
  id: number
  type: 'success' | 'error' | 'info'
  message: string
}

interface ToastCtx {
  success: (msg: string) => void
  error: (msg: string) => void
  info: (msg: string) => void
}

const Ctx = createContext<ToastCtx>({ success: () => {}, error: () => {}, info: () => {} })

export const useToast = () => useContext(Ctx)

/* ── Provider ────────────────────────────────────────────────── */

let nextId = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((type: Toast['type'], message: string) => {
    const id = ++nextId
    setToasts((prev) => [...prev, { id, type, message }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000)
  }, [])

  const success = useCallback((msg: string) => push('success', msg), [push])
  const error = useCallback((msg: string) => push('error', msg), [push])
  const info = useCallback((msg: string) => push('info', msg), [push])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toastStyles = {
    success: 'border-green-500/30 bg-green-500/15 text-green-400',
    error: 'border-red-500/30 bg-red-500/15 text-red-400',
    info: 'border-blue-500/30 bg-blue-500/15 text-blue-400',
  }

  const toastIcons = {
    success: <CheckCircle2 size={16} className="shrink-0" />,
    error: <XCircle size={16} className="shrink-0" />,
    info: <Info size={16} className="shrink-0" />,
  }

  return (
    <Ctx.Provider value={{ success, error, info }}>
      {children}

      {/* Toast stack — bottom-right */}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col-reverse gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-3 rounded-lg border px-4 py-3 shadow-lg text-sm animate-slide-in ${toastStyles[t.type]}`}
          >
            {toastIcons[t.type]}
            <span className="text-text">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="ml-2 shrink-0 rounded p-0.5 text-muted transition-colors hover:text-text"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
