import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Send, Sparkles, Trash2 } from 'lucide-react'
import { sendMessage, type Message } from '../lib/aiChat'

/* ── Markdown-lite renderer ────────────────────────────────────── */

function renderMarkdown(text: string) {
  // Split into blocks by double newline
  const blocks = text.split(/\n{2,}/)
  return blocks.map((block, bi) => {
    // Check for list items
    if (/^[\s]*[-*•]\s/.test(block)) {
      const items = block.split(/\n/).filter((l) => l.trim())
      return (
        <ul key={bi} className="my-1 ml-4 list-disc space-y-0.5">
          {items.map((item, ii) => (
            <li key={ii} className="text-sm">{renderInline(item.replace(/^[\s]*[-*•]\s+/, ''))}</li>
          ))}
        </ul>
      )
    }
    // Numbered lists
    if (/^\s*\d+[.)]\s/.test(block)) {
      const items = block.split(/\n/).filter((l) => l.trim())
      return (
        <ol key={bi} className="my-1 ml-4 list-decimal space-y-0.5">
          {items.map((item, ii) => (
            <li key={ii} className="text-sm">{renderInline(item.replace(/^\s*\d+[.)]\s+/, ''))}</li>
          ))}
        </ol>
      )
    }
    // Headers
    if (/^#{1,3}\s/.test(block)) {
      const level = block.match(/^(#{1,3})/)?.[1].length ?? 1
      const text = block.replace(/^#{1,3}\s+/, '')
      const cls = level === 1 ? 'text-base font-bold' : level === 2 ? 'text-sm font-semibold' : 'text-sm font-medium'
      return <p key={bi} className={`${cls} my-1`}>{renderInline(text)}</p>
    }
    // Code block
    if (block.startsWith('```')) {
      const code = block.replace(/^```\w*\n?/, '').replace(/```$/, '')
      return <pre key={bi} className="my-1 rounded bg-code-bg p-2 text-xs font-mono overflow-x-auto">{code}</pre>
    }
    // Regular paragraph
    return <p key={bi} className="my-1 text-sm leading-relaxed">{renderInline(block)}</p>
  })
}

function renderInline(text: string) {
  // Bold, inline code, italic
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="rounded bg-code-bg px-1 py-0.5 text-xs font-mono">{part.slice(1, -1)}</code>
    if (part.startsWith('_') && part.endsWith('_'))
      return <em key={i}>{part.slice(1, -1)}</em>
    return part
  })
}

/* ── Suggested questions ───────────────────────────────────────── */

const SUGGESTIONS = [
  'What ingredients are running low?',
  'Compare supplier prices for Almond Flour',
  "What's the COGS breakdown for our recipes?",
  'Which POs are in transit?',
  'What should I reorder this week?',
  'Show production order status',
]

/* ── Component ─────────────────────────────────────────────────── */

