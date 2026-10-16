/**
 * Deteksi "buyer selesai liveness check" dari pesan chat Binance P2P.
 *
 * Sinyal ASLI Binance (terverifikasi dari log produksi):
 *  1. Pesan sistem   type:"system", content: {"orderNo":"…","type":"liveness_check_complete_maker"}
 *  2. Kartu          type:"card", subType:"add_kyc_vrf", self:true,
 *                    content: {"orderNo":"…","addKycVrfInfo":[{"displayTitleValue":"Liveness check","livenessCheckStatus":1}]}
 *                    livenessCheckStatus 0 = menunggu, 1 = selesai. Kartu yang sama dikirim ulang saat status berubah.
 *  Kartu tercatat self:true karena MERCHANT yang meminta verifikasi; user tidak bisa mengirim kartu.
 *
 * KEAMANAN: teks chat biasa (type text/auto_reply/…) TIDAK PERNAH dipercaya, karena buyer bisa
 * mengetik "Verifikasi wajah … Status: Completed" untuk memancing rekening dibuka.
 */

export type ParsedLiveness = {
  isLivenessMessage: boolean;
  isCompleted: boolean;
  orderNumber?: string;
  status: string;
};

const NOT_LIVENESS: ParsedLiveness = { isLivenessMessage: false, isCompleted: false, status: "-" };

/** Tipe pesan yang isinya bisa diketik manusia. */
const USER_TYPED_TYPES = new Set(["", "text", "image", "video", "file", "voice", "audio", "sticker", "emoji", "auto_reply"]);
/** Tipe pesan yang dibuat Binance sendiri. */
const BINANCE_GENERATED_TYPES = new Set(["card", "system"]);

export function isTrustedEnvelope(messageType: string | undefined, fromSelf: boolean | undefined): boolean {
  const type = String(messageType || "").trim().toLowerCase();
  if (BINANCE_GENERATED_TYPES.has(type)) return true;
  if (fromSelf === true) return false;
  return !USER_TYPED_TYPES.has(type);
}

function parseStructured(obj: Record<string, unknown>): ParsedLiveness | null {
  const orderNumber = (obj["orderNo"] || obj["orderNumber"]) as string | undefined;
  const sysType = typeof obj["type"] === "string" ? (obj["type"] as string).toLowerCase() : "";
  if (/^liveness_check_complete/.test(sysType)) {
    return { isLivenessMessage: true, isCompleted: true, ...(orderNumber ? { orderNumber } : {}), status: "Completed" };
  }
  if (/^liveness_check_/.test(sysType)) {
    return { isLivenessMessage: true, isCompleted: false, ...(orderNumber ? { orderNumber } : {}), status: sysType };
  }
  const info = obj["addKycVrfInfo"];
  if (Array.isArray(info)) {
    const checks = info.filter(
      (i) => i && typeof i === "object" && ("livenessCheckStatus" in i || /liveness/i.test(String((i as Record<string, unknown>)["displayTitleValue"] ?? ""))),
    ) as Record<string, unknown>[];
    if (checks.length === 0) return null;
    const done = checks.every((i) => Number(i["livenessCheckStatus"]) === 1);
    return {
      isLivenessMessage: true,
      isCompleted: done,
      ...(orderNumber ? { orderNumber } : {}),
      status: done ? "Completed" : `livenessCheckStatus=${checks.map((i) => i["livenessCheckStatus"]).join(",")}`,
    };
  }
  return null;
}

/**
 * Parser isi pesan. Menerima string JSON, objek, atau teks kartu lama
 * ("Verifikasi wajah … Order number: … Status: Completed").
 */
export function parseLivenessMessage(content: unknown): ParsedLiveness {
  // Isi kartu bisa berupa OBJEK: jangan sampai .trim() melempar error dan kartunya hilang diam-diam.
  let text = (typeof content === "string" ? content : content ? JSON.stringify(content) : "").trim();
  if (!text) return NOT_LIVENESS;

  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const structured = parseStructured(obj);
      if (structured) return structured;
      const inner = obj["content"] ?? obj["text"] ?? obj["message"];
      if (typeof inner === "string") return parseLivenessMessage(inner);
      if (inner && typeof inner === "object") return parseLivenessMessage(inner);
    } catch {
      // bukan JSON utuh: lanjut sebagai teks
    }
  }

  text = text.replace(/\\n/g, "\n");
  const isLiveness = /verifikasi\s*(wajah|muka)|liveness\s*check|facial\s*verification|face\s*verification|\bliveness\b/i.test(text);
  if (!isLiveness) return NOT_LIVENESS;

  // Status eksplisit harus kata utuh ("Uncompleted" / "Not completed" bukan selesai).
  const m = text.match(/status["'*:\s=]+([A-Za-z_]+)/i);
  const statusWord = m?.[1] ?? "";
  const negated = /status["'*:\s=]+(not|belum|tidak)\b/i.test(text);
  let completed =
    /^(completed|complete|selesai|passed|approved|lolos|success|successful|berhasil|verified)$/i.test(statusWord) && !negated;
  if (!m) {
    const pending = /\b(pending|menunggu|waiting|unverified|failed|gagal|not|belum|tidak|incomplete|uncompleted)\b/i.test(text);
    completed = /\b(completed|selesai|passed|approved|lolos|success|terverifikasi)\b/i.test(text) && !pending;
  }
  const order =
    text.match(/(?:order\s*(?:number|no)|nomor\s*pesanan)[*:\s]+(\d{15,25})/i)?.[1] ?? text.match(/\b(\d{15,25})\b/)?.[1];
  return { isLivenessMessage: true, isCompleted: completed, ...(order ? { orderNumber: order } : {}), status: completed ? "Completed" : statusWord || "Unknown" };
}

/** Bingkai WebSocket yang bukan pesan chat (statistik unread, pong). */
export function isNonChatFrame(item: Record<string, unknown>): boolean {
  const t = String(item["type"] ?? "").toLowerCase();
  return t === "statistics" || t === "pong";
}

/** Ambil amplop + isi dari satu item WebSocket chat Binance. */
export function readChatEnvelope(item: Record<string, unknown>): {
  messageType: string;
  fromSelf?: boolean;
  orderNo?: string;
  content: string;
} {
  const data = (item["data"] && typeof item["data"] === "object" ? item["data"] : {}) as Record<string, unknown>;
  const messageType = String(item["type"] || item["msgType"] || data["type"] || "").toLowerCase();
  const raw = data["content"] ?? item["content"] ?? item["text"] ?? data["text"] ?? item["message"] ?? "";
  const content = typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : "";
  const selfVal = typeof item["self"] === "boolean" ? item["self"] : typeof data["self"] === "boolean" ? data["self"] : undefined;
  const orderNo = (item["orderNo"] || data["orderNo"] || item["orderNumber"]) as string | undefined;
  return { messageType, ...(selfVal !== undefined ? { fromSelf: selfVal as boolean } : {}), ...(orderNo ? { orderNo: String(orderNo) } : {}), content };
}
