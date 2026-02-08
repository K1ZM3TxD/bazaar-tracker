import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function isSha256Hex(s: string) {
  return /^[a-f0-9]{64}$/i.test(s);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  // Accept both params; prefer screenshot_sha256 if both present.
  const screenshotSha = searchParams.get("screenshot_sha256");
  const sha = searchParams.get("sha256");
  const sha256 = (screenshotSha ?? sha ?? "").trim();

  if (!sha256 || !isSha256Hex(sha256)) {
    return NextResponse.json(
      {
        error:
          "Invalid sha256. Provide a 64-char hex hash via ?screenshot_sha256=<hash> (preferred) or ?sha256=<hash>.",
      },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("victory_submissions")
    .select("id,wins,screenshot_id")
    .eq("screenshot_sha256", sha256)
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let storage_path: string | null = null;
  if (data.screenshot_id) {
    const { data: screenshot, error: screenshotError } = await supabase
      .from("victory_screenshots")
      .select("storage_path")
      .eq("id", data.screenshot_id)
      .limit(1)
      .maybeSingle();

    if (screenshotError) {
      return NextResponse.json({ error: screenshotError.message }, { status: 500 });
    }

    storage_path = screenshot?.storage_path ?? null;
  }

  return NextResponse.json({
    submissionId: data.id,
    wins: data.wins ?? null,
    storage_path,
  });
}