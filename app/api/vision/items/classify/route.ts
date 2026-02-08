import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { createClientServer } from "@/utils/supabase/server";

export const runtime = "nodejs";

// Item Classification — v1 (IN PROGRESS)
//
// Computes aHash64 + dHash64 + pHash64 for 10 scan slots in the item row and (optionally)
// matches against bazaar_items.
//
// Output (matching disabled):
//   { imageSize, slots, adjacentDistances, groups, matchingEnabled:false }
// Output (matching enabled):
//   { imageSize, slots, adjacentDistances, groups, matchingEnabled:true, itemCount, hashedItemCount }
//
// Enable matching with: ITEM_CLASSIFY_MATCHING=1

// -----------------------------------------------------------------------------
// Classification Contract (v1) — Skeleton + Slot-level ambiguity semantics
// -----------------------------------------------------------------------------
//
// Ambiguity is expressed at the candidate level.
// Multiple candidates for the same slot_index imply slot-level ambiguity.
//
// Global status rules (deterministic) — item candidates:
// - disabled   → classification intentionally skipped
// - no_matches → zero item candidates across all slots
// - matches    → every slot has ≤ 1 item candidate AND at least one item candidate exists
// - ambiguous  → any slot has > 1 item candidate
//
// Deterministic skeleton triggers (query param):
// - ?mode=disabled         → status "disabled", empty candidates
// - ?mode=no_matches       → status "no_matches", empty candidates
// - ?mode=ambiguous        → slot 0 has TWO item candidates (same slot_index, different id), confidence=0.5
//                            other slots have zero candidates, global status "ambiguous"
// - ?mode=class_candidates → returns exactly ONE class candidate (and NO item candidates)
//                            { kind:"class", id:"unknown_class", label:"Unknown Class", confidence:0.5, source:"skeleton" }
//                            status "matches" iff exactly one class candidate
//
// IMPORTANT: When ?mode is provided, we do NOT call Supabase or do any matching work.

type CropBox = { left: number; top: number; width: number; height: number };

type Candidate = {
  itemId: number;
  name: string;
  score: number; // higher is better
};

type SlotFeature = {
  index: number;
  box: CropBox;
  aHash64: string; // 16-hex chars (64 bits)
  dHash64: string; // 16-hex chars (64 bits)
  pHash64: string; // 16-hex chars (64 bits)
  autoDetected: boolean;
  candidates: Candidate[];
};

type SlotGroup = {
  startSlot: number;
  span: 1 | 2 | 3 | 4;
  aHash64: string; // representative (merged group crop)
  dHash64: string; // representative (merged group crop)
  pHash64: string; // representative (merged group crop)
  autoDetected: boolean;
  candidates: Candidate[];

  // Debug-friendly confidence fields (remove when v1 is locked)
  bestScore?: number;
  secondScore?: number;
  bestMargin?: number;
  ambiguous?: boolean;
};

// Contract types
type ClassificationCandidate = {
  kind: "item" | "class";
  id: string;
  label: string;
  confidence: number;
  source: string;
  slot_index: number;
  meta: Record<string, any>;
};

type ClassificationEvidenceSignal = {
  source: string;
  type: string;
  value: string;
  weight: number; // 0..1
  meta: Record<string, any>;
};

type ClassificationContractV1 = {
  version: 1;
  status: "disabled" | "no_matches" | "matches" | "ambiguous";
  candidates: {
    items: ClassificationCandidate[];
    class: ClassificationCandidate[];
  };
  evidence: {
    signals: ClassificationEvidenceSignal[];
    notes: string[];
  };
};

type CachedHash = { aHash64: string; dHash64: string; pHash64: string; expiresAt: number };

// Simple in-memory cache (node runtime). Clears on deploy/restart.
const ITEM_HASH_CACHE_TTL_MS = 10 * 60 * 1000;
const itemHashCache = new Map<string, CachedHash>();

// Score scale is 0..64 (64 = identical). With triple-hash scoring we still return a 0..64 score.
const MIN_SCORE_CANDIDATE = 38; // include candidates at/above this score
const MIN_SCORE_AUTODETECT = 46; // autoDetected requires this stricter score
const MIN_AUTODETECT_MARGIN = 3; // bestScore must beat 2nd by this margin to avoid dominant false-positives

