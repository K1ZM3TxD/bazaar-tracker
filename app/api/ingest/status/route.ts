import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function isSha256Hex(s: string) {
  return /^[a-f0-9]{64}$/i.test(s);
}

function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const include = (searchParams.get("include") ?? "").trim().toLowerCase();
  const includeEvidence = include === "evidence";

  const submissionId = (searchParams.get("submissionId") ?? "").trim();

  // Accept both params; prefer screenshot_sha256 if both present (unless submissionId is provided).
  const screenshotSha = searchParams.get("screenshot_sha256");
  const sha = searchParams.get("sha256");
  const sha256 = (screenshotSha ?? sha ?? "").trim();

  // Priority: submissionId -> screenshot_sha256 -> sha256
  const hasSubmissionId = !!submissionId;
  if (hasSubmissionId) {
    if (!isUuid(submissionId)) {
      return NextResponse.json(
        {
          error:
            "Invalid submissionId. Provide a UUID via ?submissionId=<uuid> or a screenshot hash via ?screenshot_sha256=<hash> (preferred) or ?sha256=<hash>.",
        },
        { status: 400 }
      );
    }
  } else {
    if (!sha256 || !isSha256Hex(sha256)) {
      return NextResponse.json(
        {
          error:
            "Missing/invalid params. Provide either ?submissionId=<uuid> OR ?screenshot_sha256=<64-char hex> (preferred) OR ?sha256=<64-char hex>.",
        },
        { status: 400 }
      );
    }
  }

  const query = supabase.from("victory_submissions").select("id,wins,screenshot_id,classification_result");

  const { data, error } = hasSubmissionId
    ? await query.eq("id", submissionId).limit(1).maybeSingle()
    : await query.eq("screenshot_sha256", sha256).limit(1).maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json(
      { error: hasSubmissionId ? "Not found for submissionId" : "Not found for sha256" },
      { status: 404 }
    );
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

  const classificationStored = (data as any).classification_result ?? null;

  let classification:
    | {
        version: number | null;
        status: string | null;
        hasCandidates: boolean;
        itemCandidateCount: number;
        classCandidateCount: number;
        evidence?: { signals: any[] };
      }
    | null = null;

  if (classificationStored && typeof classificationStored === "object") {
    const items = Array.isArray((classificationStored as any)?.candidates?.items)
      ? (classificationStored as any).candidates.items
      : [];
    const classes = Array.isArray((classificationStored as any)?.candidates?.class)
      ? (classificationStored as any).candidates.class
      : [];

    const base = {
      version: (classificationStored as any).version ?? null,
      status: (classificationStored as any).status ?? null,
      hasCandidates: items.length > 0 || classes.length > 0,
      itemCandidateCount: items.length,
      classCandidateCount: classes.length,
    };

    if (includeEvidence) {
      const signals = Array.isArray((classificationStored as any)?.evidence?.signals)
        ? (classificationStored as any).evidence.signals
        : [];
      classification = { ...base, evidence: { signals } };
    } else {
      classification = base;
    }
  }

  return NextResponse.json({
    submissionId: data.id,
    wins: data.wins ?? null,
    storage_path,
    classification,
  });
}