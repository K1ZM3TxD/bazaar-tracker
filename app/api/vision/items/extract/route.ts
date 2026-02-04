import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";

export const runtime = "nodejs";

// Item Extraction — v0.3 (ACTIVE)
//
// Returns crops only (no OCR, no DB matching).
// Output: { imageSize, crops: [{ index, box, pngBase64 }] }

type CropBox = { left: number; top: number; width: number; height: number };

type CropOut = {
  index: number;
  box: CropBox;
  pngBase64: string;
};

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

function buildItemSlotBoxes(w: number, h: number): CropBox[] {
  // ✅ Bigger crop band (matches classify v3.20)

  const bannerHeight = h * 0.22;

  // Start slightly below banner
  const bandTop = bannerHeight + h * 0.01;

  // ✅ Taller band so crops are recognizable
  const bandHeight = h * 0.18;

  // ✅ Slightly wider horizontal alignment
  const bandLeft = w * 0.29;
  const bandWidth = w * 0.68;

  const slots = 10;
  const slotW = bandWidth / slots;

  // ✅ Minimal inset (grab full card)
  const insetX = slotW * 0.01;
  const insetY = bandHeight * 0.02;

  // ✅ Much larger crops
  const cropW = slotW * 0.98;
  const cropH = bandHeight * 0.96;

  const boxes: CropBox[] = [];
  for (let i = 0; i < slots; i++) {
    const left = bandLeft + i * slotW + insetX;
    const top = bandTop + insetY;
    boxes.push(clampBox({ left, top, width: cropW, height: cropH }, w, h));
  }

  return boxes;
}

async function cropToPngBase64(bytes: Buffer, box: CropBox): Promise<string> {
  const png = await sharp(bytes).extract(box).png().toBuffer();
  return png.toString("base64");
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("image");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing form field 'image'" },
        { status: 400 }
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const { w, h } = await getImageSize(bytes);

    const boxes = buildItemSlotBoxes(w, h);

    const crops: CropOut[] = [];
    for (let i = 0; i < boxes.length; i++) {
      crops.push({
        index: i,
        box: boxes[i],
        pngBase64: await cropToPngBase64(bytes, boxes[i]),
      });
    }

    return NextResponse.json({ imageSize: { w, h }, crops });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Item extract failed" },
      { status: 500 }
    );
  }
}
