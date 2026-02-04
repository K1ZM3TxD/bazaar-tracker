import vision from "@google-cloud/vision";

async function test() {
  const client = new vision.ImageAnnotatorClient();

  const [result] = await client.textDetection("test-images/sample.png");

  const text = (result.textAnnotations?.[0]?.description || "").trim();

  // grab first standalone number 0–10
  const m = text.match(/\b(10|[0-9])\b/);
  const wins = m ? Number(m[1]) : null;

  console.log({ wins, rawText: text });
}

test().catch(console.error);
