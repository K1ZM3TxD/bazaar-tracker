import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

export async function GET(req: Request) {
  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonError('Server misconfigured', 500)
  }

  const { searchParams } = new URL(req.url)
  const query = (searchParams.get('query') || '').trim()

  if (query.length < 2) {
    return NextResponse.json({ items: [] })
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey)

  // Case-insensitive search: use ilike
  const { data, error } = await supabase
    .from('bazaar_items')
    .select('id,name')
    .ilike('name', `%${query}%`)
    .order('name', { ascending: true })
    .limit(15)

  if (error) {
    return jsonError('Failed to fetch items', 500)
  }

  return NextResponse.json({ items: data ?? [] })
}
