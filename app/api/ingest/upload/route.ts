import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const endpoint = '/api/ingest/upload';

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      await supabase.from('app_event_logs').insert({
        endpoint,
        error_type: 'NO_FILE',
      });
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const ext = file.name.split('.').pop()?.toLowerCase() || 'bin';
    const storagePath = `${sha256}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('victory_screenshots')
      .upload(storagePath, buffer, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      // Storage-level duplicate
      if (uploadError.statusCode === '409') {
        await supabase.from('app_event_logs').insert({
          endpoint,
          error_type: 'DUPLICATE_STORAGE',
          screenshot_sha256: sha256,
        });
        return NextResponse.json(
          { error: 'Duplicate screenshot', email: 'k1zm3ths@gmail.com' },
          { status: 409 }
        );
      }

      await supabase.from('app_event_logs').insert({
        endpoint,
        error_type: 'STORAGE_UPLOAD_FAILED',
        screenshot_sha256: sha256,
      });
      return NextResponse.json(
        { error: 'Upload failed' },
        { status: 500 }
      );
    }

    // DB-level duplicate check (canonical)
    const { data: existing, error: checkError } = await supabase
      .from('victory_submissions')
      .select('id')
      .eq('screenshot_sha256', sha256)
      .limit(1)
      .maybeSingle();

    if (checkError) {
      await supabase.from('app_event_logs').insert({
        endpoint,
        error_type: 'DB_CHECK_FAILED',
        screenshot_sha256: sha256,
      });
      // cleanup uploaded file on failure
      await supabase.storage.from('victory_screenshots').remove([storagePath]);
      return NextResponse.json(
        { error: 'Server error' },
        { status: 500 }
      );
    }

    if (existing) {
      await supabase.from('app_event_logs').insert({
        endpoint,
        error_type: 'DUPLICATE_DB',
        screenshot_sha256: sha256,
      });
      // cleanup uploaded file on duplicate
      await supabase.storage.from('victory_screenshots').remove([storagePath]);
      return NextResponse.json(
        { error: 'Duplicate screenshot', email: 'k1zm3ths@gmail.com' },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        screenshot_sha256: sha256,
        storage_path: storagePath,
      },
      { status: 200 }
    );
  } catch {
    await supabase.from('app_event_logs').insert({
      endpoint,
      error_type: 'UNHANDLED_EXCEPTION',
    });
    return NextResponse.json(
      { error: 'Server error' },
      { status: 500 }
    );
  }
}
