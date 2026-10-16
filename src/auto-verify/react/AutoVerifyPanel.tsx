/**
 * Panel ringkas: daftar order aktif, status liveness / rekening, tombol manual, sakelar
 * auto-verify, dan log diagnostik ("Salin Log") untuk analisis bila ada sinyal yang terlewat.
 * Memakai kelas Tailwind; tanpa Tailwind tetap berfungsi, hanya tanpa gaya.
 */
import { useCallback, useEffect, useState } from "react";

import type { AutoVerifyState, OrderView } from "../core/types";
import { avGetState, avSaveSettings, avVerifyManually } from "../tanstack/server-fns";
import { clearDiagnostics, DIAG_EVENT, readDiagnostics, useLivenessMonitor, type DiagEntry } from "./useLivenessMonitor";

const rp = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;

export function AutoVerifyPanel({ token, pollMs = 15_000 }: { token: string; pollMs?: number }) {
  const [state, setState] = useState<AutoVerifyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await avGetState({ data: { token } }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [token]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  useLivenessMonitor({
    token,
    onResult: (r) => {
      setNotice(r.message);
      void refresh();
    },
  });

  const verify = async (o: OrderView) => {
    setBusy(o.orderNumber);
    try {
      const r = await avVerifyManually({ data: { token, orderNumber: o.orderNumber } });
      setNotice(r.message);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const toggle = async () => {
    if (!state) return;
    await avSaveSettings({ data: { token, enabled: !state.settings.enabled } });
    await refresh();
  };

  const sellOrders = state?.orders.filter((o) => o.tradeType === "SELL") ?? [];

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-neutral-900 p-4 text-sm text-neutral-100">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">Auto-Verify Liveness</h2>
        {state && (
          <button
            type="button"
            onClick={toggle}
            className={`rounded-md border px-2.5 py-1 text-xs font-bold ${
              state.settings.enabled ? "border-emerald-500/40 text-emerald-400" : "border-amber-500/40 text-amber-400"
            }`}
          >
            Auto-verify: {state.settings.enabled ? "ON" : "OFF"}
          </button>
        )}
      </div>

      {error && <div className="rounded-md bg-rose-500/10 p-2 text-xs text-rose-400">{error}</div>}
      {state && !state.credentialsConfigured && (
        <div className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-400">BINANCE_API_KEY / BINANCE_API_SECRET belum diset di server.</div>
      )}
      {state && !state.settings.enabled && (
        <div className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-400">
          Auto-verify mati: rekening hanya dibuka lewat tombol manual walau buyer sudah lolos liveness.
        </div>
      )}
      {notice && <div className="rounded-md bg-sky-500/10 p-2 text-xs text-sky-300">{notice}</div>}

      {sellOrders.length === 0 ? (
        <p className="text-xs text-neutral-400">Tidak ada order jual aktif.</p>
      ) : (
        <ul className="space-y-2">
          {sellOrders.map((o) => (
            <li key={o.orderNumber} className="space-y-1.5 rounded-lg border border-white/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs">#{o.orderNumber.slice(-8)} · @{o.counterPartNickName || "-"}</span>
                <span className="font-bold">{rp(o.totalPrice)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {!o.needsLiveness ? (
                  <span className="text-neutral-400">Tanpa verifikasi wajah</span>
                ) : o.paymentOpened ? (
                  <span className="text-emerald-400">Liveness selesai · rekening terbuka</span>
                ) : o.livenessCompleted ? (
                  <span className="text-sky-400">Liveness selesai · membuka rekening…</span>
                ) : (
                  <span className="text-amber-400">Menunggu buyer verifikasi wajah</span>
                )}
                {o.needsLiveness && !o.paymentOpened && (
                  <button
                    type="button"
                    disabled={busy === o.orderNumber}
                    onClick={() => verify(o)}
                    className="ml-auto rounded-md bg-emerald-600 px-2.5 py-1 font-semibold text-white disabled:opacity-50"
                    title="Tandai liveness selesai & buka rekening sekarang (setelah Anda mengecek sendiri di Binance)"
                  >
                    {busy === o.orderNumber ? "Memproses…" : "Buka Rekening"}
                  </button>
                )}
              </div>
              {o.autoVerify && !o.paymentOpened && (
                <div className={`text-[0.7rem] ${o.autoVerify.state === "failed" ? "text-rose-400" : "text-neutral-400"}`}>
                  Auto-verify: {o.autoVerify.message}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Diagnostics orders={sellOrders} />
      <p className="text-[0.7rem] text-neutral-500">Release kripto tetap dilakukan manual di aplikasi Binance.</p>
    </div>
  );
}

function Diagnostics({ orders }: { orders: OrderView[] }) {
  const [entries, setEntries] = useState<DiagEntry[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const sync = () => setEntries(readDiagnostics());
    sync();
    window.addEventListener(DIAG_EVENT, sync);
    return () => window.removeEventListener(DIAG_EVENT, sync);
  }, []);

  const copy = async () => {
    const payload = { generatedAt: new Date().toISOString(), entries, sellOrders: orders };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch {
      setOpen(true);
    }
  };

  const lastConn = [...entries]
    .reverse()
    .find((e) => e.kind === "ws_open" || e.kind === "ws_closed" || e.kind === "chat_credentials_error");
  return (
    <div className="space-y-1.5 rounded-lg border border-white/10 p-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={lastConn && lastConn.kind === "ws_open" ? "text-emerald-400" : "text-amber-400"}>
          Chat Binance: {lastConn ? `${lastConn.kind} (${lastConn.t})` : "belum ada koneksi"}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={copy} className="underline">Salin Log</button>
          <button type="button" onClick={() => setOpen((v) => !v)} className="underline">{open ? "Tutup" : "Detail"}</button>
          <button type="button" onClick={clearDiagnostics} className="underline text-neutral-400">Hapus</button>
        </div>
      </div>
      {open && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-[0.65rem] text-neutral-300">
          {entries.map((e) => `${e.t} ${e.kind} ${e.detail}`).reverse().join("\n") || "Belum ada log."}
        </pre>
      )}
    </div>
  );
}