const GROUP_MERGE_MAX_ADJ_DIST = 20; // <=20 treated as same physical item region (allows medium/large merge)

// Dominant false-positive suppression:
const DOMINANT_BEST_COUNT = 2;
const DOMINANT_MARGIN_BONUS = 2; // requires margin >= MIN_AUTODETECT_MARGIN + bonus

function signalSortKey(s: ClassificationEvidenceSignal): string {
  const slot = s?.meta?.slot_index;
  const slotKey = typeof slot === "number" ? String(slot).padStart(4, "0") : "zzzz";
  const valueKey = s.value ?? "";
  return `${s.source}|${s.type}|${slotKey}|${valueKey}`;
}

function sortSignalsStable(signals: ClassificationEvidenceSignal[]): ClassificationEvidenceSignal[] {
  // Deterministic ordering rule:
  // stable sort by source,type,meta.slot_index (if present), value
  return [...signals].sort((a, b) => {
    const ka = signalSortKey(a);
    const kb = signalSortKey(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

function buildContract(
  status: ClassificationContractV1["status"],
  items: ClassificationCandidate[],
  classes: ClassificationCandidate[],
  signals: ClassificationEvidenceSignal[]
): ClassificationContractV1 {
  return {
    version: 1,
    status,
    candidates: { items, class: classes },
    evidence: {
      signals: sortSignalsStable(signals),
      notes: [],
    },
  };
}

function modeSignal(modeValue: string): ClassificationEvidenceSignal {
  return {
    source: "skeleton",
    type: "mode",
    value: modeValue,
    weight: 1,
    meta: {},
  };
}

function gateSignal(value: string, meta: Record<string, any> = {}): ClassificationEvidenceSignal {
  return {
    source: "skeleton",
    type: "gate",
    value,
    weight: 1,
    meta,
  };
}

function candidateSignal(value: string, meta: Record<string, any> = {}): ClassificationEvidenceSignal {
  return {
    source: "skeleton",
    type: "candidate",
    value,
    weight: 1,
    meta,
  };
}

function deriveStatusFromCandidates(
  items: ClassificationCandidate[],
  isDisabled: boolean
): ClassificationContractV1["status"] {
  if (isDisabled) return "disabled";
  if (items.length === 0) return "no_matches";

  const bySlot = new Map<number, number>();
  for (const c of items) {
    bySlot.set(c.slot_index, (bySlot.get(c.slot_index) ?? 0) + 1);
  }
  for (const [, count] of bySlot) {
    if (count > 1) return "ambiguous";
  }
  return "matches";
}

function candidatesFromGroups(groups: SlotGroup[]): ClassificationCandidate[] {
  const out: ClassificationCandidate[] = [];
  for (const g of groups) {
    for (const c of g.candidates ?? []) {
      out.push({
        kind: "item",
        id: String(c.itemId),
        label: c.name,
        // Contract-only: no confidence heuristics. Preserve score in meta.
        confidence: 0.0,
        source: "hash_match",
        slot_index: g.startSlot,
        meta: {
          score: c.score,
          group_span: g.span,
        },
      });
    }
  }
  return out;
}

async function getImageSize(bytes: Buffer): Promise<{ w: number; h: number }> {
  const meta = await sharp(bytes).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error("Unable to read image dimensions");
  return { w, h };
}

function clampBox(box: CropBox, w: number, h: number): CropBox {
  const left = Math.max(0, Math.min(w - 1, Math.round(box.left)));
  const top = Math.max(0, Math.min(h - 1, Math.round(box.top)));
  const width = Math.max(1, Math.min(w - left, Math.round(box.width)));
  const height = Math.max(1, Math.min(h - top, Math.round(box.height)));
  return { left, top, width, height };
}

async function estimateItemRowCenterY(bytes: Buffer, w: number, h: number): Promise<number> {
  const smallW = 256;
  const smallH = Math.min(2000, Math.max(256, Math.round((h * smallW) / w)));

  const buf = await sharp(bytes)
    .resize(smallW, smallH, { fit: "inside" })
    .grayscale()
    .raw()
    .toBuffer();

  const sw = smallW;
  const sh = Math.round(buf.length / sw);
  if (sh <= 2) return Math.round(h * 0.28);

  const x0 = Math.max(0, Math.min(sw - 2, Math.round(sw * 0.29)));
  const x1 = Math.max(x0 + 1, Math.min(sw - 1, Math.round(sw * 0.97)));

  let bestY = 0;
  let bestScore = -1;

  const yStart = Math.max(1, Math.round(sh * 0.05));
  const yEnd = Math.min(sh - 2, Math.round(sh * 0.95));

  for (let y = yStart; y <= yEnd; y++) {
    const row = y * sw;
    let s = 0;
    for (let x = x0 + 1; x <= x1; x++) {
      const a = buf[row + x - 1];
      const b = buf[row + x];
      s += Math.abs(b - a);
    }

    const yBias = 1 + (1 - y / sh) * 0.15;
    const score = s * yBias;

    if (score > bestScore) {
      bestScore = score;
      bestY = y;
    }
  }

  const scale = h / sh;
  return Math.max(0, Math.min(h - 1, Math.round(bestY * scale)));
}

async function buildItemIconBoxes(bytes: Buffer, w: number, h: number): Promise<CropBox[]> {
  const ICON_BAND_HEIGHT = 160;

  const centerY = await estimateItemRowCenterY(bytes, w, h);
  const bandTop = Math.max(0, Math.min(h - ICON_BAND_HEIGHT, centerY - Math.round(ICON_BAND_HEIGHT * 0.55)));
  const bandHeight = ICON_BAND_HEIGHT;

  const bandLeft = w * 0.29;
  const bandWidth = w * 0.68;

  const slots = 10;
  const slotW = bandWidth / slots;

  const insetX = slotW * 0.01;
  const insetY = bandHeight * 0.08;

  const iconW = slotW * 0.98;
  const iconH = bandHeight * 0.96;

  const boxes: CropBox[] = [];
  for (let i = 0; i < slots; i++) {
    const left = bandLeft + i * slotW + insetX;
    const top = bandTop + insetY;
    boxes.push(clampBox({ left, top, width: iconW, height: iconH }, w, h));
  }

  return boxes;
}

function mergeSlotBoxes(boxes: CropBox[], startSlot: number, span: 1 | 2 | 3 | 4): CropBox {
  const first = boxes[startSlot];
  const last = boxes[startSlot + span - 1];

  const left = first.left;
  const top = first.top;
  const height = Math.max(first.height, last.height);
  const right = last.left + last.width;

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height,
  };
}

function computeAHash64From8x8Gray(pixels: Uint8Array): string {
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += pixels[i];
  const avg = sum / 64;

  let bits = "";
  for (let i = 0; i < 64; i++) bits += pixels[i] >= avg ? "1" : "0";

  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    const nibble = bits.slice(i, i + 4);
    hex += parseInt(nibble, 2).toString(16);
  }
  return hex;
}

function computeDHash64From9x8Gray(pixels: Uint8Array): string {
  let bits = "";
  for (let y = 0; y < 8; y++) {
    const row = y * 9;
    for (let x = 0; x < 8; x++) {
      const left = pixels[row + x];
      const right = pixels[row + x + 1];
      bits += left > right ? "1" : "0";
    }
  }

  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    const nibble = bits.slice(i, i + 4);
    hex += parseInt(nibble, 2).toString(16);
  }
  return hex;
}

function computePHash64From32x32Gray(pixels: Uint8Array): string {
  let sum = 0;
  for (let i = 0; i < 32 * 32; i++) sum += pixels[i];
  const avg = sum / (32 * 32);

  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const v = pixels[y * 32 + x];
      bits += v >= avg ? "1" : "0";
    }
  }

  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    const nibble = bits.slice(i, i + 4);
    hex += parseInt(nibble, 2).toString(16);
  }
  return hex;
}

