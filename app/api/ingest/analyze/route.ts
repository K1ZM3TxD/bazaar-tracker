import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

export async function POST(req: Request) {
  try {
    const { screenshot_id } = await req.json()

    if (!screenshot_id) {
      return NextResponse.json({ error: 'Missing screenshot_id' }, { status: 400 })
    }

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

    // 1) Look up storage_path
    const { data: row, error: rowErr } = await supabase
      .from('victory_screenshots')
      .select('storage_path, image_hash')
      .eq('id', screenshot_id)
      .single()

    if (rowErr || !row?.storage_path) {
      return NextResponse.json(
        { error: 'Screenshot not found', details: rowErr?.message },
        { status: 404 }
      )
    }

    const storage_path = row.storage_path

    // 2) Create signed READ URL (10 minutes)
    const { data: signed, error: signErr } = await supabase.storage
      .from('victory_screenshots')
      .createSignedUrl(storage_path, 60 * 10)

    if (signErr || !signed?.signedUrl) {
      return NextResponse.json(
        { error: 'Failed to sign read url', details: signErr?.message },
        { status: 500 }
      )
    }

    const signed_read_url = signed.signedUrl

    // 3) Compute SHA-256 hash of the image bytes (exact-duplicate detection)
    const imgRes = await fetch(signed_read_url)
    if (!imgRes.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch image for hashing', status: imgRes.status },
        { status: 500 }
      )
    }

    const buf = Buffer.from(await imgRes.arrayBuffer())
    const image_hash = crypto.createHash('sha256').update(buf).digest('hex')

    // 4) If any other row already has this hash, treat as duplicate
    const { data: dup, error: dupErr } = await supabase
      .from('victory_screenshots')
      .select('id, storage_path')
      .eq('image_hash', image_hash)
      .neq('id', screenshot_id)
      .limit(1)
      .maybeSingle()

    if (dupErr) {
      return NextResponse.json(
        { error: 'Duplicate check failed', details: dupErr.message },
        { status: 500 }
      )
    }

    if (dup?.id) {
      // Prevent duplicates entering the system:
      // remove the just-uploaded object + delete its DB row
      await supabase.storage.from('victory_screenshots').remove([storage_path])
      await supabase.from('victory_screenshots').delete().eq('id', screenshot_id)

      return NextResponse.json(
        {
          error: 'Duplicate image',
          duplicate_of_screenshot_id: dup.id,
        },
        { status: 409 }
      )
    }

    // 5) Store hash on this row (unique constraint enforces no dupes)
    if (!row.image_hash) {
      const { error: updErr } = await supabase
        .from('victory_screenshots')
        .update({ image_hash })
        .eq('id', screenshot_id)

      if (updErr) {
        return NextResponse.json(
          { error: 'Failed to store image_hash', details: updErr.message },
          { status: 500 }
        )
      }
    }

    // 6) Return signed read URL (next step: AI uses this)
    return NextResponse.json({
      screenshot_id,
      storage_path,
      image_hash,
      signed_read_url,
    })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'Unexpected error', details: e?.message ?? String(e) },
      { status: 500 }
    )
  }
}
