import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";

export const runtime = "nodejs"; // required (Google SDK uses Node APIs)

// --- Banner classification (v1) ----------------------------------------------

// 8x8 average-hash (aHash) over a cropped banner region.
// We map known banner hashes to wins. This avoids OCR grabbing stray "10"s from item cards.

const KNOWN_BANNER_HASH_TO_WINS: Record<string, number> = {
  // Populate by uploading one screenshot per wins value and copying the computed bannerHash here.
  "f0f8f8f8f8f0f0f0": 10,
  "f0f0f0e0e0c0d0d0": 6,
  "f0f0b8f8f8f0f0f0": 10,
};

function hexToBits(hex: string): number[] {
  const bits: number[] = [];
  for (const ch of hex) {
    const v = parseInt(ch, 16);
    bits.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
  }
  return bits;
}

function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return 9999;
  const ab = hexToBits(a);
  const bb = hexToBits(b);
  let d = 0;
  for (let i = 0; i < ab.length; i++) if (ab[i] !== bb[i]) d++;
  return d;
}

async function computeBannerHash(bytes: Buffer): Promise<string> {
  const img = sharp(bytes);
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error("Unable to read image dimensions");

  // Crop: top banner region (tuned for Bazaar victory screenshots)
  const top = 0;
  const height = Math.max(1, Math.round(h * 0.22));

  const { data } = await img
    .extract({ left: 0, top, width: w, height })
    .resize(8, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // data is 64 bytes (8x8 grayscale)
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const avg = sum / data.length;

  // Build 64-bit bitstring
  let bits = "";
  for (let i = 0; i < data.length; i++) bits += data[i] >= avg ? "1" : "0";

  // Convert bits to hex (16 chars)
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    const nib = bits.slice(i, i + 4);
    hex += parseInt(nib, 2).toString(16);
  }
  return hex;
}

function classifyWinsFromHash(hash: string): { wins: number | null; bestDist: number } {
  let best: { wins: number; dist: number } | null = null;

  for (const [h, w] of Object.entries(KNOWN_BANNER_HASH_TO_WINS)) {
    const dist = hammingHex(hash, h);
    if (!best || dist < best.dist) best = { wins: w, dist };
  }

  // Confidence gate: require a close match
  if (!best) return { wins: null, bestDist: 9999 };
  if (best.dist > 6) return { wins: null, bestDist: best.dist };
  return { wins: best.wins, bestDist: best.dist };
}

// -----------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("image");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing form field 'image'" }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    // Banner classification path
    const bannerHash = await computeBannerHash(bytes);
    const classified = classifyWinsFromHash(bannerHash);

    // If classification did not match, do NOT guess; keep null and let UI manual wins stand.
    const wins = classified.wins;

    // TEMP DEBUG: allow retrieving bannerHash for mapping
    const debugParam = req.nextUrl.searchParams.get("debug");
    const formDebug = form.get("debug");
    const headerDebug = req.headers.get("x-debug");

    // Diagnostic mode to see what the server is receiving
    if (debugParam === "diag") {
      return NextResponse.json({
        wins,
        bannerHash,
        bannerBestDist: classified.bestDist,
        diag: {
          debugParam,
          formDebug,
          headerDebug,
        },
      });
    }

    const debug =
      formDebug === "1" ||
      formDebug === "true" ||
      headerDebug === "1" ||
      headerDebug === "true" ||
      debugParam === "1" ||
      debugParam === "true";

    if (debug) {
      return NextResponse.json({
        wins,
        bannerHash,
        bannerBestDist: classified.bestDist,
      });
    }

    return NextResponse.json({ wins });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Vision extract failed" },
      { status: 500 }
    );
  }
}
