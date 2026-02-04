import json
import os
import sys

import psycopg

DB_URL = os.environ.get("SUPABASE_DB_URL")  # we will set this in PowerShell

FILES = [
    ("items_only_supabase.json", "bazaar_items"),
    ("skills_only_supabase.json", "bazaar_skills"),
]

def upsert(cur, table, name, public_image_url, source_image_url):
    cur.execute(
        f"""
        insert into public.{table} (name, public_image_url, source_image_url)
        values (%s, %s, %s)
        on conflict (name) do update set
          public_image_url = excluded.public_image_url,
          source_image_url = excluded.source_image_url
        """,
        (name, public_image_url, source_image_url),
    )

def main():
    if not DB_URL:
        print("Missing SUPABASE_DB_URL env var.")
        sys.exit(1)

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            for file, table in FILES:
                data = json.load(open(file, "r", encoding="utf-8"))
                rows = data.get("items", [])
                n = 0
                for e in rows:
                    upsert(
                        cur,
                        table,
                        e["name"],
                        e["public_image_url"],
                        e.get("source_image_url"),
                    )
                    n += 1
                    if n % 200 == 0:
                        conn.commit()
                        print(f"{table}: {n}/{len(rows)}")

                conn.commit()
                print(f"Imported {n} into {table}")

if __name__ == "__main__":
    main()
