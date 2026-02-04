import os, json, shutil

SRC_IMAGES = "images"
OUT_ITEMS = os.path.join("upload", "items")
OUT_SKILLS = os.path.join("upload", "skills")

os.makedirs(OUT_ITEMS, exist_ok=True)
os.makedirs(OUT_SKILLS, exist_ok=True)

def copy_from_manifest(manifest_path, out_dir):
    data = json.load(open(manifest_path, "r", encoding="utf-8"))
    n = 0
    missing = 0
    for e in data.get("items", []):
        filename = e["image_file"].split("/")[-1]  # images/<file>
        src = os.path.join(SRC_IMAGES, filename)
        dst = os.path.join(out_dir, filename)
        if os.path.exists(src):
            if not os.path.exists(dst):
                shutil.copy2(src, dst)
            n += 1
        else:
            missing += 1
    return n, missing

ni, mi = copy_from_manifest("items_only.json", OUT_ITEMS)
ns, ms = copy_from_manifest("skills_only.json", OUT_SKILLS)

print("Done.")
print(f"upload/items files:  {ni} (missing {mi})")
print(f"upload/skills files: {ns} (missing {ms})")
print("Folder created: upload\\items and upload\\skills")
