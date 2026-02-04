import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUCKET = "victory_screenshots";

function safeExt(contentType: string) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "bin";
}

export async function POST(req: Request) {
  try {
    const { contentType, userId } = (await req.json()) as {
      contentType: string;
      userId?: string;
    };

    if (!contentType || !contentType.startsWith("image/")) {
      return NextResponse.json(
        { error: "contentType must be an image/* type" },
        { status: 400 }
      );
    }

    const id = crypto.randomUUID();
    const ext = safeExt(contentType);
    const owner = userId ?? "anonymous";
    const storage_path = `${owner}/${id}.${ext}`;

    const { error: insertErr } = await supabase
      .from("victory_screenshots")
      .insert({ id, storage_path })
      .select()
      .single();

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    const { data, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(storage_path);

    if (signErr || !data) {
      return NextResponse.json(
        { error: signErr?.message ?? "Failed to create signed upload url" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      screenshot_id: id,
      storage_path,
      signed_upload_url: data.signedUrl,
      token: data.token,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
