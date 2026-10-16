import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { AutoVerifyPanel } from "@/auto-verify/react/AutoVerifyPanel";

export const Route = createFileRoute("/")({ component: Dashboard });

const TOKEN_KEY = "av_token";

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

function Dashboard() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Ambil token di useEffect (bukan saat render) agar tidak ada hydration error.
  useEffect(() => {
    setToken(readToken());
    setReady(true);
  }, []);

  if (!ready) return null;
  if (!token) {
    return (
      <LoginForm
        onLogin={(t) => {
          writeToken(t);
          setToken(t);
        }}
      />
    );
  }
  return (
    <main className="mx-auto max-w-2xl space-y-3 p-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            writeToken(null);
            setToken(null);
          }}
          className="text-xs text-neutral-400 underline"
        >
          Keluar
        </button>
      </div>
      <AutoVerifyPanel token={token} />
    </main>
  );
}

function LoginForm({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = value.trim();
    if (t) onLogin(t);
  };
  return (
    <main className="mx-auto flex min-h-screen max-w-sm items-center p-4">
      <form onSubmit={submit} className="w-full space-y-3 rounded-xl border border-white/10 bg-neutral-900 p-4 text-sm">
        <h1 className="font-bold">Auto-Verify Liveness</h1>
        <label className="block space-y-1">
          <span className="text-xs text-neutral-400">Token admin (AUTO_VERIFY_ADMIN_TOKEN)</span>
          <input
            type="password"
            autoComplete="current-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded-md border border-white/10 bg-neutral-950 px-2.5 py-2 font-mono text-xs outline-none focus:border-emerald-500/60"
          />
        </label>
        <button type="submit" className="w-full rounded-md bg-emerald-600 py-2 font-semibold text-white">
          Masuk
        </button>
        <p className="text-[0.7rem] text-neutral-500">Token salah akan terlihat sebagai pesan "Tidak diizinkan." di panel.</p>
      </form>
    </main>
  );
}
