import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: Request) {
  try {
    const body = await req.json()

    const screenshot_sha256 = body?.screenshot_sha256 as string | undefined
    const storage_path = body?.storage_path as string | undefined
    const class_id = body?.class_id as string | undefined
    const wins = body?.wins as number | undefined
    const item_ids = body?.item_ids as string[] | undefined

    if (!screenshot_sha256 || !storage_path || !class_id || wins === undefined || !Array.isArray(item_ids)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!Number.isInteger(wins) || wins < 0 || wins > 10) {
      return NextResponse.json({ error: 'Wins must be an integer 0–10' }, { status: 400 })
    }

    if (item_ids.length > 10) {
      return NextResponse.json({ error: 'Max 10 items' }, { status: 400 })
    }

    // Insert submission (dedupe enforced by UNIQUE screenshot_sha256)
    const { data: submission, error: subErr } = await supabase
      .from('victory_submissions')
      .insert({
        screenshot_sha256,
        storage_path,
        class_id,
        wins
      })
      .select('id')
      .single()

    if (subErr) throw subErr

    // Insert item instances (duplicates allowed)
    if (item_ids.length > 0) {
      const rows = item_ids.map((item_id) => ({
        submission_id: submission.id,
        item_id
      }))

      const { error: itemErr } = await supabase
        .from('victory_submission_items')
        .insert(rows)

      if (itemErr) throw itemErr
    }

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    await supabase.from('app_event_logs').insert({
      endpoint: '/api/ingest/submit',
      error_type: err?.message ?? 'unknown'
    })

    return NextResponse.json({ error: 'Submit failed' }, { status: 500 })
  }
}