async function cropToAHash64(bytes: Buffer, box: CropBox): Promise<string> {
  const buf = await sharp(bytes)
    .extract(box)
    .resize(8, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();

  return computeAHash64From8x8Gray(new Uint8Array(buf));
}

async function cropToDHash64(bytes: Buffer, box: CropBox): Promise<string> {
  const buf = await sharp(bytes)
    .extract(box)
    .resize(9, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();

  return computeDHash64From9x8Gray(new Uint8Array(buf));
}

async function cropToPHash64(bytes: Buffer, box: CropBox): Promise<string> {
  const buf = await sharp(bytes)
    .extract(box)
    .resize(32, 32, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();

  return computePHash64From32x32Gray(new Uint8Array(buf));
}

function hammingDistanceHex64(a16: string, b16: string): number {
  if (a16.length !== 16 || b16.length !== 16) return 64;
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    const an = parseInt(a16[i], 16);
    const bn = parseInt(b16[i], 16);
    const x = an ^ bn;
    dist += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return dist;
}

function scoreTripleHash(
  aHashA: string,
  dHashA: string,
  pHashA: string,
  aHashB: string,
  dHashB: string,
  pHashB: string
): number {
  const da = hammingDistanceHex64(aHashA, aHashB);
  const dd = hammingDistanceHex64(dHashA, dHashB);
  const dp = hammingDistanceHex64(pHashA, pHashB);

  const weighted = da + dd + dp * 2;
  const denom = 4;
  return 64 - Math.round(weighted / denom);
}

function computeAdjacentDistances(slots: SlotFeature[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < slots.length - 1; i++) {
    out.push(hammingDistanceHex64(slots[i].aHash64, slots[i + 1].aHash64));
  }
  return out;
}

async function cropToPngDataUrl(bytes: Buffer, box: CropBox): Promise<string> {
  const buf = await sharp(bytes)
    .extract(box)
    .resize(96, 96, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return `data:image/png;base64,${buf.toString("base64")}`;
}

function buildGroups(slots: SlotFeature[]): SlotGroup[] {
  const groups: SlotGroup[] = [];

  for (let i = 0; i < slots.length; ) {
    let span: 1 | 2 | 3 | 4 = 1;

    if (
      i + 1 < slots.length &&
      hammingDistanceHex64(slots[i].aHash64, slots[i + 1].aHash64) <= GROUP_MERGE_MAX_ADJ_DIST
    ) {
      span = 2;
    }

    if (
      span === 2 &&
      i + 2 < slots.length &&
      hammingDistanceHex64(slots[i + 1].aHash64, slots[i + 2].aHash64) <= GROUP_MERGE_MAX_ADJ_DIST
    ) {
      span = 3;
    }

    if (
      span === 3 &&
      i + 3 < slots.length &&
      hammingDistanceHex64(slots[i + 2].aHash64, slots[i + 3].aHash64) <= GROUP_MERGE_MAX_ADJ_DIST
    ) {
      span = 4;
    }

    groups.push({
      startSlot: i,
      span,
      aHash64: slots[i].aHash64,
      dHash64: slots[i].dHash64,
      pHash64: slots[i].pHash64,
      autoDetected: false,
      candidates: [],
    });

    i += span;
  }

  return groups;
}

async function fetchImageBytes(url: string, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "image/avif,image/*" },
    });
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } finally {
    clearTimeout(t);
  }
}

