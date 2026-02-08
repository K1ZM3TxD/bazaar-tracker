import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { extractWinsFromBytes } from "../../vision/extract/route";
import {
  extractItemCropsFromBytes,
  type VisionItemsExtractResponse as ItemsExtractResponse,
} from "../../vision/items/extract/route";
import { POST as classifyItemsPost } from "../../vision/items/classify/route";

type BazaarClass = {
  id: string | number;
  name: string | null;
};

function jsonError(message: string, status = 500, extra?: any) {
  return NextResponse.json({ ok: false, error: message, ...(extra ? { extra } : {}) }, { status });
}

function isHex64(s: string) {
  return /^[0-9a-f]{64}$/i.test(s);
}

function parseMode(modeRaw: string | null): "disabled" | "no_matches" | "ambiguous" | "class_candidates" | null {
  const m = (modeRaw ?? "").trim().toLowerCase();
  return m === "disabled" || m === "no_matches" || m === "ambiguous" || m === "class_candidates" ? m : null;
}

async function runClassificationMode(bytes: Buffer, ext: string, contentType: string, mode: string) {
  // Call the local route handler directly with a Request that includes ?mode=
  const url = new URL("http://local/api/vision/items/classify");
  url.searchParams.set("mode", mode);

  const fd = new FormData();
  // classify route expects field "image"
  fd.set("image", new File([bytes], `upload.${ext}`, { type: contentType }));

  const req = new Request(url.toString(), { method: "POST", body: fd }) as any;
  const res: any = await classifyItemsPost(req);

  const body = await res.json().catch(() => null);

  if (!res?.ok) {
    return { ok: false as const, body };
  }

  return { ok: true as const, classification: body?.classification ?? null, body };
}

