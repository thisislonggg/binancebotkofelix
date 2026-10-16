/**
 * Modul SERVER: memasang penyimpanan Supabase sekali per instance, lalu meneruskan inti auto-verify.
 * Di-import dinamis dari server-fns.ts, jadi tidak pernah ikut ter-bundle ke browser.
 *
 * Env (salah satu nama per baris; nama kedua dipasang otomatis oleh integrasi Supabase di Vercel):
 *   SUPABASE_URL              | NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY | SUPABASE_SECRET_KEY
 * Tanpa env ini dipakai memori proses (tidak berbagi antar-instance serverless).
 */
import { createClient } from "@supabase/supabase-js";

import { setAutoVerifyKv, supabaseKv } from "../index";

const g = globalThis as unknown as { __avKvInstalled?: boolean };

if (!g.__avKvInstalled) {
  g.__avKvInstalled = true;
  const url = (process.env["SUPABASE_URL"] || process.env["NEXT_PUBLIC_SUPABASE_URL"])?.trim();
  const key = (process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SUPABASE_SECRET_KEY"])?.trim();
  if (url && key) {
    setAutoVerifyKv(supabaseKv(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })));
  } else if (process.env["VERCEL"]) {
    console.warn("[auto-verify] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diset: status TIDAK tersimpan antar-instance.");
  }
}

export * from "../index";