async function imageUrlToTripleHash(
  url: string,
  timeoutMs: number
): Promise<{ aHash64: string; dHash64: string; pHash64: string }> {
  const bytes = await fetchImageBytes(url, timeoutMs);

  const aBuf = await sharp(bytes)
    .resize(8, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
  const aHash64 = computeAHash64From8x8Gray(new Uint8Array(aBuf));

  const dBuf = await sharp(bytes)
    .resize(9, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
  const dHash64 = computeDHash64From9x8Gray(new Uint8Array(dBuf));

  const pBuf = await sharp(bytes)
    .resize(32, 32, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
  const pHash64 = computePHash64From32x32Gray(new Uint8Array(pBuf));

  return { aHash64, dHash64, pHash64 };
}

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const modeRaw = (searchParams.get("mode") ?? "").toLowerCase();
    const mode =
      modeRaw === "disabled" || modeRaw === "ambiguous" || modeRaw === "no_matches" || modeRaw === "class_candidates"
        ? modeRaw
        : null;

    const form = await req.formData();
    const file = form.get("image");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing form field 'image'" }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const { w, h } = await getImageSize(bytes);

    const boxes = await buildItemIconBoxes(bytes, w, h);

    const slots: SlotFeature[] = [];
    for (let i = 0; i < boxes.length; i++) {
      slots.push({
        index: i,
        box: boxes[i],
        aHash64: await cropToAHash64(bytes, boxes[i]),
        dHash64: await cropToDHash64(bytes, boxes[i]),
        pHash64: await cropToPHash64(bytes, boxes[i]),
        autoDetected: false,
        candidates: [],
      });
    }

    const adjacentDistances = computeAdjacentDistances(slots);

    const debugCropsEnabled = process.env.ITEM_CLASSIFY_DEBUG_CROPS === "1";
    const debugSlotCrops: string[] = [];
    const debugGroupCrops: string[] = [];

    if (debugCropsEnabled) {
      for (const b of boxes) {
        debugSlotCrops.push(await cropToPngDataUrl(bytes, b));
      }
    }

    let groups = buildGroups(slots);

    // Replace representative hash with merged group crop hash (more stable for medium/large items)
    for (const g of groups) {
      const mergedBox = mergeSlotBoxes(boxes, g.startSlot, g.span);
      g.aHash64 = await cropToAHash64(bytes, mergedBox);
      g.dHash64 = await cropToDHash64(bytes, mergedBox);
      g.pHash64 = await cropToPHash64(bytes, mergedBox);

      if (debugCropsEnabled) {
        debugGroupCrops.push(await cropToPngDataUrl(bytes, mergedBox));
      }
    }

    // Skeleton override: deterministic evidence.signals semantics + ordering
    if (mode) {
      if (mode === "disabled") {
        const classification = buildContract("disabled", [], [], [modeSignal("disabled")]);

        return NextResponse.json({
          imageSize: { w, h },
          slots,
          adjacentDistances,
          groups,
          groupMergeMaxAdjDist: GROUP_MERGE_MAX_ADJ_DIST,
          matchingEnv: process.env.ITEM_CLASSIFY_MATCHING ?? null,
          matchingEnabled: false,
          classification,
          ...(debugCropsEnabled ? { debugCrops: { slotPngs: debugSlotCrops, groupPngs: debugGroupCrops } } : {}),
        });
      }

      if (mode === "no_matches") {
        const classification = buildContract("no_matches", [], [], [modeSignal("no_matches"), gateSignal("no_candidates")]);

        return NextResponse.json({
          imageSize: { w, h },
          slots,
          adjacentDistances,
          groups,
          groupMergeMaxAdjDist: GROUP_MERGE_MAX_ADJ_DIST,
          matchingEnv: process.env.ITEM_CLASSIFY_MATCHING ?? null,
          matchingEnabled: false,
          classification,
          ...(debugCropsEnabled ? { debugCrops: { slotPngs: debugSlotCrops, groupPngs: debugGroupCrops } } : {}),
        });
      }

      if (mode === "class_candidates") {
        const classCandidates: ClassificationCandidate[] = [
          {
            kind: "class",
            id: "unknown_class",
            label: "Unknown Class",
            confidence: 0.5,
            source: "skeleton",
            slot_index: 0,
            meta: {},
          },
        ];

        const status: ClassificationContractV1["status"] = classCandidates.length === 1 ? "matches" : "ambiguous";

        const classification = buildContract(status, [], classCandidates, [
          modeSignal("class_candidates"),
          candidateSignal("class_candidate", { slot_index: 0, id: "unknown_class", label: "Unknown Class" }),
        ]);

        return NextResponse.json({
          imageSize: { w, h },
          slots,
          adjacentDistances,
          groups,
          groupMergeMaxAdjDist: GROUP_MERGE_MAX_ADJ_DIST,
          matchingEnv: process.env.ITEM_CLASSIFY_MATCHING ?? null,
          matchingEnabled: false,
          classification,
          ...(debugCropsEnabled ? { debugCrops: { slotPngs: debugSlotCrops, groupPngs: debugGroupCrops } } : {}),
        });
      }

      // ambiguous
      const items: ClassificationCandidate[] = [
        {
          kind: "item",
          id: "unknown_item_a",
          label: "Unknown Item",
          confidence: 0.5,
          source: "skeleton",
          slot_index: 0,
          meta: {},
        },
        {
          kind: "item",
          id: "unknown_item_b",
          label: "Unknown Item",
          confidence: 0.5,
          source: "skeleton",
          slot_index: 0,
          meta: {},
        },
      ];

      const classification = buildContract("ambiguous", items, [], [
        modeSignal("ambiguous"),
        gateSignal("ambiguous_slot", { slot_index: 0 }),
      ]);

      return NextResponse.json({
        imageSize: { w, h },
        slots,
        adjacentDistances,
        groups,
        groupMergeMaxAdjDist: GROUP_MERGE_MAX_ADJ_DIST,
        matchingEnv: process.env.ITEM_CLASSIFY_MATCHING ?? null,
        matchingEnabled: false,
        classification,
        ...(debugCropsEnabled ? { debugCrops: { slotPngs: debugSlotCrops, groupPngs: debugGroupCrops } } : {}),
      });
    }

    const matchingEnabled = process.env.ITEM_CLASSIFY_MATCHING === "1";

    if (!matchingEnabled) {
      // keep deterministic ordering for signals even in env-disabled
      const classification = buildContract("disabled", [], [], [
        {
          source: "hash_match",
          type: "env",
          value: "ITEM_CLASSIFY_MATCHING!=1",
          weight: 1,
          meta: { matchingEnv: process.env.ITEM_CLASSIFY_MATCHING ?? null },
        },
      ]);

      return NextResponse.json({
        imageSize: { w, h },
        slots,
        adjacentDistances,
        groups,
        groupMergeMaxAdjDist: GROUP_MERGE_MAX_ADJ_DIST,
        matchingEnv: process.env.ITEM_CLASSIFY_MATCHING ?? null,
        matchingEnabled: false,
        classification,
        ...(debugCropsEnabled ? { debugCrops: { slotPngs: debugSlotCrops, groupPngs: debugGroupCrops } } : {}),
      });
    }

    const supabase = createClientServer();

    const MAX_ITEMS = 500;
    const { data: items, error } = await supabase
      .from("bazaar_items")
      .select("id,name,source_image_url")
      .neq("source_image_url", null)
      .limit(MAX_ITEMS);

    if (error) {
      return NextResponse.json({ error: `Supabase bazaar_items query failed: ${error.message}` }, { status: 500 });
    }

    const FETCH_TIMEOUT_MS = 8000;

    const MAX_HASHED = 300;
    const HASH_CONCURRENCY = 6;

    const itemHashes: { id: number; name: string; aHash64: string; dHash64: string; pHash64: string }[] = [];

    const candidates = (items ?? []).filter((it) => !!it?.source_image_url);

    async function hashOne(
      it: any
    ): Promise<{ id: number; name: string; aHash64: string; dHash64: string; pHash64: string } | null> {
      try {
        const now = Date.now();
        const cacheKey = it.source_image_url as string;
        const cached = itemHashCache.get(cacheKey);

        let aHash64: string;
        let dHash64: string;
        let pHash64: string;
        if (cached && cached.expiresAt > now) {
          aHash64 = cached.aHash64;
          dHash64 = cached.dHash64;
          pHash64 = cached.pHash64;
        } else {
          const h = await imageUrlToTripleHash(cacheKey, FETCH_TIMEOUT_MS);
          aHash64 = h.aHash64;
          dHash64 = h.dHash64;
          pHash64 = h.pHash64;
          itemHashCache.set(cacheKey, { aHash64, dHash64, pHash64, expiresAt: now + ITEM_HASH_CACHE_TTL_MS });
        }

        return { id: it.id, name: it.name, aHash64, dHash64, pHash64 };
      } catch {
        return null;
      }
    }

    for (let i = 0; i < candidates.length && itemHashes.length < MAX_HASHED; i += HASH_CONCURRENCY) {
      const batch = candidates.slice(i, i + HASH_CONCURRENCY);
      const results = await Promise.all(batch.map(hashOne));
      for (const r of results) {
        if (!r) continue;
        itemHashes.push(r);
        if (itemHashes.length >= MAX_HASHED) break;
      }
    }

    const TOP_N = 5;

    // Match per-group (merged crop) instead of per-slot to avoid medium/large duplication.
    for (const g of groups) {
      const scored: Candidate[] = [];
      for (const it of itemHashes) {
        const score = scoreTripleHash(g.aHash64, g.dHash64, g.pHash64, it.aHash64, it.dHash64, it.pHash64);
        scored.push({ itemId: it.id, name: it.name, score });
      }
      scored.sort((a, b) => b.score - a.score);

      const filtered = scored.filter((c) => c.score >= MIN_SCORE_CANDIDATE);
      g.candidates = filtered.slice(0, TOP_N);

      const best = g.candidates[0];
      const second = g.candidates[1];
      const margin = !best ? 0 : !second ? best.score : best.score - second.score;

      g.bestScore = best?.score;
      g.secondScore = second?.score;
      g.bestMargin = margin;
      g.ambiguous = !best || (!!second && margin < MIN_AUTODETECT_MARGIN);

      const marginOk = !second || margin >= MIN_AUTODETECT_MARGIN;
      g.autoDetected = !!best && best.score >= MIN_SCORE_AUTODETECT && marginOk;
    }

    // Suppress dominant best-item false-positives across this request.
    const requiredDominantMargin = MIN_AUTODETECT_MARGIN + DOMINANT_MARGIN_BONUS;

    const bestCountByItemId = new Map<number, number>();
    for (const g of groups) {
      const best = g.candidates[0];
      if (!best) continue;
      bestCountByItemId.set(best.itemId, (bestCountByItemId.get(best.itemId) ?? 0) + 1);
    }

    for (const g of groups) {
      const best = g.candidates[0];
      if (!best) continue;

      const bestCount = bestCountByItemId.get(best.itemId) ?? 0;
      if (bestCount < DOMINANT_BEST_COUNT) continue;

      const margin = g.bestMargin ?? 0;
      if (margin >= requiredDominantMargin) continue;

      g.candidates = g.candidates.filter((c) => c.itemId !== best.itemId);

      const newBest = g.candidates[0];
      const newSecond = g.candidates[1];
      const newMargin = !newBest ? 0 : !newSecond ? newBest.score : newBest.score - newSecond.score;

      g.bestScore = newBest?.score;
      g.secondScore = newSecond?.score;
      g.bestMargin = newMargin;
      g.ambiguous = !newBest || (!!newSecond && newMargin < MIN_AUTODETECT_MARGIN);

      const newMarginOk = !newSecond || newMargin >= MIN_AUTODETECT_MARGIN;
      g.autoDetected = !!newBest && newBest.score >= MIN_SCORE_AUTODETECT && newMarginOk;
    }

    const contractItems = candidatesFromGroups(groups);
    const derivedStatus = deriveStatusFromCandidates(contractItems, false);

    // Deterministic evidence ordering for non-skeleton path as well
    const classification = buildContract(derivedStatus, contractItems, [], [
      {
        source: "hash_match",
        type: "env",
        value: "ITEM_CLASSIFY_MATCHING=1",
        weight: 1,
        meta: { matchingEnv: process.env.ITEM_CLASSIFY_MATCHING ?? null },
      },
    ]);

    return NextResponse.json({
      imageSize: { w, h },
      slots,
      adjacentDistances,
      groups,
      groupMergeMaxAdjDist: GROUP_MERGE_MAX_ADJ_DIST,
      matchingEnv: process.env.ITEM_CLASSIFY_MATCHING ?? null,
      matchingEnabled: true,
      itemCount: items?.length ?? 0,
      hashedItemCount: itemHashes.length,
      classification,
      ...(debugCropsEnabled ? { debugCrops: { slotPngs: debugSlotCrops, groupPngs: debugGroupCrops } } : {}),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Item classify failed" }, { status: 500 });
  }
}