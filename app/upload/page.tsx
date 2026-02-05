'use client'

import { useEffect, useState } from 'react'

type SummaryResponse = {
  totals?: {
    submissions: number
    unique_screenshots: number
  }
  error?: string
}

type StatusResponse = {
  submissionId: string
  wins: number | null
  storage_path: string
}

export default function UploadPage() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)

  const [screenshotId, setScreenshotId] = useState('')
  const [analyzeLoading, setAnalyzeLoading] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [imageHash, setImageHash] = useState<string | null>(null)

  const [statusSha, setStatusSha] = useState('')
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [statusResult, setStatusResult] = useState<StatusResponse | null>(null)

  useEffect(() => {
    setSummaryLoading(true)
    setSummaryError(null)

    fetch('/api/analytics/summary', { cache: 'no-store' })
      .then(async res => {
        const data = (await res.json()) as SummaryResponse
        if (!res.ok || data.error) {
          throw new Error(data.error || 'Failed to load analytics')
        }
        setSummary(data)
      })
      .catch(err => {
        setSummaryError(err?.message || 'Failed to load analytics')
      })
      .finally(() => {
        setSummaryLoading(false)
      })
  }, [])

  async function handleAnalyze() {
    if (!screenshotId.trim()) return
    setAnalyzeLoading(true)
    setAnalyzeError(null)
    setImageHash(null)
    setStatusResult(null)
    setStatusError(null)

    try {
      const res = await fetch('/api/ingest/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ screenshot_id: screenshotId.trim() }),
      })

      const data = (await res.json()) as { image_hash?: string; error?: string }
      if (!res.ok || data.error || !data.image_hash) {
        throw new Error(data.error || 'Analyze failed')
      }

      setImageHash(data.image_hash)
      setStatusSha(data.image_hash)
      await handleStatusLookup(data.image_hash)
    } catch (err: any) {
      setAnalyzeError(err?.message || 'Analyze failed')
    } finally {
      setAnalyzeLoading(false)
    }
  }

  async function handleStatusLookup(shaOverride?: string) {
    const sha = (shaOverride ?? statusSha).trim()
    if (!sha) return
    setStatusLoading(true)
    setStatusError(null)
    setStatusResult(null)

    try {
      const res = await fetch(`/api/ingest/status?sha256=${encodeURIComponent(sha)}`, {
        cache: 'no-store',
      })

      const data = (await res.json()) as StatusResponse & { error?: string }
      if (res.status === 404) {
        setStatusError('No submission found yet. Try again later.')
        return
      }
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Status check failed')
      }
      setStatusResult(data)
    } catch (err: any) {
      setStatusError(err?.message || 'Status check failed')
    } finally {
      setStatusLoading(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto py-10 text-white">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-3xl font-bold">Bazzarlytics Beta</h1>
        <a className="text-sm text-gray-400 underline" href="/analytics">
          Analytics
        </a>
      </div>

      <div className="border border-gray-700 rounded-lg p-6 space-y-6">
        <div>
          <div className="text-sm text-gray-400 mb-2">Analytics snapshot</div>
          {summaryLoading && <div className="text-sm text-gray-400">Loading…</div>}
          {summaryError && <div className="text-sm text-red-400">{summaryError}</div>}
          {summary?.totals && !summaryLoading && !summaryError && (
            <div className="grid grid-cols-2 gap-4">
              <div className="border border-gray-700 rounded-lg p-4 bg-black">
                <div className="text-xs text-gray-400">Total submissions</div>
                <div className="text-2xl font-bold mt-1">{summary.totals.submissions}</div>
              </div>
              <div className="border border-gray-700 rounded-lg p-4 bg-black">
                <div className="text-xs text-gray-400">Unique screenshots</div>
                <div className="text-2xl font-bold mt-1">
                  {summary.totals.unique_screenshots}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="border border-gray-800 rounded-lg p-4 space-y-3">
          <div className="text-sm text-gray-300 font-semibold">Analyze screenshot</div>
          <label className="block text-sm text-gray-400">Screenshot ID</label>
          <input
            className="w-full bg-black border border-gray-600 rounded px-3 py-2"
            placeholder="Enter screenshot_id"
            value={screenshotId}
            onChange={e => setScreenshotId(e.target.value)}
          />
          <button
            type="button"
            onClick={handleAnalyze}
            disabled={!screenshotId.trim() || analyzeLoading}
            className="w-full border border-gray-600 px-4 py-2 rounded disabled:opacity-50"
          >
            {analyzeLoading ? 'Analyzing…' : 'Analyze screenshot'}
          </button>
          {analyzeError && <div className="text-sm text-red-400">{analyzeError}</div>}
          {imageHash && (
            <div className="text-xs text-emerald-300">
              Image hash: <span className="break-all">{imageHash}</span>
            </div>
          )}
        </div>

        <div className="border border-gray-800 rounded-lg p-4 space-y-3">
          <div className="text-sm text-gray-300 font-semibold">Check status</div>
          <label className="block text-sm text-gray-400">SHA-256</label>
          <input
            className="w-full bg-black border border-gray-600 rounded px-3 py-2"
            placeholder="Paste sha256"
            value={statusSha}
            onChange={e => setStatusSha(e.target.value)}
          />
          <button
            type="button"
            onClick={() => handleStatusLookup()}
            disabled={!statusSha.trim() || statusLoading}
            className="w-full border border-gray-600 px-4 py-2 rounded disabled:opacity-50"
          >
            {statusLoading ? 'Checking…' : 'Check status'}
          </button>
          {statusError && <div className="text-sm text-red-400">{statusError}</div>}
          {statusResult && (
            <div className="text-sm text-gray-200 space-y-1">
              <div>Submission: {statusResult.submissionId}</div>
              <div>Wins: {statusResult.wins ?? '—'}</div>
              <div className="text-xs text-gray-400 break-all">
                Storage path: {statusResult.storage_path}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
