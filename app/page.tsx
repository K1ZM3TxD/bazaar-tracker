"use client";

import { createClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function Home() {
  const [count, setCount] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const { count, error } = await supabase
        .from("items")
        .select("*", { count: "exact", head: true });

      if (error) {
        setErrorMsg(error.message);
        setCount(null);
        return;
      }

      setErrorMsg(null);
      setCount(count ?? 0);
    }

    load();
  }, []);

  return (
    <main style={{ padding: 40 }}>
      <h1>Bazaar Tracker</h1>

      {errorMsg ? (
        <p>❌ Error: {errorMsg}</p>
      ) : count === null ? (
        <p>Loading item count…</p>
      ) : (
        <p>
          Items in database: <strong>{count}</strong>
        </p>
      )}
    </main>
  );
}
