/**
 * Klien request ber-tanda-tangan (HMAC-SHA256) ke Binance SAPI C2C.
 *
 * Dua gaya request yang dipakai endpoint C2C:
 *  - "form":  GET dengan query string, atau POST dengan body x-www-form-urlencoded
 *             (fallback otomatis ke query string bila body ditolak).
 *  - "agent": query string ber-tanda-tangan + body JSON, header User-Agent khusus
 *             "binance-wallet/1.0.0 (Skill)". Urutan parameter TIDAK boleh disortir.
 *
 * Rem rate limit: HTTP 429/418 atau kode -1003 menahan SEMUA request sampai jeda selesai,
 * supaya IP tidak di-ban lebih lama.
 */
import { createHmac } from "node:crypto";

export type BinanceResponse<T = unknown> = {
  ok: boolean;
  code: string;
  message: string;
  data?: T;
};

type Params = Record<string, string | number | boolean | undefined>;

const g = globalThis as unknown as { __avRateLimitedUntil?: number };

function credentials(): { key: string; secret: string } | null {
  const key = process.env["BINANCE_API_KEY"]?.trim();
  const secret = process.env["BINANCE_API_SECRET"]?.trim();
  if (!key || !secret) return null;
  return { key, secret };
}

export function binanceBaseUrl(): string {
  return (process.env["BINANCE_API_BASE_URL"] || "https://api.binance.com").replace(/\/+$/, "");
}

function signedQuery(params: Params | undefined, secret: string): string {
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== "") entries.push([k, String(v)]);
  }
  entries.push(["recvWindow", "60000"], ["timestamp", String(Date.now())]);
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${qs}&signature=${createHmac("sha256", secret).update(qs).digest("hex")}`;
}

function rateLimited<T>(): BinanceResponse<T> | null {
  const waitMs = (g.__avRateLimitedUntil ?? 0) - Date.now();
  if (waitMs <= 0) return null;
  return { ok: false, code: "RATE_LIMITED", message: `Binance rate limit: request ditahan ${Math.ceil(waitMs / 1000)} detik.` };
}

function noteRateLimit(resp: Response, json: Record<string, unknown>): boolean {
  if (resp.status !== 429 && resp.status !== 418 && String(json["code"] ?? "") !== "-1003") return false;
  const retryAfter = Number(resp.headers.get("retry-after"));
  const pauseMs = retryAfter > 0 ? retryAfter * 1000 : resp.status === 418 ? 120_000 : 60_000;
  g.__avRateLimitedUntil = Math.max(g.__avRateLimitedUntil ?? 0, Date.now() + pauseMs);
  return true;
}

async function send<T>(url: string, init: RequestInit): Promise<{ resp: Response; json: Record<string, unknown> } | BinanceResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(await resp.text());
    } catch {
      // bukan JSON
    }
    if (noteRateLimit(resp, json)) return rateLimited<T>() ?? { ok: false, code: "RATE_LIMITED", message: "Binance rate limit." };
    return { resp, json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "NETWORK_ERROR", message: msg.includes("abort") ? "Timeout 15 detik ke Binance." : msg };
  } finally {
    clearTimeout(timer);
  }
}

function interpret<T>(resp: Response, json: Record<string, unknown>): BinanceResponse<T> {
  const code = String(json["code"] ?? (resp.ok ? "000000" : resp.status));
  const data = json["data"];
  const dataFalse = data === false || (typeof data === "object" && data !== null && (data as Record<string, unknown>)["status"] === false);
  const ok = resp.ok && (code === "000000" || code === "0" || json["success"] === true) && !dataFalse;
  if (!ok) {
    const msg = String(json["message"] || json["msg"] || (dataFalse ? "Binance menolak (data: false)" : `HTTP ${resp.status}`));
    return { ok: false, code: dataFalse ? "REJECTED" : code, message: msg, data: data as T };
  }
  return { ok: true, code: "000000", message: "OK", data: (data !== undefined ? data : json) as T };
}

/** Request gaya "form" (GET query / POST form-urlencoded). */
export async function binanceFormRequest<T = unknown>(opts: {
  path: string;
  method: "GET" | "POST";
  params?: Params;
  headers?: Record<string, string>;
}): Promise<BinanceResponse<T>> {
  const cred = credentials();
  if (!cred) return { ok: false, code: "NO_CREDENTIALS", message: "BINANCE_API_KEY / BINANCE_API_SECRET belum diisi." };
  const limited = rateLimited<T>();
  if (limited) return limited;

  const qs = signedQuery(opts.params, cred.secret);
  const base = `${binanceBaseUrl()}${opts.path}`;
  const headers = { "X-MBX-APIKEY": cred.key, ...opts.headers };

  if (opts.method === "GET") {
    const r = await send<T>(`${base}?${qs}`, { method: "GET", headers });
    return "resp" in r ? interpret<T>(r.resp, r.json) : r;
  }

  const r = await send<T>(base, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: qs,
  });
  if (!("resp" in r)) return r;
  const first = interpret<T>(r.resp, r.json);
  // Body ditolak (4xx / -1000): ulangi sekali dengan parameter di query string. Jangan untuk 5xx.
  if (!first.ok && ((r.resp.status >= 400 && r.resp.status < 500) || first.code === "-1000")) {
    const r2 = await send<T>(`${base}?${signedQuery(opts.params, cred.secret)}`, { method: "POST", headers });
    if ("resp" in r2) {
      const second = interpret<T>(r2.resp, r2.json);
      if (second.ok) return second;
    }
  }
  return first;
}

/** Request gaya "agent" (query ber-tanda-tangan + body JSON). */
export async function binanceAgentRequest<T = unknown>(opts: {
  path: string;
  queryParams?: Params;
  body?: unknown;
}): Promise<BinanceResponse<T>> {
  const cred = credentials();
  if (!cred) return { ok: false, code: "NO_CREDENTIALS", message: "BINANCE_API_KEY / BINANCE_API_SECRET belum diisi." };
  const limited = rateLimited<T>();
  if (limited) return limited;

  const headers: Record<string, string> = { "X-MBX-APIKEY": cred.key, "User-Agent": "binance-wallet/1.0.0 (Skill)" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await send<T>(`${binanceBaseUrl()}${opts.path}?${signedQuery(opts.queryParams, cred.secret)}`, {
    method: "POST",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return "resp" in r ? interpret<T>(r.resp, r.json) : r;
}

export function hasBinanceCredentials(): boolean {
  return credentials() !== null;
}
