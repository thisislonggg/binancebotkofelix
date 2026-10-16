/**
 * Otak auto-verify: begitu buyer lolos liveness check, buka detail rekening pembayaran
 * (verifiedAdditionalKyc) secara otomatis. Release kripto TETAP manual oleh merchant.
 *
 * Aturan keamanan jalur otomatis (jangan dilonggarkan):
 *  1. Hanya order SELL yang masih aktif (bukan selesai/batal).
 *  2. additionalKycVerify harus 1 (butuh verifikasi, belum disetujui). 0 = tidak perlu → tolak,
 *     2 = sudah → cukup tandai. Nilai yang belum terbaca hanya boleh lewat bila buktinya sinyal Binance.
 *  3. Bukti liveness harus tepercaya: kartu/pesan sistem Binance, webhook ber-secret, atau merchant.
 *  4. Penolakan Binance → jeda retry 5s, 10s, 20s, 40s, maks 60s (tidak spam setiap polling).
 * Tombol manual merchant melewati syarat 2–4, tetapi tetap menolak order non-SELL / tidak aktif.
 */
import { getOrderDetail, listActiveOrders, verifiedAdditionalKyc } from "./binance-p2p";
import { hasBinanceCredentials } from "./binance-client";
import { isTrustedEnvelope, parseLivenessMessage } from "./liveness-parser";
import { getLivenessRecords, getSettings, saveLivenessRecord } from "./store";
import type { AutoVerifyState, AutoVerifyStatus, LivenessRecord, LivenessSource, OrderView } from "./types";

type Hooks = {
  /** Dipanggil sekali per order saat liveness selesai (mis. kirim WhatsApp/Telegram). */
  onLivenessCompleted?: (record: LivenessRecord) => void | Promise<void>;
  /** Dipanggil setelah rekening berhasil dibuka ke buyer. */
  onPaymentOpened?: (orderNumber: string) => void | Promise<void>;
  /** Saklar global tambahan (mis. "matikan semua bot"). false = jalur otomatis berhenti. */
  isAutomationAllowed?: () => boolean | Promise<boolean>;
};

type Mem = { verified: Set<string>; status: Map<string, AutoVerifyStatus>; hooks: Hooks };
const g = globalThis as unknown as { __avCore?: Mem };
const mem = (): Mem => (g.__avCore ??= { verified: new Set(), status: new Map(), hooks: {} });

export function configureAutoVerify(hooks: Hooks): void {
  mem().hooks = { ...mem().hooks, ...hooks };
}

export function getAutoVerifyStatus(orderNumber: string): AutoVerifyStatus | undefined {
  return mem().status.get(orderNumber);
}

function setStatus(orderNumber: string, patch: Omit<AutoVerifyStatus, "attempts" | "lastAt"> & { attempts?: number }) {
  const prev = mem().status.get(orderNumber);
  mem().status.set(orderNumber, {
    attempts: patch.attempts ?? prev?.attempts ?? 0,
    lastAt: Date.now(),
    state: patch.state,
    message: patch.message,
    ...(patch.nextRetryAt !== undefined ? { nextRetryAt: patch.nextRetryAt } : {}),
  });
}

const retryDelayMs = (failedAttempts: number) => Math.min(60_000, 5_000 * 2 ** Math.max(0, failedAttempts - 1));
const inactive = (s: string) =>
  /CANCEL|CLOSE|COMPLET|SUCCESS|FINISH/.test(s) || s === "4" || s === "5" || s === "6" || s === "7";

export type ExecuteResult = { ok: boolean; verified: boolean; skipped?: boolean; message: string };

