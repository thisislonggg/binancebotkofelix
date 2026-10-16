/**
 * Penyimpanan record liveness & pengaturan.
 *
 * Default: memori proses (globalThis, karena modul server bisa termuat dua kali).
 * Di serverless (Vercel) tiap instance punya memori sendiri, jadi pasang adapter KV yang
 * persisten lewat `setAutoVerifyKv()`; lihat `supabaseKv()` di ../adapters/supabase-kv.ts.
 */
import { DEFAULT_SETTINGS, type AutoVerifySettings, type LivenessRecord } from "./types";

export type KeyValueStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

const RECORDS_KEY = "auto_verify_liveness_records";
const SETTINGS_KEY = "auto_verify_settings";
const MAX_RECORDS = 100;
const SETTINGS_CACHE_MS = 3_000;

type Mem = {
  kv: KeyValueStore | null;
  records: Record<string, LivenessRecord>;
  settings: AutoVerifySettings;
  settingsReadAt: number;
};
const g = globalThis as unknown as { __avStore?: Mem };
const mem = (): Mem =>
  (g.__avStore ??= { kv: null, records: {}, settings: { ...DEFAULT_SETTINGS }, settingsReadAt: 0 });

export function setAutoVerifyKv(kv: KeyValueStore | null): void {
  mem().kv = kv;
  mem().settingsReadAt = 0;
}

async function readJson<T>(key: string): Promise<T | null> {
  const kv = mem().kv;
  if (!kv) return null;
  try {
    const raw = await kv.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    console.warn(`[auto-verify] gagal membaca ${key}:`, err);
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const kv = mem().kv;
  if (!kv) return;
  try {
    await kv.set(key, JSON.stringify(value));
  } catch (err) {
    console.warn(`[auto-verify] gagal menyimpan ${key}:`, err);
  }
}

export async function getLivenessRecords(): Promise<Record<string, LivenessRecord>> {
  const stored = await readJson<Record<string, LivenessRecord>>(RECORDS_KEY);
  return { ...mem().records, ...(stored ?? {}) };
}

export async function saveLivenessRecord(record: LivenessRecord): Promise<void> {
  mem().records[record.orderNumber] = record;
  if (!mem().kv) return;
  const all = await getLivenessRecords();
  all[record.orderNumber] = record;
  const newest = Object.values(all)
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
    .slice(0, MAX_RECORDS);
  await writeJson(RECORDS_KEY, Object.fromEntries(newest.map((r) => [r.orderNumber, r])));
}

export async function deleteLivenessRecord(orderNumber: string): Promise<void> {
  delete mem().records[orderNumber];
  if (!mem().kv) return;
  const all = await getLivenessRecords();
  delete all[orderNumber];
  await writeJson(RECORDS_KEY, all);
}

export async function getSettings(opts: { fresh?: boolean } = {}): Promise<AutoVerifySettings> {
  const m = mem();
  if (!m.kv || (!opts.fresh && Date.now() - m.settingsReadAt < SETTINGS_CACHE_MS)) return m.settings;
  const stored = await readJson<Partial<AutoVerifySettings>>(SETTINGS_KEY);
  if (stored) m.settings = { ...DEFAULT_SETTINGS, ...stored };
  m.settingsReadAt = Date.now();
  return m.settings;
}

export async function saveSettings(settings: AutoVerifySettings): Promise<AutoVerifySettings> {
  const m = mem();
  m.settings = { ...DEFAULT_SETTINGS, ...settings };
  m.settingsReadAt = Date.now();
  await writeJson(SETTINGS_KEY, m.settings);
  return m.settings;
}
