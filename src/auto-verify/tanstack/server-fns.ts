/**
 * Server function TanStack Start untuk auto-verify.
 *
 * Autentikasi: setiap panggilan wajib membawa `token` yang sama dengan env AUTO_VERIFY_ADMIN_TOKEN
 * (dibandingkan constant-time). Tanpa env itu semua panggilan DITOLAK, karena endpoint ini bisa
 * membuka rekening pembayaran ke buyer. Ganti `assertAuthorized` bila proyek punya sistem login sendiri.
 *
 * Modul server (node:crypto, klien Binance) di-import DINAMIS di dalam handler, supaya tidak pernah
 * ikut ter-bundle ke browser (file ini di-import oleh komponen React).
 */
import { createServerFn } from "@tanstack/react-start";

async function assertAuthorized(token: unknown): Promise<void> {
  const { timingSafeEqual } = await import("node:crypto");
  const expected = process.env["AUTO_VERIFY_ADMIN_TOKEN"]?.trim();
  if (!expected) throw new Error("AUTO_VERIFY_ADMIN_TOKEN belum diset di server.");
  const a = Buffer.from(String(token ?? ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Tidak diizinkan.");
}

// bootstrap.ts memasang adapter Supabase (bila env-nya ada) sebelum inti dipakai.
const core = () => import("./bootstrap");
const obj = (d: unknown): Record<string, unknown> => (d && typeof d === "object" ? (d as Record<string, unknown>) : {});
const str = (v: unknown, max = 20_000): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);

export const avGetChatCredentials = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => ({ token: str(obj(d)["token"]) }))
  .handler(async ({ data }) => {
    await assertAuthorized(data.token);
    return (await core()).retrieveChatCredential();
  });

export const avProcessChatMessage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => {
    const o = obj(d);
    const content = str(o["content"]);
    if (!content) throw new Error("content wajib diisi");
    return {
      token: str(o["token"]),
      content,
      messageType: str(o["messageType"], 40),
      fromSelf: typeof o["fromSelf"] === "boolean" ? (o["fromSelf"] as boolean) : undefined,
      envelopeOrderNo: str(o["envelopeOrderNo"], 40),
    };
  })
  .handler(async ({ data }) => {
    await assertAuthorized(data.token);
    return (await core()).handleLivenessSignal({
      content: data.content,
      source: "binance_chat_ws",
      ...(data.messageType !== undefined ? { messageType: data.messageType } : {}),
      ...(data.fromSelf !== undefined ? { fromSelf: data.fromSelf } : {}),
      ...(data.envelopeOrderNo !== undefined ? { envelopeOrderNo: data.envelopeOrderNo } : {}),
    });
  });

export const avGetState = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => ({ token: str(obj(d)["token"]) }))
  .handler(async ({ data }) => {
    await assertAuthorized(data.token);
    return (await core()).getAutoVerifyState();
  });

export const avVerifyManually = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => {
    const o = obj(d);
    const orderNumber = str(o["orderNumber"], 40);
    if (!orderNumber) throw new Error("orderNumber wajib diisi");
    return { token: str(o["token"]), orderNumber };
  })
  .handler(async ({ data }) => {
    await assertAuthorized(data.token);
    return (await core()).verifyManually(data.orderNumber);
  });

export const avSaveSettings = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => {
    const o = obj(d);
    return { token: str(o["token"]), enabled: o["enabled"] === true };
  })
  .handler(async ({ data }) => {
    await assertAuthorized(data.token);
    return (await core()).saveSettings({ enabled: data.enabled });
  });
