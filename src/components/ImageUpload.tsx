import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Upload, X, Loader2 } from 'lucide-react'

interface ImageUploadProps {
  currentUrl?: string | null
  onUploaded: (url: string) => void
  onRemoved: () => void
}

const MAX_SIZE = 2 * 1024 * 1024 // 2 MB

export default function ImageUpload({ currentUrl, onUploaded, onRemoved }: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  async function handleFile(file: File) {
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file')
      return
    }
    if (file.size > MAX_SIZE) {
      setError('Image must be under 2 MB')
      return
    }

    setError(null)
    setUploading(true)

    const ext = file.name.split('.').pop() ?? 'jpg'
    const path = `${crypto.randomUUID()}.${ext}`

    const { error: uploadErr } = await supabase.storage
      .from('recipe-images')
      .upload(path, file, { cacheControl: '3600', upsert: false })

    if (uploadErr) {
      setError(uploadErr.message)
      setUploading(false)
      return
    }

    const { data } = supabase.storage.from('recipe-images').getPublicUrl(path)
    onUploaded(data.publicUrl)
    setUploading(false)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  if (currentUrl) {
    return (
      <div className="flex items-center gap-3">
        <img
          src={currentUrl}
          alt="Recipe"
          className="h-16 w-16 rounded-lg object-cover"
        />
        <button
          type="button"
          onClick={onRemoved}
          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted transition-colors hover:text-red-400"
        >
          <X size={12} />
          Remove
        </button>
      </div>
    )
  }

  return (
    <div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-4 py-3 transition-colors ${
          dragOver
            ? 'border-accent bg-accent/5'
            : 'border-border hover:border-muted'
        }`}
      >
        {uploading ? (
          <Loader2 size={20} className="animate-spin text-accent" />
        ) : (
          <Upload size={20} className="text-muted" />
        )}
        <span className="text-xs text-muted">
          {uploading ? 'Uploading…' : 'Click or drag image (max 2 MB)'}
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
          e.target.value = ''
        }}
      />
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  )
}
