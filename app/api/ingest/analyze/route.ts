import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { extractWinsFromBytes } from "../../vision/extract/route";
import {
  extractItemCropsFromBytes,
  type VisionItemsExtractResponse as ItemsExtractResponse,
} from "../../vision/items/extract/route";

type BazaarClass = {
  id: string | number;
  name: string | null;
};

function jsonError(message: string, status = 500, extra?: any) {
  return NextResponse.json(
    { ok: false, error: message, ...(extra ? { extra } : {}) },
    { status }
  );
}

function isHex64(s: string) {
  return /^[0-9a-f]{64}$/i.test(s);
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

    // Deduplicate early
    const { data: existing } = await supabase
      .from("victory_submissions")
      .select("id, wins, screenshot_sha256")
      .eq("screenshot_sha256", screenshot_sha256)
      .maybeSingle();

    if (existing?.id) {
      return NextResponse.json({
        ok: true,
        deduped: true,
        submissionId: existing.id,
        wins: existing.wins,
        screenshot_sha256: existing.screenshot_sha256,
      });
    }

    // Upload screenshot
    const ext =
      (file.type && file.type.includes("/") ? file.type.split("/")[1] : "") || "png";
    const storage_path = `ingest/${screenshot_sha256}.${ext}`;

    await supabase.storage.from("victory_screenshots").upload(storage_path, bytes, {
      contentType: file.type || "image/png",
      upsert: true,
    });

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

    // Determine class (fallback)
    const { data: classes } = await supabase
      .from("bazaar_classes")
      .select("id, name")
      .order("created_at", { ascending: true });

    const defaultClass: BazaarClass =
      classes?.find((c: any) => (c?.name || "").toLowerCase() === "unknown") ??
      classes?.[0];

    if (!defaultClass?.id) {
      return jsonError("Missing bazaar class", 500);
    }

    const screenshotId = crypto.randomUUID();

    await supabase.from("victory_screenshots").insert({
      id: screenshotId,
      storage_path,
    });

    const submissionPayload = {
      screenshot_id: screenshotId,
      screenshot_sha256,
      class: defaultClass.id,
      wins,
    };

    const { data: created, error: subErr } = await supabase
      .from("victory_submissions")
      .insert(submissionPayload)
      .select("id")
      .single();

    if (subErr || !created?.id) {
      const rawErr: any = subErr as any;
      const combined = `${rawErr?.message ?? ""} ${rawErr?.details ?? ""}`;
      const parsedConstraint =
        rawErr?.constraint ?? combined.match(/constraint "([^"]+)"/i)?.[1] ?? null;

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