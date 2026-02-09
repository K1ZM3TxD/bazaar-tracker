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

function parseClassify(classifyRaw: string | null): boolean {
  return (classifyRaw ?? "").trim() === "1";
}

function inferExtAndContentTypeFromPath(storage_path: string): { ext: string; contentType: string } {
  const lower = storage_path.toLowerCase();
  const ext = lower.split(".").pop() || "png";
  const contentType =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "webp"
        ? "image/webp"
        : ext === "gif"
          ? "image/gif"
          : "image/png";
  return { ext, contentType };
}

async function readJsonOrUrlEncoded(req: Request): Promise<{ screenshot_sha256?: string; storage_path?: string }> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();

  if (ct.includes("application/json")) {
    const body: any = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return {};
    return {
      screenshot_sha256: typeof body.screenshot_sha256 === "string" ? body.screenshot_sha256 : undefined,
      storage_path: typeof body.storage_path === "string" ? body.storage_path : undefined,
    };
  }

  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    return {
      screenshot_sha256: params.get("screenshot_sha256") ?? undefined,
      storage_path: params.get("storage_path") ?? undefined,
    };
  }

  return {};
}

async function runClassification(bytes: Buffer, ext: string, contentType: string, mode?: string | null) {
  // Call the local route handler directly with a Request (optionally with ?mode=)
  const url = new URL("http://local/api/vision/items/classify");
  if (mode) url.searchParams.set("mode", mode);

  const fd = new FormData();
  fd.set("image", new File([new Uint8Array(bytes)], `upload.${ext}`, { type: contentType }));

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
    const classify = parseClassify(searchParams.get("classify"));

    // Input handling:
    // - Primary path: multipart with "file"
    // - Classify-only path: JSON or x-www-form-urlencoded with { screenshot_sha256, storage_path } and classify=1
    let file: File | null = null;
    let bytes: Buffer | null = null;
    let ext = "png";
    let contentType = "image/png";
    let screenshot_sha256: string | null = null;
    let storage_path: string | null = null;

    const reqContentType = (req.headers.get("content-type") || "").toLowerCase();

    if (reqContentType.includes("multipart/form-data")) {
      const form = await req.formData();
      file = form.get("file") as File | null;
      if (!file) {
        return jsonError("Missing file", 400);
      }

      bytes = Buffer.from(await file.arrayBuffer());
      screenshot_sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      ext = (file.type && file.type.includes("/") ? file.type.split("/")[1] : "") || "png";
      contentType = file.type || "image/png";
      storage_path = `ingest/${screenshot_sha256}.${ext}`;
    } else {
      // Non-multipart. Only allowed for classification with pre-upload inputs.
      if (!classify) {
        // Preserve existing behavior when classify is absent: multipart/file is required.
        return jsonError("Missing file", 400);
      }

      const parsed = await readJsonOrUrlEncoded(req);
      screenshot_sha256 = (parsed.screenshot_sha256 ?? "").trim() || null;
      storage_path = (parsed.storage_path ?? "").trim() || null;

      if (!screenshot_sha256 || !storage_path) {
        return jsonError("Missing screenshot_sha256 or storage_path", 400);
      }
      if (!isHex64(screenshot_sha256)) {
        return jsonError("Invalid screenshot_sha256", 400);
      }

      const inferred = inferExtAndContentTypeFromPath(storage_path);
      ext = inferred.ext;
      contentType = inferred.contentType;

      // Download bytes from storage (upload already happened elsewhere)
      const { data: dl, error: dlErr } = await supabase.storage.from("victory_screenshots").download(storage_path);
      if (dlErr || !dl) {
        return jsonError("Failed to download screenshot from storage", 500, {
          where: "victory_screenshots.download",
          message: dlErr?.message ?? null,
          storage_path,
        });
      }
      const ab = await dl.arrayBuffer();
      bytes = Buffer.from(ab);

      // Safety check: sha must match the downloaded bytes
      const downloadedSha = crypto.createHash("sha256").update(bytes).digest("hex");
      if (downloadedSha !== screenshot_sha256) {
        return jsonError("Downloaded bytes sha256 mismatch", 422, {
          where: "victory_screenshots.download.sha_mismatch",
          expected: screenshot_sha256,
          got: downloadedSha,
          storage_path,
        });
      }
    }

    if (!bytes || !screenshot_sha256 || !storage_path) {
      return jsonError("Invalid request", 400);
    }

    // Deduplicate early (canonical row is victory_submissions by screenshot_sha256)
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
      // Dedupe behavior:
      // - mode (debug): recompute + persist (observable; existing behavior)
      // - classify=1:
      //     - If existing classification_result is non-null: do not overwrite
      //     - If null: compute real classification (no mode) and persist
      // - Else: do not recompute
      if (mode) {
        const classified = await runClassification(bytes, ext, contentType, mode);
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
          classification: classification_result,
        });
      }

      if (classify) {
        if (existing.classification_result !== null && existing.classification_result !== undefined) {
          // Hard constraint: do not overwrite persisted classification_result
          return NextResponse.json({
            ok: true,
            deduped: true,
            submissionId: existing.id,
            wins: existing.wins,
            screenshot_sha256: existing.screenshot_sha256,
            classificationRecomputed: false,
            classification: existing.classification_result,
          });
        }

        const classified = await runClassification(bytes, ext, contentType, null);
        if (!classified.ok) {
          return jsonError("Item classify returned error", 500, {
            where: "vision.items.classify",
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
          classification: classification_result,
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

    // If we reach here, there is no canonical victory_submissions row yet.
    // Preserve existing behavior: analyze creates the row only for multipart/file uploads.
    if (!file) {
      return jsonError("No existing submission for screenshot_sha256", 404, {
        screenshot_sha256,
        storage_path,
      });
    }

    // Upload screenshot (for multipart path)
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

    // Item slot crops (best effort) — observability only
    let itemCrops: ItemsExtractResponse | null = null;
    try {
      itemCrops = await extractItemCropsFromBytes(bytes);
    } catch {
      itemCrops = null;
    }

    // Classification persistence:
    // - mode (skeleton) remains explicit debug override
    // - classify=1 triggers REAL classification (no mode), persisted into victory_submissions.classification_result
    // - default unchanged: no classification work, no new DB writes
    let classification_result: any = null;
    let classificationRecomputed = false;

    if (mode) {
      const classified = await runClassification(bytes, ext, contentType, mode);
      if (!classified.ok) {
        return jsonError("Item classify (mode) returned error", 500, {
          where: "vision.items.classify",
          mode,
          body: classified.body ?? null,
        });
      }
      classification_result = classified.classification ?? null;
      classificationRecomputed = true;
    } else if (classify) {
      const classified = await runClassification(bytes, ext, contentType, null);
      if (!classified.ok) {
        return jsonError("Item classify returned error", 500, {
          where: "vision.items.classify",
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
      ...(classificationRecomputed ? { classification: classification_result ?? null } : {}),
      itemCrops: itemCrops ?? null,
    });
  } catch (e: any) {
    return jsonError("Unhandled error", 500, {
      message: e?.message,
      stack: e?.stack,
    });
  }
}