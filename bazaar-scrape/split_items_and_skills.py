import json
import re
from urllib.parse import urlparse

IN_JSON = "items.json"
OUT_ITEMS = "items_only.json"
OUT_SKILLS = "skills_only.json"
OUT_OTHER = "other_only.json"

def classify(entry):
    """
    Classify using the source_image_url path.
    Common CDN paths tend to include folders like:
      /images/items/
      /images/skills/
    If not found, fall back to 'other'.
    """
    url = entry.get("source_image_url") or ""
    path = urlparse(url).path.lower()

    if "/images/items/" in path:
        return "items"
    if "/images/skills/" in path:
        return "skills"

    # Sometimes sites use different buckets; try heuristics:
    # if name looks like a skill (often verbs/phrases) this is weak, so keep as other.
    return "other"

with open(IN_JSON, "r", encoding="utf-8") as f:
    data = json.load(f)

items = []
skills = []
other = []

for e in data.get("items", []):
    bucket = classify(e)
    if bucket == "items":
        items.append(e)
    elif bucket == "skills":
        skills.append(e)
    else:
        other.append(e)

def write(path, arr):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"count": len(arr), "items": arr}, f, indent=2, ensure_ascii=False)

write(OUT_ITEMS, items)
write(OUT_SKILLS, skills)
write(OUT_OTHER, other)

print("Done splitting:")
print(f"- items:  {len(items)} -> {OUT_ITEMS}")
print(f"- skills: {len(skills)} -> {OUT_SKILLS}")
print(f"- other:  {len(other)} -> {OUT_OTHER}")
print("\nIf skills/items are still mixed, we'll refine using the original CSV columns.")
