import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Upload, Trash2, FileText, Loader2, Download, X } from 'lucide-react'
import type { POAttachment } from '../types/database'

const BUCKET = 'po-documents'
const MAX_SIZE = 10 * 1024 * 1024 // 10 MB
const ALLOWED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'text/csv',
]
const FILE_TYPE_OPTIONS = ['invoice', 'packing_slip', 'bol', 'receipt', 'other'] as const

function humanSize(bytes: number | null) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function typeLabel(t: string) {
  switch (t) {
    case 'invoice': return 'Invoice'
    case 'packing_slip': return 'Packing Slip'
    case 'bol': return 'BOL'
    case 'receipt': return 'Receipt'
    default: return 'Other'
  }
}

interface Props {
  purchaseOrderId: string
}

export default function POAttachments({ purchaseOrderId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState<POAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [selectedType, setSelectedType] = useState<string>('invoice')
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    loadAttachments()
  }, [purchaseOrderId])

  async function loadAttachments() {
    const { data } = await supabase
      .from('po_attachments')
      .select('*')
      .eq('purchase_order_id', purchaseOrderId)
      .order('created_at', { ascending: false })
    if (data) setAttachments(data as POAttachment[])
  }

  async function handleFile(file: File) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Allowed: PDF, images, Excel, CSV')
      return
    }
    if (file.size > MAX_SIZE) {
      setError('File must be under 10 MB')
      return
    }

    setError(null)
    setUploading(true)

    const ext = file.name.split('.').pop() ?? 'pdf'
    const storagePath = `${purchaseOrderId}/${crypto.randomUUID()}.${ext}`

    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file, { cacheControl: '3600', upsert: false })

    if (uploadErr) {
      setError(uploadErr.message)
      setUploading(false)
      return
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath)

    const { error: dbErr } = await supabase.from('po_attachments').insert({
      purchase_order_id: purchaseOrderId,
      file_name: file.name,
      file_url: urlData.publicUrl,
      file_type: selectedType,
      file_size: file.size,
    })

    if (dbErr) {
      setError(dbErr.message)
    } else {
      await loadAttachments()
    }
    setUploading(false)
  }

  async function handleDelete(att: POAttachment) {
    setDeleting(att.id)
    // Extract storage path from URL
    const urlParts = att.file_url.split(`${BUCKET}/`)
    const storagePath = urlParts[urlParts.length - 1]
    if (storagePath) {
      await supabase.storage.from(BUCKET).remove([storagePath])
    }
    await supabase.from('po_attachments').delete().eq('id', att.id)
    setAttachments((prev) => prev.filter((a) => a.id !== att.id))
    setDeleting(null)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  return (
    <div className="border-t border-border pt-4">
      <p className="mb-3 text-[13px] font-medium uppercase tracking-wider text-muted">
        Attachments
      </p>

      {/* Upload area */}
      <div className="flex gap-2 items-end mb-3">
        <div className="flex-1">
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-4 py-2.5 transition-colors ${
              dragOver ? 'border-accent bg-accent/5' : 'border-border hover:border-muted'
            }`}
          >
            {uploading ? (
              <Loader2 size={16} className="animate-spin text-accent" />
            ) : (
              <Upload size={16} className="text-muted" />
            )}
            <span className="text-[13px] text-muted">
              {uploading ? 'Uploading...' : 'Drop file or click (PDF, image, Excel — max 10 MB)'}
            </span>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleFile(file)
              e.target.value = ''
            }}
          />
        </div>
        <select
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
          className="rounded-lg border border-border bg-surface px-2 py-2 text-[13px] text-text outline-none focus:border-accent"
        >
          {FILE_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>{typeLabel(t)}</option>
          ))}
        </select>
      </div>

      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

      {/* Attachment list */}
      {attachments.length > 0 && (
        <div className="space-y-1.5">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-surface/50 px-3 py-2"
            >
              <FileText size={16} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-text" title={att.file_name}>
                  {att.file_name}
                </p>
                <p className="text-[11px] text-muted">
                  {typeLabel(att.file_type)} {att.file_size ? `· ${humanSize(att.file_size)}` : ''}
                </p>
              </div>
              <a
                href={att.file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded p-1 text-muted hover:text-accent transition-colors"
                title="Download"
              >
                <Download size={14} />
              </a>
              <button
                type="button"
                onClick={() => handleDelete(att)}
                disabled={deleting === att.id}
                className="shrink-0 rounded p-1 text-muted hover:text-red-400 transition-colors disabled:opacity-50"
                title="Delete"
              >
                {deleting === att.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
              </button>
            </div>
          ))}
        </div>
      )}

      {attachments.length === 0 && !uploading && (
        <p className="text-[12px] text-muted/60 italic">No attachments yet</p>
      )}
    </div>
  )
}