export async function executeAutoVerify(params: {
  orderNumber: string;
  tradeType?: string;
  orderStatus?: string;
  additionalKycVerify?: number;
  livenessCompleted?: boolean;
  /** Bukti berasal dari kartu/pesan sistem Binance sendiri. */
  binanceSignal?: boolean;
  /** Abaikan jeda retry (percobaan ulang cepat tepat setelah sinyal liveness). */
  retryNow?: boolean;
  /** Aksi eksplisit merchant (tombol). */
  manual?: boolean;
}): Promise<ExecuteResult> {
  const no = params.orderNumber.trim();
  if (!no) return { ok: false, verified: false, message: "Nomor order kosong." };
  const manual = params.manual === true;
  const m = mem();

  if (m.verified.has(no)) return { ok: true, verified: true, skipped: true, message: `Order #${no} sudah dibuka sebelumnya.` };

  const hold = (message: string): ExecuteResult => {
    setStatus(no, { state: "waiting", message });
    return { ok: false, verified: false, skipped: true, message };
  };
  const reject = (message: string): ExecuteResult => {
    setStatus(no, { state: "skipped", message });
    return { ok: false, verified: false, skipped: true, message };
  };

  if (!manual) {
    const settings = await getSettings();
    if (!settings.enabled) return hold("Auto-verify NONAKTIF di pengaturan: buka rekening dengan tombol manual.");
    if (m.hooks.isAutomationAllowed && !(await m.hooks.isAutomationAllowed())) {
      return hold("Otomatisasi sedang dimatikan (saklar utama).");
    }
    const prev = m.status.get(no);
    if (!params.retryNow && prev?.nextRetryAt && Date.now() < prev.nextRetryAt) {
      return { ok: false, verified: false, skipped: true, message: `Menunggu jeda retry ${Math.ceil((prev.nextRetryAt - Date.now()) / 1000)}s.` };
    }
  }

  let tradeType = (params.tradeType || "").toUpperCase();
  let status = String(params.orderStatus ?? "").toUpperCase();
  let kyc = params.additionalKycVerify;
  if (!tradeType || !status || kyc === undefined || Number.isNaN(kyc)) {
    const detail = await getOrderDetail(no);
    const d = detail.ok ? detail.data : undefined;
    if (d) {
      if (!tradeType && d["tradeType"]) tradeType = String(d["tradeType"]).toUpperCase();
      if (!status && d["orderStatus"] !== undefined) status = String(d["orderStatus"]).toUpperCase();
      if ((kyc === undefined || Number.isNaN(kyc)) && d["additionalKycVerify"] !== undefined) kyc = Number(d["additionalKycVerify"]);
    }
  }

  if (kyc === 2) {
    m.verified.add(no);
    setStatus(no, { state: "verified", message: "Binance: verifikasi tambahan sudah disetujui." });
    return { ok: true, verified: true, skipped: true, message: `Order #${no} sudah terverifikasi di Binance.` };
  }

  const binanceSignal = params.binanceSignal === true && params.livenessCompleted === true;
  if (tradeType && tradeType !== "SELL") return reject(`[KEAMANAN] Order #${no} bukan SELL (${tradeType}).`);
  if (!tradeType && !manual && !binanceSignal) return hold(`Jenis order #${no} belum terbaca dari Binance. Ditahan.`);
  if (inactive(status)) return reject(`[KEAMANAN] Order #${no} sudah tidak aktif (${status}).`);

  if (!manual) {
    if (kyc === 0) return reject(`Order #${no} tidak membutuhkan verifikasi tambahan.`);
    const kycUnknown = kyc === undefined || Number.isNaN(kyc);
    if (kyc !== 1 && !(kycUnknown && binanceSignal)) return hold(`Status verifikasi tambahan order #${no} belum terbaca. Ditahan.`);
    if (params.livenessCompleted !== true) return hold("Menunggu buyer menyelesaikan liveness check.");
  }

  const prevAttempts = m.status.get(no)?.attempts ?? 0;
  const res = await verifiedAdditionalKyc(no);
  if (res.ok && res.data?.success !== false) {
    m.verified.add(no);
    setStatus(no, { state: "verified", message: "Rekening pembayaran berhasil dibuka ke buyer.", attempts: prevAttempts + 1 });
    console.log(`[auto-verify] Order SELL #${no}: rekening dibuka ke buyer.`);
    await m.hooks.onPaymentOpened?.(no);
    return { ok: true, verified: true, message: `Rekening pembayaran order #${no} dibuka ke buyer.` };
  }
  const attempts = prevAttempts + 1;
  setStatus(no, {
    state: "failed",
    message: `Binance menolak (kode ${res.code}): ${res.message}`,
    attempts,
    nextRetryAt: Date.now() + retryDelayMs(attempts),
  });
  console.warn(`[auto-verify] Order #${no} ditolak Binance (percobaan ${attempts}): ${res.code} ${res.message}`);
  return { ok: false, verified: false, message: `Binance menolak: ${res.message}` };
}

export type SignalResult = {
  ok: boolean;
  isLiveness: boolean;
  isCompleted: boolean;
  untrusted?: boolean;
  orderNumber?: string;
  message: string;
};

/**
 * Proses satu pesan chat (dari WebSocket di browser, atau webhook). Dipanggil untuk SETIAP
 * pesan; yang bukan liveness diabaikan.
 */
