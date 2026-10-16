# Auto-Verify Liveness Binance P2P

Begitu buyer selesai **verifikasi wajah (liveness check)** di order JUAL, detail rekening
pembayaran otomatis dibuka ke buyer. **Release kripto tetap manual** di aplikasi Binance.

Diekstrak dari proyek "Radar P2P" dan sudah diuji dengan format pesan asli Binance
(dari log produksi).

## Isi folder

```
src/auto-verify/
  core/              ← inti, tanpa framework (hanya untuk SERVER)
    binance-client.ts    request ber-tanda-tangan HMAC + rem rate limit
    binance-p2p.ts       daftar order, detail order, verifiedAdditionalKyc, kredensial chat
    liveness-parser.ts   deteksi sinyal liveness asli Binance (aman dipakai di browser)
    auto-verify.ts       aturan keamanan, retry, jalur cadangan
    store.ts             penyimpanan (memori / KV)
    types.ts
  adapters/supabase-kv.ts   penyimpanan Supabase (opsional)
  tanstack/server-fns.ts    server function TanStack Start + autentikasi token
  react/
    useLivenessMonitor.ts   pemantau chat WebSocket Binance di browser
    AutoVerifyPanel.tsx     panel siap pakai (daftar order, tombol manual, log)
test/                       tes + server Binance tiruan
```

## Jalankan repo ini (app siap deploy)

Repo ini sudah berupa app TanStack Start: halaman login token + `AutoVerifyPanel`
(`src/routes/index.tsx`).

```
npm install
npm test          # 20 tes
npm run dev       # http://localhost:3000 (env di .env.local)
```

### Deploy ke Vercel

1. Vercel → **Add New → Project** → import repo ini. Framework terdeteksi otomatis lewat Nitro.
2. **Settings → Environment Variables**: `BINANCE_API_KEY`, `BINANCE_API_SECRET`,
   `AUTO_VERIFY_ADMIN_TOKEN` (string acak panjang, "password" dashboard).
3. **Supabase** (wajib di Vercel, agar status tersimpan antar-instance): pasang integrasi Supabase
   dari Vercel Marketplace, atau isi manual `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Lalu jalankan
   `supabase/schema.sql` di Supabase → SQL Editor. Adapter terpasang otomatis lewat
   `src/auto-verify/tanstack/bootstrap.ts` begitu env-nya ada.
4. Redeploy, buka dashboard, masukkan token admin, dan **biarkan tab itu terbuka**.

`@tanstack/react-start` dikunci di `1.168.32`. Versi 1.169+ mengganti `.inputValidator` menjadi
`.validator`, jadi sesuaikan `tanstack/server-fns.ts` bila meng-upgrade.

## Pasang di proyek lain (TanStack Start)

1. Salin folder `src/auto-verify/` ke `src/` proyek baru.
2. Isi env (lihat `.env.example`): `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `AUTO_VERIFY_ADMIN_TOKEN`.
3. Tampilkan panelnya di salah satu halaman:

```tsx
import { useEffect, useState } from "react";
import { AutoVerifyPanel } from "@/auto-verify/react/AutoVerifyPanel";

function Dashboard() {
  const [token, setToken] = useState<string | null>(null);
  // Ambil token di useEffect (bukan saat render) agar tidak ada hydration error.
  useEffect(() => setToken(localStorage.getItem("av_token")), []);
  if (!token) return <LoginForm onLogin={(t) => { localStorage.setItem("av_token", t); setToken(t); }} />;
  return <AutoVerifyPanel token={token} />;
}
```

4. **Biarkan dashboard terbuka** di satu tab/perangkat. Sinyal liveness diterima real-time lewat
   WebSocket chat Binance di browser itu.

### Di Vercel / serverless

Tiap instance serverless punya memori sendiri, jadi pasang penyimpanan persisten (sekali, di modul server):

```ts
import { createClient } from "@supabase/supabase-js";
import { setAutoVerifyKv, supabaseKv } from "@/auto-verify";

setAutoVerifyKv(supabaseKv(createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)));
```

SQL tabelnya ada di `supabase/schema.sql`. Di repo ini langkah tersebut sudah dilakukan oleh
`tanstack/bootstrap.ts`.

### Stack lain (Next.js, Express, dll.)

Pakai `core/` langsung dari route API Anda: `handleLivenessSignal`, `getAutoVerifyState`,
`verifyManually`, `retrieveChatCredential`, `saveSettings`. Hanya `tanstack/` dan
`react/` yang khusus TanStack Start.

### Notifikasi (opsional)

```ts
import { configureAutoVerify } from "@/auto-verify";
configureAutoVerify({
  onLivenessCompleted: async (rec) => { /* kirim WhatsApp/Telegram */ },
  onPaymentOpened: async (orderNo) => { /* … */ },
});
```

## Tes

```
npm install
npm test        # 20 tes: parser (pesan asli Binance) + alur lengkap vs Binance tiruan
```

## Bila ada order yang tidak terdeteksi otomatis

Klik **Salin Log** di panel dan analisis isinya. Baris `server_result` menjelaskan alasannya
(mis. "Auto-verify NONAKTIF di pengaturan").
