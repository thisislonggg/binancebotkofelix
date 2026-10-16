---
name: binance-p2p-auto-verify
description: Pasang fitur auto-verify liveness Binance P2P (buka detail rekening pembayaran otomatis saat buyer lolos verifikasi wajah di order SELL) ke sebuah proyek. Gunakan saat user minta "auto verify", "auto verifikasi liveness", "buka rekening otomatis setelah verifikasi wajah", atau fitur verifiedAdditionalKyc Binance C2C.
---

# Auto-Verify Liveness Binance P2P

Kode siap pakai ada di folder skill ini: `src/auto-verify/` (inti + TanStack Start + React) dan
`test/` (tes + server Binance tiruan). Salin, jangan tulis ulang dari nol: setiap detail di
bawah berasal dari log produksi.

## Langkah pemasangan

1. Salin `src/auto-verify/` ke `src/` proyek target. Jika target bukan TanStack Start, salin hanya
   `core/` (+ `adapters/` bila perlu) dan bungkus fungsinya dengan route API framework tersebut.
2. Tambahkan env dari `.env.example`: `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `AUTO_VERIFY_ADMIN_TOKEN`.
   Jika proyek sudah punya login, ganti `assertAuthorized` di `tanstack/server-fns.ts` dengan
   pengecekan sesi proyek, dan JANGAN biarkan server function tanpa autentikasi.
3. Render `<AutoVerifyPanel token={…} />` (atau pasang `useLivenessMonitor` sendiri) di halaman
   dashboard. Token dibaca di `useEffect`, bukan saat render, agar tidak ada hydration error.
4. Serverless (Vercel): pasang `setAutoVerifyKv(supabaseKv(client))` atau KV lain; memori per
   instance tidak berbagi record.
5. Salin `test/` dan jalankan `npx tsx test/auto-verify.test.ts`. Semua tes harus lulus.

## Fakta Binance (jangan diubah tanpa log baru)

- Sinyal liveness selesai, keduanya datang beruntun untuk kejadian yang sama:
  - `type:"system"`, content `{"orderNo":…,"type":"liveness_check_complete_maker"}`
  - `type:"card"`, `subType:"add_kyc_vrf"`, `self:true`, content
    `{"orderNo":…,"addKycVrfInfo":[{"displayTitleValue":"Liveness check","livenessCheckStatus":1}]}`
    (`0` = menunggu, `1` = selesai). Kartu tercatat `self:true` karena merchant yang meminta verifikasi.
- `content` adalah string JSON, kadang berupa objek: selalu stringify sebelum parsing.
- Pesan sistem lain di order yang sama BUKAN tanda selesai: `order_created_with_additional_kyc_*`,
  `maker_verified_additional_kyc_maker_sell` (muncul setelah merchant menyetujui), `seller_payed`.
- Bingkai `type:"statistics"` bukan pesan chat.
- `additionalKycVerify`: 0 = tidak perlu, 1 = belum diverifikasi, 2 = sudah. Daftar order sering
  TIDAK memuat field ini: anggap "belum diketahui" (bukan 0) dan baca dari detail order.
- `POST /sapi/v1/c2c/orderMatch/verifiedAdditionalKyc` (query ber-tanda-tangan + body JSON
  `{"orderNumber"}`, User-Agent `binance-wallet/1.0.0 (Skill)`) = tombol "setujui" merchant.
  Binance TIDAK memeriksa liveness buyer, jadi pemanggil wajib punya bukti tepercaya.
- WebSocket chat: `GET /sapi/v1/c2c/chat/retrieveChatCredential?clientType=web` →
  `${chatWssUrl}/${listenKey}?token=${listenToken}&clientType=web`, ping `{"type":"ping"}` tiap 25 detik.

## Aturan keamanan (wajib dipertahankan)

1. Jangan pernah memanggil `releaseCoin`. Release kripto selalu manual.
2. Teks chat biasa (`text`, `auto_reply`, `image`, …) tidak pernah dipercaya sebagai bukti
   liveness, karena buyer bisa mengetik "Status: Completed". Hanya `card`/`system`, webhook ber-secret,
   atau tombol merchant.
3. Jalur otomatis hanya untuk order SELL yang masih aktif dengan `additionalKycVerify === 1`
   (atau belum terbaca bila buktinya sinyal Binance). BUY dan `0` ditolak, dan `2` cukup ditandai.
4. Nomor order di isi pesan harus sama dengan order tempat pesan itu dikirim.
5. Penolakan Binance → backoff 5s…60s, plus 2 percobaan ulang cepat tepat setelah sinyal.

## Diagnosis

Bila order tidak terbuka otomatis, minta user klik **Salin Log** di panel. Baris `server_result`
memberi alasan (auto-verify OFF, ditolak Binance, bukan SELL, dll.). Bila sinyal liveness ada di
`ws_message` tapi tidak muncul `liveness_detected`, berarti format Binance berubah: perbarui
`core/liveness-parser.ts` dan tambahkan pesan aslinya ke tes.