export async function handleLivenessSignal(input: {
  content: string;
  messageType?: string;
  fromSelf?: boolean;
  envelopeOrderNo?: string;
  source: Exclude<LivenessSource, "binance_kyc" | "manual">;
}): Promise<SignalResult> {
  const parsed = parseLivenessMessage(input.content);
  if (!parsed.isLivenessMessage) return { ok: false, isLiveness: false, isCompleted: false, message: "Bukan pesan liveness." };
  const orderNumber = parsed.orderNumber || input.envelopeOrderNo;
  if (!parsed.isCompleted) {
    return { ok: false, isLiveness: true, isCompleted: false, ...(orderNumber ? { orderNumber } : {}), message: `Liveness belum selesai (${parsed.status}).` };
  }
  if (!orderNumber) return { ok: false, isLiveness: true, isCompleted: true, message: "Nomor order tidak ditemukan di pesan." };

  if (input.source === "binance_chat_ws") {
    const mismatch = Boolean(input.envelopeOrderNo && parsed.orderNumber && input.envelopeOrderNo !== parsed.orderNumber);
    if (mismatch || !isTrustedEnvelope(input.messageType, input.fromSelf)) {
      console.warn(`[auto-verify] Liveness "Completed" order #${orderNumber} DIABAIKAN (tipe=${input.messageType}, self=${input.fromSelf}).`);
      return {
        ok: false,
        isLiveness: true,
        isCompleted: true,
        untrusted: true,
        orderNumber,
        message: mismatch
          ? `Pesan menyebut order #${orderNumber} tetapi dikirim di chat order lain. Diabaikan.`
          : `Pesan "liveness selesai" untuk order #${orderNumber} berupa chat biasa (tipe ${input.messageType || "?"}), bukan sinyal Binance. Diabaikan: periksa manual.`,
      };
    }
  }

  // Kartu (status 1) dan pesan sistem datang beruntun untuk kejadian yang sama: catat & beri tahu sekali.
  const existing = (await getLivenessRecords())[orderNumber];
  if (!existing?.trusted) {
    const record: LivenessRecord = {
      orderNumber,
      completedAt: new Date().toISOString(),
      source: input.source,
      trusted: true,
      snippet: input.content.slice(0, 300),
    };
    await saveLivenessRecord(record);
    await mem().hooks.onLivenessCompleted?.(record);
  }

  // Tepat setelah liveness, Binance kadang belum siap: coba ulang cepat dalam request yang sama.
  const binanceSignal = input.source === "binance_chat_ws";
  let res = await executeAutoVerify({ orderNumber, livenessCompleted: true, binanceSignal });
  for (const waitMs of [2_000, 4_000]) {
    if (res.verified || res.skipped) break;
    await new Promise((r) => setTimeout(r, waitMs));
    res = await executeAutoVerify({ orderNumber, livenessCompleted: true, binanceSignal, retryNow: true });
  }
  return { ok: true, isLiveness: true, isCompleted: true, orderNumber, message: `Order #${orderNumber}: buyer selesai liveness. ${res.message}` };
}

/** Tombol merchant: tandai liveness selesai & buka rekening sekarang. */
export async function verifyManually(orderNumber: string): Promise<ExecuteResult> {
  const no = orderNumber.trim();
  await saveLivenessRecord({ orderNumber: no, completedAt: new Date().toISOString(), source: "manual", trusted: true });
  return executeAutoVerify({ orderNumber: no, manual: true, livenessCompleted: true });
}

/**
 * Status semua order aktif + jalur cadangan: order dengan bukti liveness tepercaya yang
 * rekeningnya belum terbuka dicoba lagi di sini (mis. bila percobaan pertama ditolak Binance).
 * Panggil berkala dari dashboard (cukup tiap 15 detik).
 */
export async function getAutoVerifyState(): Promise<AutoVerifyState> {
  const settings = await getSettings();
  if (!hasBinanceCredentials()) return { settings, orders: [], credentialsConfigured: false };

  const [orders, records] = await Promise.all([listActiveOrders(), getLivenessRecords()]);
  const m = mem();
  const views: OrderView[] = [];
  for (const ord of orders) {
    const isSell = ord.tradeType === "SELL";
    if (isSell && !m.verified.has(ord.orderNumber) && ord.additionalKycVerify !== 2) {
      const detail = await getOrderDetail(ord.orderNumber);
      const d = detail.ok ? detail.data : undefined;
      if (d?.["additionalKycVerify"] !== undefined) ord.additionalKycVerify = Number(d["additionalKycVerify"]);
      if (d?.["orderStatus"] !== undefined) ord.orderStatus = String(d["orderStatus"]).toUpperCase();
    }
    if (isSell && ord.additionalKycVerify === 2) m.verified.add(ord.orderNumber);

    const record = records[ord.orderNumber];
    if (isSell && record?.trusted && !m.verified.has(ord.orderNumber)) {
      await executeAutoVerify({
        orderNumber: ord.orderNumber,
        tradeType: ord.tradeType,
        orderStatus: ord.orderStatus,
        ...(ord.additionalKycVerify !== undefined ? { additionalKycVerify: ord.additionalKycVerify } : {}),
        livenessCompleted: true,
        binanceSignal: record.source === "binance_chat_ws",
      });
    }
    const autoVerify = m.status.get(ord.orderNumber);
    views.push({
      ...ord,
      needsLiveness: isSell && ord.additionalKycVerify !== 0,
      livenessCompleted: Boolean(record?.trusted) || ord.additionalKycVerify === 2,
      paymentOpened: m.verified.has(ord.orderNumber),
      ...(autoVerify ? { autoVerify } : {}),
    });
  }
  return { settings, orders: views, credentialsConfigured: true };
}