export async function POST(req: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRole) {
      return jsonError("Supabase env missing", 500);
    }

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    const { searchParams } = new URL(req.url);
    const mode = parseMode(searchParams.get("mode"));

    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) {
      return jsonError("Missing file", 400);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const screenshot_sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

    if (!isHex64(screenshot_sha256)) {
      return jsonError("Invalid screenshot sha256", 500);
    }

    // Deduplicate early (but make classification behavior explicit/observable when mode is provided)
    const { data: existing, error: existingErr } = await supabase
      .from("victory_submissions")
      .select("id, wins, screenshot_sha256, classification_result")
      .eq("screenshot_sha256", screenshot_sha256)
      .maybeSingle();

    if (existingErr) {
      return jsonError("Supabase victory_submissions query failed", 500, {
        where: "victory_submissions.select",
        message: existingErr.message,
      });
    }

    if (existing?.id) {
      // Deterministic dedupe semantics:
      // - If mode provided: recompute + persist classification_result (observable)
      // - Else: do not recompute (explicit)
      if (mode) {
        const ext = (file.type && file.type.includes("/") ? file.type.split("/")[1] : "") || "png";
        const contentType = file.type || "image/png";

        const classified = await runClassificationMode(bytes, ext, contentType, mode);
        if (!classified.ok) {
          return jsonError("Item classify (mode) returned error", 500, {
            where: "vision.items.classify",
            mode,
            body: classified.body ?? null,
          });
        }

        const classification_result = classified.classification ?? null;

        const { error: updErr } = await supabase
          .from("victory_submissions")
          .update({ classification_result })
          .eq("id", existing.id);

        if (updErr) {
          return jsonError("Failed to update classification_result on deduped submission", 500, {
            where: "victory_submissions.update",
            message: updErr.message,
          });
        }

        return NextResponse.json({
          ok: true,
          deduped: true,
          submissionId: existing.id,
          wins: existing.wins,
          screenshot_sha256: existing.screenshot_sha256,
          classificationRecomputed: true,
        });
      }

      return NextResponse.json({
        ok: true,
        deduped: true,
        submissionId: existing.id,
        wins: existing.wins,
        screenshot_sha256: existing.screenshot_sha256,
        classificationRecomputed: false,
      });
    }

    // Upload screenshot
    const ext = (file.type && file.type.includes("/") ? file.type.split("/")[1] : "") || "png";
    const contentType = file.type || "image/png";
    const storage_path = `ingest/${screenshot_sha256}.${ext}`;

    const { error: uploadErr } = await supabase.storage.from("victory_screenshots").upload(storage_path, bytes, {
      contentType,
      upsert: true,
    });

    if (uploadErr) {
      return jsonError("Failed to upload screenshot to storage", 500, {
        where: "victory_screenshots.upload",
        message: uploadErr.message,
      });
    }

    // Wins extraction (required; no silent fallback)
    let wins: number;
    try {
      const result = await extractWinsFromBytes(bytes);
      if (result.wins === null || result.wins === undefined) {
        return jsonError("Wins extraction did not classify banner", 422, {
          where: "wins.extract",
          bannerHash: result.bannerHash,
          bannerBestDist: result.bannerBestDist,
          bannerBestHash: result.bannerBestHash,
        });
      }
      wins = result.wins;
    } catch (e: any) {
      return jsonError("Wins extraction failed", 500, {
        where: "wins.extract",
        message: e?.message ?? null,
        stack: e?.stack ?? null,
      });
    }

    // Item slot crops (best effort) — local module call (no external service)
    let itemCrops: ItemsExtractResponse | null = null;
    try {
      itemCrops = await extractItemCropsFromBytes(bytes);
    } catch {
      itemCrops = null;
    }

    // Classification persistence (only when mode is explicitly requested)
    let classification_result: any = null;
    let classificationRecomputed = false;

    if (mode) {
      const classified = await runClassificationMode(bytes, ext, contentType, mode);
      if (!classified.ok) {
        return jsonError("Item classify (mode) returned error", 500, {
          where: "vision.items.classify",
          mode,
          body: classified.body ?? null,
        });
      }
      classification_result = classified.classification ?? null;
      classificationRecomputed = true;
    }

    // Determine class (fallback)
    const { data: classes, error: classesErr } = await supabase
      .from("bazaar_classes")
      .select("id, name")
      .order("created_at", { ascending: true });

    if (classesErr) {
      return jsonError("Supabase bazaar_classes query failed", 500, {
        where: "bazaar_classes.select",
        message: classesErr.message,
      });
    }

    const defaultClass: BazaarClass =
      classes?.find((c: any) => (c?.name || "").toLowerCase() === "unknown") ?? classes?.[0];

    if (!defaultClass?.id) {
      return jsonError("Missing bazaar class", 500);
    }

    const screenshotId = crypto.randomUUID();

    const { error: screenshotInsertErr } = await supabase.from("victory_screenshots").insert({
      id: screenshotId,
      storage_path,
    });

    if (screenshotInsertErr) {
      return jsonError("Failed to insert victory_screenshots", 500, {
        where: "victory_screenshots.insert",
        message: screenshotInsertErr.message,
      });
    }

    const submissionPayload = {
      screenshot_id: screenshotId,
      screenshot_sha256,
      class: defaultClass.id,
      wins,
      classification_result: classification_result ?? null,
    };

    const { data: created, error: subErr } = await supabase
      .from("victory_submissions")
      .insert(submissionPayload)
      .select("id")
      .single();

    if (subErr || !created?.id) {
      const rawErr: any = subErr as any;
      const combined = `${rawErr?.message ?? ""} ${rawErr?.details ?? ""}`;
      const parsedConstraint = rawErr?.constraint ?? combined.match(/constraint "([^"]+)"/i)?.[1] ?? null;

      const errObj = {
        where: "victory_submissions.insert",
        pg_code: rawErr?.code ?? null,
        constraint: parsedConstraint,
        message: rawErr?.message ?? null,
        details: rawErr?.details ?? null,
        hint: rawErr?.hint ?? null,
        table: rawErr?.table ?? null,
        payload: submissionPayload,
      };

      console.error("victory_submissions insert failed", errObj);
      return jsonError("Failed to insert victory_submissions", 500, errObj);
    }

    return NextResponse.json({
      ok: true,
      deduped: false,
      submissionId: created.id,
      wins,
      storage_path,
      screenshot_sha256,
      classificationRecomputed,
      // Observability only (not persisted here)
      itemCrops: itemCrops ?? null,
    });
  } catch (e: any) {
    return jsonError("Unhandled error", 500, {
      message: e?.message,
      stack: e?.stack,
    });
  }
}