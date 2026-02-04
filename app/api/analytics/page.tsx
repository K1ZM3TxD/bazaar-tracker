export const dynamic = 'force-dynamic'

type SummaryResponse = {
  totals: {
    submissions: number
    unique_screenshots: number
  }
  top_heroes: Array<{ class_id: string; class_name: string; submissions: number; avg_wins: number }>
  top_items: Array<{ item_id: number; item_name: string; picks: number; avg_wins: number }>
  wins_distribution: Array<{ wins: number; submissions: number }>
  error?: string
}

async function getSummary(): Promise<SummaryResponse> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_SITE_URL ?? ''}/api/analytics/summary`, {
    cache: 'no-store',
  })

  // If NEXT_PUBLIC_SITE_URL isn't set, fall back to relative fetch.
  if (!res.ok) {
    // retry relative
    const res2 = await fetch('/api/analytics/summary', { cache: 'no-store' })
    const data2 = (await res2.json()) as SummaryResponse
    return data2
  }

  const data = (await res.json()) as SummaryResponse
  return data
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-black">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  )
}

export default async function AnalyticsPage() {
  let data: SummaryResponse
  try {
    data = await getSummary()
  } catch {
    data = { totals: { submissions: 0, unique_screenshots: 0 }, top_heroes: [], top_items: [], wins_distribution: [], error: 'Failed to load analytics' }
  }

  return (
    <div className="max-w-5xl mx-auto py-10 text-white">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-3xl font-bold">Bazzarlytics Beta</h1>
        <a className="text-sm text-gray-400 underline" href="/upload">
          Upload
        </a>
      </div>

      {data.error && (
        <div className="mb-6 p-4 rounded bg-red-100 text-red-800 border border-red-200">
          <div className="font-semibold">Analytics error</div>
          <div>{data.error}</div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <Tile label="Total submissions" value={String(data.totals.submissions)} />
        <Tile label="Unique screenshots" value={String(data.totals.unique_screenshots)} />
        <Tile
          label="Most common hero"
          value={data.top_heroes[0] ? `${data.top_heroes[0].class_name}` : '—'}
        />
        <Tile
          label="Most picked item"
          value={data.top_items[0] ? `${data.top_items[0].item_name}` : '—'}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="border border-gray-700 rounded-lg p-5 bg-black">
          <h2 className="font-semibold mb-3">Wins distribution</h2>
          <div className="space-y-2">
            {data.wins_distribution.map(row => (
              <div key={row.wins} className="flex items-center gap-3">
                <div className="w-10 text-sm text-gray-300">{row.wins}</div>
                <div className="flex-1 h-3 border border-gray-700 rounded">
                  <div
                    className="h-3 rounded bg-gray-300"
                    style={{
                      width:
                        data.totals.submissions > 0
                          ? `${Math.round((row.submissions / data.totals.submissions) * 100)}%`
                          : '0%',
                    }}
                  />
                </div>
                <div className="w-12 text-sm text-gray-300 text-right">{row.submissions}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="border border-gray-700 rounded-lg p-5 bg-black">
          <h2 className="font-semibold mb-3">Top heroes</h2>
          <div className="overflow-hidden rounded border border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-300">
                <tr>
                  <th className="text-left px-3 py-2">Hero</th>
                  <th className="text-right px-3 py-2">Subs</th>
                  <th className="text-right px-3 py-2">Avg wins</th>
                </tr>
              </thead>
              <tbody>
                {data.top_heroes.map(h => (
                  <tr key={h.class_id} className="border-t border-gray-800">
                    <td className="px-3 py-2">{h.class_name}</td>
                    <td className="px-3 py-2 text-right">{h.submissions}</td>
                    <td className="px-3 py-2 text-right">{h.avg_wins}</td>
                  </tr>
                ))}
                {data.top_heroes.length === 0 && (
                  <tr>
                    <td className="px-3 py-3 text-gray-400" colSpan={3}>
                      No data yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="border border-gray-700 rounded-lg p-5 bg-black md:col-span-2">
          <h2 className="font-semibold mb-3">Top items</h2>
          <div className="overflow-hidden rounded border border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-300">
                <tr>
                  <th className="text-left px-3 py-2">Item</th>
                  <th className="text-right px-3 py-2">Picks</th>
                  <th className="text-right px-3 py-2">Avg wins</th>
                </tr>
              </thead>
              <tbody>
                {data.top_items.map(it => (
                  <tr key={it.item_id} className="border-t border-gray-800">
                    <td className="px-3 py-2">{it.item_name}</td>
                    <td className="px-3 py-2 text-right">{it.picks}</td>
                    <td className="px-3 py-2 text-right">{it.avg_wins}</td>
                  </tr>
                ))}
                {data.top_items.length === 0 && (
                  <tr>
                    <td className="px-3 py-3 text-gray-400" colSpan={3}>
                      No data yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
