/**
 * Endpoint Binance C2C yang dibutuhkan auto-verify liveness.
 * TIDAK ADA releaseCoin di modul ini: release kripto selalu manual oleh merchant.
 */
import { binanceAgentRequest, binanceFormRequest, type BinanceResponse } from "./binance-client";
import type { ActiveOrder } from "./types";

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const isCompletedStatus = (s: string) =>
  s.includes("COMPLET") || s.includes("SUCCESS") || s.includes("FINISH") || s === "4";
const isCancelledStatus = (s: string) =>
  s.includes("CANCEL") || s.includes("CLOSE") || s === "5" || s === "6" || s === "7";

/** Order P2P yang masih berjalan (24 jam terakhir), sisi SELL dan BUY. */
export async function listActiveOrders(): Promise<ActiveOrder[]> {
  const now = Date.now();
  const fetchSide = async (tradeType: "SELL" | "BUY") => {
    const res = await binanceFormRequest<unknown>({
      path: "/sapi/v1/c2c/orderMatch/listUserOrderHistory",
      method: "GET",
      params: { tradeType, startTimestamp: now - 24 * 60 * 60 * 1000, endTimestamp: now, page: 1, rows: 50 },
    });
    if (!res.ok) return [] as Record<string, unknown>[];
    const d = res.data as unknown;
    const list = Array.isArray(d) ? d : Array.isArray((d as { data?: unknown })?.data) ? (d as { data: unknown[] }).data : [];
    return (list as Record<string, unknown>[]).map((o): Record<string, unknown> => ({ ...o, __side: tradeType }));
  };

  const [sell, buy] = await Promise.all([fetchSide("SELL"), fetchSide("BUY")]);
  const seen = new Set<string>();
  const out: ActiveOrder[] = [];
  for (const o of [...sell, ...buy]) {
    const orderNumber = String(o["orderNumber"] || "");
    if (!orderNumber || seen.has(orderNumber)) continue;
    seen.add(orderNumber);
    const status = String(o["orderStatus"] ?? "").toUpperCase();
    if (isCompletedStatus(status) || isCancelledStatus(status)) continue;

    // Tanpa field KYC di daftar order, statusnya TIDAK diketahui (bukan 0). Detail order yang menentukan.
    const rawKyc = o["additionalKycVerify"];
    const kyc = rawKyc === undefined || rawKyc === null ? undefined : Number(rawKyc);
    const amount = num(o["amount"]);
    const total = num(o["totalPrice"]);
    out.push({
      orderNumber,
      tradeType: String(o["tradeType"] || o["__side"]).toUpperCase() === "BUY" ? "BUY" : "SELL",
      orderStatus: status,
      ...(kyc !== undefined && !Number.isNaN(kyc) ? { additionalKycVerify: kyc } : {}),
      amount,
      totalPrice: total,
      unitPrice: num(o["unitPrice"]) || (amount > 0 ? total / amount : 0),
      asset: String(o["asset"] || "USDT"),
      fiat: String(o["fiat"] || ""),
      counterPartNickName: String(o["counterPartNickName"] || ""),
      createTime: Number(o["createTime"]) || now,
    });
  }
  return out;
}

/** Detail order (tradeType, orderStatus, additionalKycVerify) lewat beberapa jalur resmi. */
export async function getOrderDetail(orderNumber: string): Promise<BinanceResponse<Record<string, unknown>>> {
  const no = orderNumber.trim();
  const path = "/sapi/v1/c2c/orderMatch/getUserOrderDetail";
  const unwrap = (r: BinanceResponse<Record<string, unknown>>) => {
    const d = r.data as Record<string, unknown> | undefined;
    const inner = d && typeof d["data"] === "object" && d["data"] !== null ? (d["data"] as Record<string, unknown>) : d;
    return { ...r, ...(inner ? { data: inner } : {}) };
  };

  const post = await binanceFormRequest<Record<string, unknown>>({ path, method: "POST", params: { orderNumber: no } });
  if (post.ok && post.data) return unwrap(post);
  if (post.code === "RATE_LIMITED" || post.code === "NO_CREDENTIALS") return post;
  const get = await binanceFormRequest<Record<string, unknown>>({ path, method: "GET", params: { orderNumber: no } });
  if (get.ok && get.data) return unwrap(get);
  const agent = await binanceAgentRequest<Record<string, unknown>>({
    path: "/sapi/v1/c2c/agent/orderMatch/getUserOrderDetail",
    queryParams: { orderNumber: no },
    body: { orderNumber: no },
  });
  return agent.ok ? unwrap(agent) : post;
}

/**
 * "Setujui verifikasi tambahan": membuka detail rekening pembayaran ke buyer.
 * Binance TIDAK memeriksa apakah buyer benar-benar lolos liveness, jadi pemanggil wajib
 * memastikan buktinya tepercaya (lihat auto-verify.ts).
 */
export async function verifiedAdditionalKyc(orderNumber: string): Promise<BinanceResponse<{ success?: boolean }>> {
  const no = orderNumber.trim();
  const path = "/sapi/v1/c2c/orderMatch/verifiedAdditionalKyc";
  const accepted = (r: BinanceResponse<{ success?: boolean }>) => r.ok && r.data?.success !== false;

  const r1 = await binanceAgentRequest<{ success?: boolean }>({ path, queryParams: { orderNumber: no }, body: { orderNumber: no } });
  if (accepted(r1) || r1.code === "RATE_LIMITED" || r1.code === "NO_CREDENTIALS") return r1;
  const r2 = await binanceAgentRequest<{ success?: boolean }>({
    path,
    queryParams: { adOrderNo: no, orderNumber: no },
    body: { adOrderNo: no, orderNumber: no },
  });
  if (accepted(r2)) return r2;
  const r3 = await binanceFormRequest<{ success?: boolean }>({ path, method: "POST", params: { orderNumber: no, adOrderNo: no } });
  if (accepted(r3)) return r3;
  return r1;
}

/** Kredensial WebSocket chat Binance (untuk menerima kartu/pesan sistem liveness secara real-time). */
export async function retrieveChatCredential(): Promise<
  { ok: true; wssUrl: string; listenKey: string; listenToken: string } | { ok: false; error: string }
> {
  const res = await binanceFormRequest<Record<string, unknown>>({
    path: "/sapi/v1/c2c/chat/retrieveChatCredential",
    method: "GET",
    params: { clientType: "web" },
    headers: { clientType: "web" },
  });
  if (!res.ok || !res.data) return { ok: false, error: `${res.code}: ${res.message}` };
  const d = res.data;
  const wssUrl = String(d["chatWssUrl"] || d["wssUrl"] || "");
  const listenKey = String(d["listenKey"] || "");
  const listenToken = String(d["listenToken"] || "");
  if (!wssUrl || !listenKey) return { ok: false, error: "Respons kredensial chat tidak lengkap." };
  return { ok: true, wssUrl, listenKey, listenToken };
}
