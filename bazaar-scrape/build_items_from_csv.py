import csv
import os
import json
import time
import re
import urllib.request
from urllib.parse import urlparse

CSV_PATH = "howbazaar.csv"
IMG_DIR = "images"
OUT_JSON = "items.json"

os.makedirs(IMG_DIR, exist_ok=True)

def safe_filename(name):
    name = name.strip()
    name = re.sub(r"[^\w\s\-\(\)']", "", name)
    name = re.sub(r"\s+", " ", name)
    return name.replace(" ", "_")

items = []
seen = set()

with open(CSV_PATH, newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)

    for row in reader:
        name = (row.get("font-bold") or "").strip()
        img_url = (row.get("absolute src") or "").strip()

        if not name or not img_url:
            continue

        if name in seen:
            continue
        seen.add(name)

        filename = safe_filename(name)
        ext = os.path.splitext(urlparse(img_url).path)[1] or ".img"
        image_path = os.path.join(IMG_DIR, filename + ext)

        if not os.path.exists(image_path):
            try:
                print(f"Downloading: {name}")
                req = urllib.request.Request(
                    img_url,
                    headers={"User-Agent": "Mozilla/5.0"}
                )
                with urllib.request.urlopen(req, timeout=30) as r, open(image_path, "wb") as out:
                    out.write(r.read())
                time.sleep(0.1)
            except Exception as e:
                print(f"  FAILED {name}: {e}")
                continue

        items.append({
            "name": name,
            "image_file": f"{IMG_DIR}/{filename}{ext}",
            "source_image_url": img_url
        })

with open(OUT_JSON, "w", encoding="utf-8") as f:
    json.dump(
        {
            "count": len(items),
            "items": items
        },
        f,
        indent=2,
        ensure_ascii=False
    )

print(f"\nDone.")
print(f"- Items: {len(items)}")
print(f"- Images folder: {IMG_DIR}")
print(f"- Manifest: {OUT_JSON}")
