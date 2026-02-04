'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

type ClassRow = { id: string; name: string }
type ItemRow = { id: number; name: string }

function coerceClasses(payload: unknown): ClassRow[] {
  if (Array.isArray(payload)) return payload as ClassRow[]
  if (payload && typeof payload === 'object' && Array.isArray((payload as any).classes)) {
    return (payload as any).classes as ClassRow[]
  }
  return []
}

function coerceItems(payload: unknown): ItemRow[] {
  if (Array.isArray(payload)) return payload as ItemRow[]
  if (payload && typeof payload === 'object' && Array.isArray((payload as any).items)) {
    return (payload as any).items as ItemRow[]
  }
  return []
}

export default function UploadPage() {
  const [classes, setClasses] = useState<ClassRow[]>([])
  const [classesLoadError, setClassesLoadError] = useState<string | null>(null)
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null)

  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const [wins, setWins] = useState<number>(10)

  // Track whether user manually edited wins (so AI doesn't overwrite)
  const winsTouchedRef = useRef(false)

  async function extractWinsFromImage(f: File): Promise<number | null> {
    const form = new FormData()
    form.append('image', f)

    const res = await fetch('/api/vision/extract', {
      method: 'POST',
      body: form,
    })

    if (!res.ok) return null

    const data = await res.json()
    return typeof data?.wins === 'number' ? data.wins : null
  }

  // Items
  const [itemQuery, setItemQuery] = useState('')
  const [itemResults, setItemResults] = useState<ItemRow[]>([])
  const [selectedItems, setSelectedItems] = useState<ItemRow[]>([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsError, setItemsError] = useState<string | null>(null)
  const debounceRef = useRef<number | null>(null)

  // Upload
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch('/api/fetch-classes')
        if (!res.ok) {
          setClassesLoadError('Failed to load classes')
          return
        }
        const data = await res.json()
        const list = coerceClasses(data)
        setClasses(list)
        if (list.length === 0) {
          setClassesLoadError('No classes returned from API')
          setSelectedClassId(null)
        } else {
          setClassesLoadError(null)
          // default to first hero so the select is always valid
          setSelectedClassId(list[0]?.id ?? null)
        }
      } catch {
        setClassesLoadError('Failed to load classes')
      }
    })()
  }, [])

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  // When file changes, ask Vision API for wins and pre-fill (if user hasn't manually edited)
  useEffect(() => {
    if (!file) return

    // new file => allow AI to set wins again
    winsTouchedRef.current = false

    ;(async () => {
      const winsFromAI = await extractWinsFromImage(file)
      if (winsFromAI !== null && !winsTouchedRef.current) {
        setWins(winsFromAI)
      }
    })()
  }, [file])

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)

    setItemsError(null)

    if (itemQuery.trim().length < 2) {
      setItemResults([])
      return
    }

    setItemsLoading(true)

    debounceRef.current = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/fetch-items?query=${encodeURIComponent(itemQuery)}`)
        if (!res.ok) {
          setItemsError('Failed to fetch items')
          setItemResults([])
          return
        }
        const data = await res.json()
        setItemResults(coerceItems(data))
      } catch {
        setItemsError('Item search failed')
        setItemResults([])
      } finally {
        setItemsLoading(false)
      }
    }, 200)
  }, [itemQuery])

  function addItem(item: ItemRow) {
    if (selectedItems.length >= 10) return
    setSelectedItems(prev => [...prev, item]) // duplicates allowed
    setItemQuery('')
    setItemResults([])
  }

  function removeItem(index: number) {
    setSelectedItems(prev => prev.filter((_, i) => i !== index))
  }

  const ready = useMemo(
    () => !!file && selectedClassId !== null && Number.isFinite(wins) && wins >= 0 && wins <= 10,
    [file, selectedClassId, wins]
  )

  async function handleUpload() {
    if (!file) return
    setUploading(true)
    setUploadError(null)

    const fd = new FormData()
    fd.append('file', file)

    const res = await fetch('/api/ingest/upload', { method: 'POST', body: fd })
    if (!res.ok) {
      let msg = 'Upload failed'
      try {
        const j = await res.json()
        msg = j.error || msg
      } catch {}
      setUploadError(msg)
    }

    setUploading(false)
  }

  return (
    <div className="max-w-3xl mx-auto py-10 text-white">
      <h1 className="text-3xl font-bold mb-6">Bazzarlytics Beta</h1>

      <div className="border border-gray-700 rounded-lg p-6 space-y-6">
        {/* Screenshot */}
        <div>
          <label className="block mb-2 text-sm">Screenshot</label>

          <label className="inline-block px-4 py-2 bg-gray-800 border border-gray-600 rounded cursor-pointer hover:bg-gray-700">
            Choose file
            <input
              type="file"
              className="hidden"
              accept=".png,.jpg,.jpeg,.webp"
              onChange={e => {
                setFile(e.target.files?.[0] || null)
                setUploadError(null)
              }}
            />
          </label>

          {previewUrl && <img src={previewUrl} className="mt-4 max-h-80 rounded" alt="preview" />}
        </div>

        {/* Details */}
        <div>
          {classesLoadError && (
            <div className="mb-3 p-3 bg-red-100 text-red-800 rounded">
              <div className="font-semibold">Classes load error</div>
              <div>{classesLoadError}</div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block mb-1 text-sm">Class</label>
              <select
                className="w-full bg-black border border-gray-600 rounded px-2 py-1"
                value={selectedClassId === null ? '' : selectedClassId}
                onChange={e => {
                  const raw = e.target.value
                  setSelectedClassId(raw === '' ? null : raw)
                }}
              >
                {classes.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block mb-1 text-sm">Wins (0–10)</label>
              <input
                type="number"
                min={0}
                max={10}
                value={wins}
                onChange={e => {
                  winsTouchedRef.current = true
                  setWins(Number(e.target.value))
                }}
                className="w-full bg-black border border-gray-600 rounded px-2 py-1"
              />
            </div>
          </div>
        </div>

        {/* Items */}
        <div>
          <label className="block mb-1 text-sm">Items on board</label>
          <input
            value={itemQuery}
            onChange={e => setItemQuery(e.target.value)}
            className="w-full bg-black border border-gray-600 rounded px-2 py-1"
            placeholder="Type at least 2 characters"
          />

          {itemsLoading && <div className="text-sm text-gray-400 mt-1">Searching…</div>}
          {itemsError && <div className="text-sm text-red-400 mt-1">{itemsError}</div>}

          {itemResults.length > 0 && (
            <div className="mt-1 border border-gray-700 rounded bg-black">
              {itemResults.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => addItem(item)}
                  className="block w-full text-left px-3 py-2 hover:bg-gray-800 disabled:opacity-50"
                  disabled={selectedItems.length >= 10}
                  title={selectedItems.length >= 10 ? 'Max 10 items' : 'Add item'}
                >
                  {item.name}
                </button>
              ))}
            </div>
          )}

          {selectedItems.length > 0 && (
            <div className="mt-3 space-y-2">
              {selectedItems.map((it, i) => (
                <div
                  key={`${it.id}-${i}`}
                  className="flex justify-between items-center border border-gray-700 px-3 py-2 rounded"
                >
                  <span className="text-sm">{it.name}</span>
                  <button
                    type="button"
                    onClick={() => removeItem(i)}
                    className="text-sm px-2 py-1 border border-gray-600 rounded hover:bg-gray-900"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Upload */}
        <button
          disabled={!ready || uploading}
          onClick={handleUpload}
          className="w-full border border-gray-600 px-4 py-2 rounded disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : 'Upload screenshot'}
        </button>

        {uploadError && (
          <div className="p-3 bg-red-100 text-red-800 rounded">
            <div className="font-semibold">Upload error</div>
            <div>{uploadError}</div>
          </div>
        )}
      </div>
    </div>
  )
}
