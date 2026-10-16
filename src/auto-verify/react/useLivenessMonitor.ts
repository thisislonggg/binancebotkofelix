/**
 * Pemantau chat Binance di browser: menyambung ke WebSocket chat, menyaring sinyal
 * "liveness selesai", lalu meneruskannya ke server (yang memverifikasi & membuka rekening).
 *
 * Pasang SEKALI di layout dashboard dan biarkan tab terbuka: tanpa tab ini terbuka, sinyal real-time
 * tidak diterima (polling `avGetState` tetap jadi cadangan untuk order yang sudah tercatat).
 */
import { useEffect, useRef } from "react";

import { isNonChatFrame, parseLivenessMessage, readChatEnvelope } from "../core/liveness-parser";
import { avGetChatCredentials, avProcessChatMessage } from "../tanstack/server-fns";

export const DIAG_STORAGE_KEY = "auto_verify_diagnostics";
export const DIAG_EVENT = "auto-verify-diag";
export type DiagEntry = { t: string; kind: string; detail: string };

export function readDiagnostics(): DiagEntry[] {
  try {
    return JSON.parse(localStorage.getItem(DIAG_STORAGE_KEY) || "[]") as DiagEntry[];
  } catch {
    return [];
  }
}

export function clearDiagnostics(): void {
  try {
    localStorage.removeItem(DIAG_STORAGE_KEY);
  } catch {}
  window.dispatchEvent(new Event(DIAG_EVENT));
}

function diag(kind: string, detail: unknown): void {
  try {
    const entries = readDiagnostics();
    entries.push({ t: new Date().toLocaleTimeString("id-ID"), kind, detail: String(detail).slice(0, 1500) });
    localStorage.setItem(DIAG_STORAGE_KEY, JSON.stringify(entries.slice(-60)));
    window.dispatchEvent(new Event(DIAG_EVENT));
  } catch {}
}

export function useLivenessMonitor(opts: {
  token: string | null | undefined;
  enabled?: boolean;
  /** Dipanggil dengan hasil server tiap kali sinyal liveness selesai diproses. */
  onResult?: (result: { ok: boolean; untrusted?: boolean; message: string }) => void;
}): void {
  const { token, enabled = true } = opts;
  const onResultRef = useRef(opts.onResult);
  onResultRef.current = opts.onResult;
  const submitted = useRef(new Set<string>());

  useEffect(() => {
    if (!token || !enabled) return;
    let destroyed = false;
    let ws: WebSocket | null = null;
    let ping: ReturnType<typeof setInterval> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;

    const handleItem = async (item: Record<string, unknown>) => {
      if (isNonChatFrame(item)) return;
      const env = readChatEnvelope(item);
      const parsed = parseLivenessMessage(env.content);
      if (!parsed.isLivenessMessage) return;
      diag("liveness_detected", `type=${env.messageType} self=${env.fromSelf} order=${parsed.orderNumber ?? env.orderNo ?? "-"} completed=${parsed.isCompleted} status=${parsed.status}`);
      if (!parsed.isCompleted) return;
      // Kartu (status 1) dan pesan sistem datang beruntun untuk kejadian yang sama: kirim sekali.
      const key = parsed.orderNumber || env.orderNo || "?";
      if (submitted.current.has(key)) return;
      submitted.current.add(key);
      try {
        const res = await avProcessChatMessage({
          data: {
            token,
            content: env.content,
            messageType: env.messageType,
            ...(env.fromSelf !== undefined ? { fromSelf: env.fromSelf } : {}),
            ...(env.orderNo ? { envelopeOrderNo: env.orderNo } : {}),
          },
        });
        diag("server_result", res.message);
        onResultRef.current?.(res);
      } catch (err) {
        submitted.current.delete(key); // izinkan sinyal berikutnya mencoba lagi
        diag("server_error", err instanceof Error ? err.message : String(err));
      }
    };

    const connect = async () => {
      if (destroyed) return;
      let creds: Awaited<ReturnType<typeof avGetChatCredentials>>;
      try {
        creds = await avGetChatCredentials({ data: { token } });
      } catch (err) {
        diag("chat_credentials_error", err instanceof Error ? err.message : String(err));
        reconnect = setTimeout(connect, 30_000);
        return;
      }
      if (!creds.ok) {
        diag("chat_credentials_error", creds.error);
        reconnect = setTimeout(connect, 30_000);
        return;
      }
      const base = (/^wss?:\/\//.test(creds.wssUrl) ? creds.wssUrl : `wss://${creds.wssUrl}`).replace(/\/+$/, "");
      ws = new WebSocket(`${base}/${creds.listenKey}?token=${creds.listenToken}&clientType=web`);
      ws.onopen = () => {
        diag("ws_open", `Terhubung ke chat Binance (${base})`);
        ping = setInterval(() => {
          try {
            if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
          } catch {}
        }, 25_000);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        if (!/"type"\s*:\s*"(pong|statistics)"/.test(ev.data)) diag("ws_message", ev.data);
        let payload: unknown;
        try {
          payload = JSON.parse(ev.data);
        } catch {
          return;
        }
        for (const item of Array.isArray(payload) ? payload : [payload]) {
          if (item && typeof item === "object") void handleItem(item as Record<string, unknown>);
        }
      };
      ws.onclose = (ev) => {
        diag("ws_closed", `code=${ev.code} ${ev.reason || ""}`);
        if (ping) clearInterval(ping);
        // Kredensial chat bisa kedaluwarsa: ambil ulang saat menyambung lagi.
        if (!destroyed) reconnect = setTimeout(connect, 5_000);
      };
    };

    void connect();
    return () => {
      destroyed = true;
      if (ping) clearInterval(ping);
      if (reconnect) clearTimeout(reconnect);
      ws?.close();
    };
  }, [token, enabled]);
}
