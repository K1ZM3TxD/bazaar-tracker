import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  const { data, error } = await supabase
    .from('bazaar_classes')
    .select('id,name')
    .order('name', { ascending: true })

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch classes' }, { status: 500 })
  }

  return NextResponse.json({ classes: data ?? [] })
}
