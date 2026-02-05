import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const sha256 = searchParams.get('sha256')

  if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) {
    return NextResponse.json({ error: 'Invalid sha256' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('victory_submissions')
    .select('id,wins,storage_path')
    .eq('screenshot_sha256', sha256)
    .limit(1)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!data) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json({
    submissionId: data.id,
    wins: data.wins ?? null,
    storage_path: data.storage_path
  })
}
