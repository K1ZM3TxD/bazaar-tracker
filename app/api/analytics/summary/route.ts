import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  try {
    const { data: submissions, error } = await supabase
      .from('victory_submissions')
      .select(`
        id,
        wins,
        class,
        victory_submission_items (
          item_id
        )
      `)

    if (error) {
      return NextResponse.json(
        { error: 'Failed to load submissions', supabase_error: error },
        { status: 500 }
      )
    }

    return NextResponse.json({ submissions })
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Unexpected server error', details: err?.message },
      { status: 500 }
    )
  }
}
