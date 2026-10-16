export type ActiveOrder = {
  orderNumber: string;
  tradeType: "SELL" | "BUY";
  orderStatus: string;
  /** 0 = tidak perlu verifikasi tambahan, 1 = belum diverifikasi, 2 = sudah. undefined = belum diketahui. */
  additionalKycVerify?: number;
  amount: number;
  totalPrice: number;
  unitPrice: number;
  asset: string;
  fiat: string;
  counterPartNickName: string;
  createTime: number;
};

export type LivenessSource = "binance_chat_ws" | "webhook" | "binance_kyc" | "manual";

export type LivenessRecord = {
  orderNumber: string;
  completedAt: string;
  source: LivenessSource;
  /** true = sinyal yang tidak bisa dipalsukan buyer (kartu/pesan sistem Binance, webhook ber-secret, merchant). */
  trusted: boolean;
  snippet?: string;
};

export type AutoVerifyStatus = {
  state: "verified" | "waiting" | "failed" | "skipped";
  message: string;
  attempts: number;
  lastAt: number;
  nextRetryAt?: number;
};

export type AutoVerifySettings = {
  /** Sakelar utama auto-verify. OFF = rekening hanya dibuka lewat tombol manual. */
  enabled: boolean;
};

export const DEFAULT_SETTINGS: AutoVerifySettings = { enabled: true };

export type OrderView = ActiveOrder & {
  livenessCompleted: boolean;
  paymentOpened: boolean;
  /** Order ini memang meminta verifikasi wajah (SELL dengan additional KYC). */
  needsLiveness: boolean;
  autoVerify?: AutoVerifyStatus;
};

export type AutoVerifyState = {
  settings: AutoVerifySettings;
  orders: OrderView[];
  credentialsConfigured: boolean;
};
