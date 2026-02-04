import json

SUPABASE_PROJECT_URL = "https://aaydgphlzxzifepyugxo.supabase.co"
BUCKET = "bazaar-assets"

FILES = [
    ("items_only.json", "items"),
    ("skills_only.json", "skills"),
]

def process(file, folder):
    with open(file, "r", encoding="utf-8") as f:
        data = json.load(f)

    for e in data["items"]:
        filename = e["image_file"].split("/")[-1]
        e["public_image_url"] = (
            f"{SUPABASE_PROJECT_URL}/storage/v1/object/public/"
            f"{BUCKET}/{folder}/{filename}"
        )

    out = file.replace(".json", "_supabase.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"Created {out}")

for f, folder in FILES:
    process(f, folder)
