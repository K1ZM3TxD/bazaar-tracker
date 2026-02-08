'use client'

import { useEffect, useRef, useState } from 'react'

type AnalyzeResponse = {
  sha256?: string
  screenshot_sha256?: string
  submissionId?: string
  wins?: number
  deduped?: boolean
  dedupe?: boolean
  error?: string
}

type EvidenceSignal = {
  source: string
  type: string
  value: string
  weight: number
  meta: Record<string, any>
}

type ClassificationSummary = {
  version: number | null
  status: string | null
  hasCandidates: boolean
  itemCandidateCount: number
  classCandidateCount: number
  evidence?: {
    signals: EvidenceSignal[]
  }
}

type StatusResponse = {
  submissionId?: string
  wins?: number | null
  storage_path?: string
  classification?: ClassificationSummary | null
  error?: string
}

type UploadStatus = 'idle' | 'uploading' | 'processing' | 'done' | 'error'

export default function UploadPage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [status, setStatus] = useState<UploadStatus>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const [sha256, setSha256] = useState<string | null>(null)
  const [submissionId, setSubmissionId] = useState<string | null>(null)
  const [wins, setWins] = useState<number | null>(null)
  const [dedupe, setDedupe] = useState<boolean | null>(null)

  // Classification panel state (from /api/ingest/status persisted data)
  const [classification, setClassification] = useState<ClassificationSummary | null>(null)
  const [showEvidence, setShowEvidence] = useState<boolean>(false)
  const [evidenceSignals, setEvidenceSignals] = useState<EvidenceSignal[] | null>(null)
  const [evidenceLoading, setEvidenceLoading] = useState<boolean>(false)
  const [evidenceError, setEvidenceError] = useState<string | null>(null)

  const pollingRef = useRef<{
    intervalId?: ReturnType<typeof setInterval>
    timeoutId?: ReturnType<typeof setTimeout>
    inFlight: boolean
  }>({ inFlight: false })

  const stopPolling = () => {
    if (pollingRef.current.intervalId) {
      clearInterval(pollingRef.current.intervalId)
    }
    if (pollingRef.current.timeoutId) {
      clearTimeout(pollingRef.current.timeoutId)
    }
    pollingRef.current.intervalId = undefined
    pollingRef.current.timeoutId = undefined
    pollingRef.current.inFlight = false
  }

  useEffect(() => {
    return () => {
      stopPolling()
    }
  }, [])

  const statusLabel = (() => {
    switch (status) {
      case 'uploading':
        return 'Uploading…'
      case 'processing':
        return 'Processing…'
      case 'done':
        return 'Done'
      case 'error':
        return 'Error'
      default:
        return 'Idle'
    }
  })()

  async function fetchStatusBySubmissionId(id: string, includeEvidence: boolean) {
    const url = includeEvidence
      ? `/api/ingest/status?submissionId=${encodeURIComponent(id)}&include=evidence`
      : `/api/ingest/status?submissionId=${encodeURIComponent(id)}`
    const res = await fetch(url, { cache: 'no-store' })
    const data = (await res.json()) as StatusResponse
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Status check failed')
    }
    return data
  }

  async function handleUpload() {
    if (!selectedFile) {
      setErrorMessage('Please select an image to upload.')
      setStatus('error')
      return
    }

    setErrorMessage(null)
    setStatus('uploading')
    setSha256(null)
    setSubmissionId(null)
    setWins(null)
    setDedupe(null)
    setClassification(null)
    setShowEvidence(false)
    setEvidenceSignals(null)
    setEvidenceLoading(false)
    setEvidenceError(null)
    stopPolling()

    try {
      const formData = new FormData()
      formData.append('file', selectedFile)

      const res = await fetch('/api/ingest/analyze', {
        method: 'POST',
        body: formData,
      })

      const data = (await res.json()) as AnalyzeResponse
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Upload failed')
      }

      const resolvedSha = data.sha256 || data.screenshot_sha256
      if (!resolvedSha) {
        throw new Error('Upload succeeded but no sha256 returned.')
      }

      setSha256(resolvedSha)
      if (data.submissionId) {
        setSubmissionId(data.submissionId)
      }
      if (typeof data.wins === 'number') {
        setWins(data.wins)
      }
      if (typeof data.dedupe === 'boolean') {
        setDedupe(data.dedupe)
      } else if (typeof data.deduped === 'boolean') {
        setDedupe(data.deduped)
      }

      // If we already have a submissionId, fetch status once to populate classification panel (persisted data).
      if (data.submissionId) {
        try {
          const st = await fetchStatusBySubmissionId(data.submissionId, false)
          if (st.classification !== undefined) {
            setClassification(st.classification ?? null)
          }
        } catch {
          // keep silent; polling can still succeed
        }
      }

      if (typeof data.wins === 'number') {
        setStatus('done')
        return
      }

      setStatus('processing')
      startPolling(resolvedSha)
    } catch (err: any) {
      setErrorMessage(err?.message || 'Upload failed')
      setStatus('error')
    }
  }

  function startPolling(hash: string) {
    stopPolling()

    const poll = async () => {
      if (pollingRef.current.inFlight) return
      pollingRef.current.inFlight = true

      try {
        const res = await fetch(`/api/ingest/status?sha256=${encodeURIComponent(hash)}`, {
          cache: 'no-store',
        })

        const data = (await res.json()) as StatusResponse
        if (!res.ok || data.error) {
          throw new Error(data.error || 'Status check failed')
        }

        if (data.submissionId) {
          setSubmissionId(data.submissionId)
        }

        if (data.classification !== undefined) {
          setClassification(data.classification ?? null)
        }

        if (typeof data.wins === 'number') {
          setWins(data.wins)
          setStatus('done')
          stopPolling()
        }
      } catch (err: any) {
        setErrorMessage(err?.message || 'Status check failed')
        setStatus('error')
        stopPolling()
      } finally {
        pollingRef.current.inFlight = false
      }
    }

    pollingRef.current.intervalId = setInterval(poll, 1000)
    pollingRef.current.timeoutId = setTimeout(() => {
      setErrorMessage('Polling timed out after 30 seconds.')
      setStatus('error')
      stopPolling()
    }, 30_000)

    poll()
  }

  async function toggleEvidence(next: boolean) {
    setShowEvidence(next)
    setEvidenceError(null)

    if (!next) {
      setEvidenceSignals(null)
      setEvidenceLoading(false)
      return
    }

    if (!submissionId) {
      setEvidenceSignals(null)
      setEvidenceLoading(false)
      setEvidenceError('No submissionId yet (upload still processing).')
      return
    }

    setEvidenceLoading(true)
    setEvidenceSignals(null)

    try {
      const st = await fetchStatusBySubmissionId(submissionId, true)
      const signals = st.classification?.evidence?.signals ?? []
      setEvidenceSignals(signals)
      // Keep the summary fields aligned with latest persisted status too.
      if (st.classification !== undefined) {
        setClassification(st.classification ?? null)
      }
    } catch (e: any) {
      setEvidenceError(e?.message || 'Failed to load evidence')
    } finally {
      setEvidenceLoading(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-10 text-white">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Upload Screenshot</h1>
        <p className="text-sm text-gray-400 mt-2">
          Upload a Bazaar victory screenshot and we will analyze it for wins.
        </p>
      </div>

      <div className="border border-gray-700 rounded-lg p-6 space-y-4 bg-black/30">
        <div className="space-y-2">
          <label className="block text-sm text-gray-300">Screenshot image</label>
          <input
            type="file"
            accept="image/*"
            className="w-full text-sm text-gray-200 file:mr-4 file:rounded file:border-0 file:bg-gray-800 file:px-4 file:py-2 file:text-sm file:text-gray-200 hover:file:bg-gray-700"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              setSelectedFile(file)
            }}
          />
        </div>

        <button
          type="button"
          onClick={handleUpload}
          disabled={status === 'uploading'}
          className="w-full border border-gray-600 px-4 py-2 rounded disabled:opacity-60"
        >
          {status === 'uploading' ? 'Uploading…' : 'Upload'}
        </button>

        <div className="text-sm text-gray-300">Status: {statusLabel}</div>

        {errorMessage && <div className="text-sm text-red-400">{errorMessage}</div>}

        {sha256 && (
          <div className="text-sm text-gray-200 space-y-2">
            <div>
              SHA-256: <span className="text-emerald-300 break-all font-mono">{sha256}</span>
            </div>
            {submissionId && <div>Submission ID: {submissionId}</div>}
            {dedupe !== null && <div>Dedupe: {dedupe ? 'true' : 'false'}</div>}
            <div>Wins: {wins ?? '—'}</div>
          </div>
        )}

        {/* Classification panel (submission details) */}
        {submissionId && (
          <div className="border border-gray-700 rounded-lg p-4 bg-black/40 space-y-3">
            <div className="text-sm font-semibold text-gray-200">Classification</div>

            {!classification && <div className="text-sm text-gray-400">No classification data.</div>}

            {classification && (
              <div className="text-sm text-gray-200 space-y-1">
                <div>
                  status: <span className="font-mono">{String(classification.status ?? 'null')}</span>
                </div>
                <div>hasCandidates: {classification.hasCandidates ? 'true' : 'false'}</div>
                <div>itemCandidateCount: {classification.itemCandidateCount}</div>
                <div>classCandidateCount: {classification.classCandidateCount}</div>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm text-gray-200">
              <input
                type="checkbox"
                checked={showEvidence}
                disabled={!submissionId}
                onChange={(e) => {
                  void toggleEvidence(e.target.checked)
                }}
              />
              Show evidence
            </label>

            {showEvidence && (
              <div className="space-y-2">
                {evidenceLoading && <div className="text-sm text-gray-400">Loading evidence…</div>}
                {evidenceError && <div className="text-sm text-red-400">{evidenceError}</div>}

                {!evidenceLoading && !evidenceError && evidenceSignals && evidenceSignals.length === 0 && (
                  <div className="text-sm text-gray-400">No evidence signals.</div>
                )}

                {!evidenceLoading && !evidenceError && evidenceSignals && evidenceSignals.length > 0 && (
                  <ul className="space-y-2">
                    {evidenceSignals.map((s, idx) => (
                      <li key={idx} className="border border-gray-700 rounded p-2 bg-black/30">
                        <div className="text-sm">
                          <span className="text-gray-400">source:</span>{' '}
                          <span className="font-mono">{s.source}</span>
                        </div>
                        <div className="text-sm">
                          <span className="text-gray-400">type:</span>{' '}
                          <span className="font-mono">{s.type}</span>
                        </div>
                        <div className="text-sm">
                          <span className="text-gray-400">value:</span>{' '}
                          <span className="font-mono">{s.value}</span>
                        </div>
                        <div className="text-sm">
                          <span className="text-gray-400">weight:</span>{' '}
                          <span className="font-mono">{String(s.weight)}</span>
                        </div>
                        <div className="text-sm">
                          <span className="text-gray-400">meta:</span>
                        </div>
                        <pre className="text-xs text-gray-200 bg-black/50 border border-gray-700 rounded p-2 overflow-auto">
                          {JSON.stringify(s.meta ?? {}, null, 2)}
                        </pre>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}