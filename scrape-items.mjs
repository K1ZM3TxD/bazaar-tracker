import fs from "node:fs/promises";

// These pages contain full item lists in the HTML (no “Load more” JS issues)
const HERO_PAGES = [
  { hero: "Vanessa", url: "https://mobalytics.gg/the-bazaar/vanessa-items" },
  { hero: "Pygmalien", url: "https://mobalytics.gg/the-bazaar/pygmalien-items" },
  { hero: "Dooley", url: "https://mobalytics.gg/the-bazaar/dooley-items" },
  { hero: "Mak", url: "https://mobalytics.gg/the-bazaar/mak-items" },
  { hero: "Stelle", url: "https://mobalytics.gg/the-bazaar/stelle-items" },
  { hero: "Jules", url: "https://mobalytics.gg/the-bazaar/jules-items" },
];

// Stuff we don’t want (site chrome images)
const IGNORE_NAMES = new Set([
  "Mobalytics",
  "News",
  "support",
  "menu",
]);

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function extractItemNamesFromHtml(html) {
  // Cut off the header/nav noise by starting at the guide title section
  const startIdx = html.indexOf("All ");
  const body = startIdx >= 0 ? html.slice(startIdx) : html;

  // Mobalytics pages include many occurrences like: "Image: Ambergris"
  // We'll capture those and treat them as candidate item names.
  const re = /Image:\s*([^<\n\r]+?)(?:\s*<\/|[\n\r])/g;
  const found = [];

  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1].trim();
    if (!name) continue;
    if (IGNORE_NAMES.has(name)) continue;
    if (name.length < 2) continue;

    // Extra guard: skip obvious UI words
    if (["Landing", "Profile", "Home"].includes(name)) continue;

    found.push(name);
  }

  // De-dupe while preserving order
  const seen = new Set();
  const unique = [];
  for (const n of found) {
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(n);
  }
  return unique;
}

async function main() {
  const rows = [];
  for (const { hero, url } of HERO_PAGES) {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
        "accept": "text/html",
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch ${url} -> ${res.status} ${res.statusText}`);
    }

    const html = await res.text();
    const names = extractItemNamesFromHtml(html);

    for (const name of names) {
      rows.push({
        name,
        hero,
        source_url: url,
      });
    }

    console.log(`${hero}: ${names.length} items`);
  }

  // Global de-dupe by (name + hero)
  const seen = new Set();
  const finalRows = [];
  for (const r of rows) {
    const key = `${r.hero}||${r.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    finalRows.push(r);
  }

  const header = ["name", "hero", "source_url"];
  const lines = [
    header.join(","),
    ...finalRows.map((r) =>
      [r.name, r.hero, r.source_url].map(csvEscape).join(",")
    ),
  ];

  await fs.writeFile("items.csv", lines.join("\n"), "utf8");

  console.log(`\nSaved ${finalRows.length} rows to items.csv`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