export default function AIChatPanel() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const hasApiKey = !!import.meta.env.VITE_ANTHROPIC_API_KEY

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, loading])

  // Focus input when panel opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const send = useCallback(async (text: string) => {
    if (!text.trim() || loading) return
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text.trim(),
      timestamp: new Date(),
    }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setLoading(true)
    setError(null)

    try {
      const response = await sendMessage(text.trim(), messages)
      const aiMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response,
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, aiMsg])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      if (msg === 'ANTHROPIC_API_KEY_MISSING') {
        setError('API key not configured. Add VITE_ANTHROPIC_API_KEY to your .env.local file.')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }, [loading, messages])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send(input)
    }
  }

  function clearChat() {
    setMessages([])
    setError(null)
  }

  function formatTime(d: Date): string {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className={`fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition-all duration-200 hover:scale-105 ${
          open ? 'bg-card text-muted hover:text-text' : 'bg-brand text-white animate-ai-pulse'
        }`}
        title="FitBake AI Assistant"
      >
        {open ? <X size={22} /> : <Sparkles size={22} />}
      </button>

      {/* Panel overlay */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-overlay"
            onClick={() => setOpen(false)}
          />

          {/* Chat panel */}
          <div className="fixed right-0 top-0 z-50 flex h-full w-[420px] max-w-[100vw] flex-col border-l border-border bg-bg animate-slide-in shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <Sparkles size={16} className="text-brand" />
                  <h2 className="text-sm font-semibold text-text">FitBake AI Assistant</h2>
                </div>
                <p className="mt-0.5 text-[10px] text-muted">Powered by Claude</p>
              </div>
              <div className="flex items-center gap-1">
                {messages.length > 0 && (
                  <button
                    onClick={clearChat}
                    className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-text"
                    title="Clear chat"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover-strong hover:text-text"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
              {!hasApiKey && messages.length === 0 && (
                <div className="mt-8 rounded-lg border border-border bg-card p-4 text-center">
                  <Sparkles size={24} className="mx-auto mb-2 text-muted" />
                  <p className="text-sm text-text font-medium">API Key Required</p>
                  <p className="mt-1 text-xs text-muted">
                    Add <code className="rounded bg-code-bg px-1 py-0.5 font-mono text-[10px]">VITE_ANTHROPIC_API_KEY</code> to
                    your <code className="rounded bg-code-bg px-1 py-0.5 font-mono text-[10px]">.env.local</code> file to enable the AI assistant.
                  </p>
                </div>
              )}

              {hasApiKey && messages.length === 0 && !loading && (
                <div className="mt-4">
                  <div className="mb-4 text-center">
                    <Sparkles size={28} className="mx-auto mb-2 text-brand/60" />
                    <p className="text-sm text-text font-medium">Ask me anything about your data</p>
                    <p className="mt-1 text-xs text-muted">I have access to your inventory, orders, recipes, and more.</p>
                  </div>
                  <div className="space-y-2">
                    {SUGGESTIONS.map((q) => (
                      <button
                        key={q}
                        onClick={() => send(q)}
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-left text-xs text-muted transition-colors hover:border-brand/40 hover:text-text"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 ${
                      msg.role === 'user'
                        ? 'bg-brand text-white'
                        : 'bg-card text-text'
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <div className="ai-response">{renderMarkdown(msg.content)}</div>
                    ) : (
                      <p className="text-sm">{msg.content}</p>
                    )}
                    <p className={`mt-1 text-[10px] ${msg.role === 'user' ? 'text-white/60' : 'text-muted'}`}>
                      {formatTime(msg.timestamp)}
                    </p>
                  </div>
                </div>
              ))}

              {loading && (
                <div className="flex justify-start">
                  <div className="rounded-lg bg-card px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1">
                        <span className="h-2 w-2 rounded-full bg-muted animate-bounce [animation-delay:0ms]" />
                        <span className="h-2 w-2 rounded-full bg-muted animate-bounce [animation-delay:150ms]" />
                        <span className="h-2 w-2 rounded-full bg-muted animate-bounce [animation-delay:300ms]" />
                      </div>
                      <span className="text-xs text-muted">Analyzing your data...</span>
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
                  <p className="text-xs text-red-400">{error}</p>
                  <button
                    onClick={() => { setError(null); if (messages.length > 0) send(messages[messages.length - 1].content) }}
                    className="mt-1 text-xs text-red-300 underline hover:text-red-200"
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>

            {/* Input */}
            <div className="border-t border-border px-4 py-3">
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about your data..."
                  disabled={loading || !hasApiKey}
                  rows={1}
                  className="flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-brand/50 disabled:opacity-40"
                  style={{ maxHeight: '120px' }}
                  onInput={(e) => {
                    const el = e.currentTarget
                    el.style.height = 'auto'
                    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
                  }}
                />
                <button
                  onClick={() => send(input)}
                  disabled={loading || !input.trim() || !hasApiKey}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand text-white transition-colors hover:bg-brand-hover disabled:opacity-40 disabled:hover:bg-brand"
                >
                  <Send size={16} />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
