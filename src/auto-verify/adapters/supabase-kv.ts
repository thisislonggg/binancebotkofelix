/**
 * Adapter penyimpanan Supabase (opsional). Butuh tabel key/value:
 *
 *   create table if not exists user_settings (
 *     key text primary key,
 *     value text not null,
 *     updated_at timestamptz default now()
 *   );
 *
 * Pemakaian (sekali, di modul server):
 *   import { createClient } from "@supabase/supabase-js";
 *   setAutoVerifyKv(supabaseKv(createClient(url, serviceRoleKey)));
 */
import type { KeyValueStore } from "../core/store";

type SupabaseLike = {
  from(table: string): any;
};

export function supabaseKv(client: SupabaseLike, table = "user_settings"): KeyValueStore {
  return {
    async get(key) {
      const { data, error } = await client.from(table).select("value").eq("key", key).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { value?: string } | null)?.value ?? null;
    },
    async set(key, value) {
      const { error } = await client.from(table).upsert({ key, value }, { onConflict: "key" });
      if (error) throw new Error(error.message);
    },
  };
}
