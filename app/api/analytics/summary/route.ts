import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

type SummaryResponse = {
  totals: {
    submissions: number
    wins: number
  }
  avgWins: number
  winsHistogram: Record<number, number>
  topItems: Array<{ name: string; count: number }>
}

export async function GET(req: Request) {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' },
      { status: 500 }
    )
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  })

  try {
    const { searchParams } = new URL(req.url)
    const daysParam = searchParams.get('days')
    const days = daysParam ? Number(daysParam) : null

    if (daysParam && (!Number.isFinite(days) || days! <= 0)) {
      return NextResponse.json({ error: 'Invalid days parameter' }, { status: 400 })
    }

    let sinceIso: string | null = null
    if (days) {
      const since = new Date()
      since.setDate(since.getDate() - days)
      sinceIso = since.toISOString()
    }

    // Load submissions (guarded)
    let query = supabase
      .from('victory_submissions')
      .select('id, wins, created_at', { count: 'exact' })

    if (sinceIso) {
      query = query.gte('created_at', sinceIso)
    }

    const { data: submissions, count, error: subErr } = await query

    if (subErr) {
      return NextResponse.json(
        { error: 'Failed to load submissions', details: subErr.message },
        { status: 500 }
      )
    }

    if ((count ?? 0) > 2000) {
      return NextResponse.json(
        { error: 'Submission window too large' },
        { status: 400 }
      )
    }

    const totals = {
      submissions: submissions.length,
      wins: submissions.reduce((sum, s) => sum + (s.wins ?? 0), 0),
    }

    const avgWins =
      submissions.length > 0 ? totals.wins / submissions.length : 0

    const winsHistogram: Record<number, number> = {}
    for (const s of submissions) {
      const w = s.wins ?? 0
      winsHistogram[w] = (winsHistogram[w] || 0) + 1
    }

    // Top items
    let itemsQuery = supabase
      .from('victory_submission_items')
      .select('item_name, count')

    if (sinceIso) {
      itemsQuery = itemsQuery.gte('created_at', sinceIso)
    }

    const { data: items, error: itemsErr } = await itemsQuery

    if (itemsErr) {
      return NextResponse.json(
        { error: 'Failed to load item stats', details: itemsErr.message },
        { status: 500 }
      )
    }

    const itemMap = new Map<string, number>()
    for (const row of items) {
      itemMap.set(
        row.item_name,
        (itemMap.get(row.item_name) || 0) + (row.count ?? 0)
      )
    }

    const topItems = Array.from(itemMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    const response: SummaryResponse = {
      totals,
      avgWins,
      winsHistogram,
      topItems,
    }

    return NextResponse.json(response)
  } catch (e: any) {
    return NextResponse.json(
      { error: 'Unexpected server error', details: e?.message ?? String(e) },
      { status: 500 }
    )
  }
}