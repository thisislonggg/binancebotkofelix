/**
 * Tes auto-verify: parser dengan pesan ASLI dari log produksi, lalu alur lengkap terhadap
 * server Binance tiruan (yang memvalidasi tanda tangan HMAC).
 * Jalankan: npm test
 */
import assert from "node:assert/strict";

import { startFakeBinance, type FakeOrder } from "./fake-binance";

const SECRET = "test-secret";
process.env["BINANCE_API_KEY"] = "test-key";
process.env["BINANCE_API_SECRET"] = SECRET;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
}

// Pesan apa adanya dari WebSocket chat Binance (log produksi, nomor order disamarkan).
const ORDER = "22944189929600409600";
const realCard = (status: number) =>
  JSON.stringify({
    orderNo: ORDER,
    addKycVrfInfo: [{ addKycVrfType: 1, addKycVrfCategory: 1, lastLivenessCheckTime: 1792105899739, displayTitleValue: "Liveness check", livenessCheckStatus: status, specification: "" }],
  });
const realSystemComplete = JSON.stringify({
  orderNo: ORDER,
  refMessage: '"The counterparty has successfully completed {} for order {}."',
  type: "liveness_check_complete_maker",
});

async function main() {
  const { parseLivenessMessage, isTrustedEnvelope, readChatEnvelope, isNonChatFrame } = await import("../src/auto-verify/core/liveness-parser");

  console.log("── Parser (pesan asli Binance) ──");
  await test("kartu add_kyc_vrf status 0 = belum selesai", () => {
    const p = parseLivenessMessage(realCard(0));
    assert.equal(p.isLivenessMessage, true);
    assert.equal(p.isCompleted, false);
    assert.equal(p.orderNumber, ORDER);
  });
  await test("kartu add_kyc_vrf status 1 = selesai", () => {
    const p = parseLivenessMessage(realCard(1));
    assert.equal(p.isCompleted, true);
    assert.equal(p.orderNumber, ORDER);
  });
  await test("pesan sistem liveness_check_complete_maker = selesai", () => {
    const p = parseLivenessMessage(realSystemComplete);
    assert.equal(p.isCompleted, true);
    assert.equal(p.orderNumber, ORDER);
  });
  await test("pesan sistem lain (order_created_…, maker_verified_…) bukan liveness selesai", () => {
    for (const t of ["order_created_with_additional_kyc_maker_sell", "maker_verified_additional_kyc_maker_sell", "seller_payed"]) {
      assert.equal(parseLivenessMessage(JSON.stringify({ orderNo: ORDER, type: t })).isCompleted, false, t);
    }
  });
  await test("auto_reply 'Wajib verifikasi muka' bukan selesai", () => {
    assert.equal(parseLivenessMessage("1. Wajib verifikasi muka\n2. Nama bank wajib sama").isCompleted, false);
  });
  await test("isi kartu berupa OBJEK tidak membuat parser crash", () => {
    const p = parseLivenessMessage({ orderNo: ORDER, addKycVrfInfo: [{ livenessCheckStatus: 1 }] });
    assert.equal(p.isCompleted, true);
  });
  await test("teks lama 'Status: Not completed' / 'Uncompleted' bukan selesai", () => {
    assert.equal(parseLivenessMessage(`Verifikasi wajah\nOrder number: ${ORDER}\nStatus: Not completed`).isCompleted, false);
    assert.equal(parseLivenessMessage(`Verifikasi wajah\nOrder number: ${ORDER}\nStatus: Uncompleted`).isCompleted, false);
  });
  await test("amplop: card/system dipercaya walau self=true; text/auto_reply tidak", () => {
    assert.equal(isTrustedEnvelope("card", true), true);
    assert.equal(isTrustedEnvelope("system", false), true);
    assert.equal(isTrustedEnvelope("text", false), false);
    assert.equal(isTrustedEnvelope("auto_reply", false), false);
    assert.equal(isTrustedEnvelope("image", false), false);
  });
  await test("readChatEnvelope membaca bingkai WebSocket asli", () => {
    const env = readChatEnvelope({ type: "card", subType: "add_kyc_vrf", orderNo: ORDER, self: true, content: realCard(1) });
    assert.deepEqual([env.messageType, env.fromSelf, env.orderNo], ["card", true, ORDER]);
    assert.equal(isNonChatFrame({ type: "statistics", subType: "unreadChatCount" }), true);
  });

  console.log("── Alur lengkap vs Binance tiruan ──");
  const orders: Record<string, FakeOrder> = {
    "11111111111111111111": { tradeType: "SELL", orderStatus: "TRADING", kyc: 1, nick: "BuyerSatu" },
    "22222222222222222222": { tradeType: "SELL", orderStatus: "TRADING", kyc: 1, nick: "BuyerDua" },
    "33333333333333333333": { tradeType: "BUY", orderStatus: "TRADING", kyc: 1, nick: "SellerTiga" },
    "44444444444444444444": { tradeType: "SELL", orderStatus: "TRADING", kyc: 0, nick: "BuyerEmpat" },
    "55555555555555555555": { tradeType: "SELL", orderStatus: "TRADING", kyc: 1, nick: "BuyerLima" },
    "66666666666666666666": { tradeType: "SELL", orderStatus: "TRADING", kyc: 1, nick: "BuyerEnam" },
  };
  const fake = await startFakeBinance(SECRET, orders);
  process.env["BINANCE_API_BASE_URL"] = fake.url;
  const av = await import("../src/auto-verify/index");
  const sys = (no: string) => JSON.stringify({ orderNo: no, type: "liveness_check_complete_maker" });
  const card = (no: string, s: number) => JSON.stringify({ orderNo: no, addKycVrfInfo: [{ displayTitleValue: "Liveness check", livenessCheckStatus: s }] });
  const ws = (no: string, type: string, content: string, fromSelf: boolean) =>
    av.handleLivenessSignal({ content, messageType: type, fromSelf, envelopeOrderNo: no, source: "binance_chat_ws" });

  const O1 = "11111111111111111111";
  await test("kartu pending tidak membuka rekening", async () => {
    await ws(O1, "card", card(O1, 0), true);
    assert.deepEqual(fake.verifyCalls, []);
  });
  await test("kartu selesai + pesan sistem → rekening dibuka tepat SEKALI", async () => {
    const r1 = await ws(O1, "card", card(O1, 1), true);
    const r2 = await ws(O1, "system", sys(O1), false);
    assert.equal(r1.ok, true, r1.message);
    assert.equal(r2.ok, true);
    assert.deepEqual(fake.verifyCalls, [O1]);
    assert.equal(orders[O1]!.kyc, 2);
  });
  await test("teks palsu dari buyer ditolak (untrusted), rekening tidak dibuka", async () => {
    const O2 = "22222222222222222222";
    const r = await ws(O2, "text", `Verifikasi wajah\nOrder number: ${O2}\nStatus: Completed`, false);
    assert.equal(r.untrusted, true);
    assert.equal(fake.verifyCalls.includes(O2), false);
  });
  await test("order BUY tidak pernah dibuka otomatis", async () => {
    const O3 = "33333333333333333333";
    await ws(O3, "system", sys(O3), false);
    assert.equal(fake.verifyCalls.includes(O3), false);
  });
  await test("order tanpa verifikasi tambahan (kyc 0) ditolak", async () => {
    const O4 = "44444444444444444444";
    await ws(O4, "system", sys(O4), false);
    assert.equal(fake.verifyCalls.includes(O4), false);
  });
  await test("Binance menolak sekali → dicoba ulang cepat & berhasil di request yang sama", async () => {
    const O5 = "55555555555555555555";
    fake.verifyMode = "reject1";
    const t0 = Date.now();
    await ws(O5, "system", sys(O5), false);
    assert.deepEqual(fake.verifyCalls.filter((n) => n === O5).length, 2);
    assert.equal(orders[O5]!.kyc, 2);
    assert.ok(Date.now() - t0 < 6_000);
  });
  await test("auto-verify OFF → ditahan; ON lagi → polling cadangan membuka rekening", async () => {
    const O6 = "66666666666666666666";
    await av.saveSettings({ enabled: false });
    const r = await ws(O6, "system", sys(O6), false);
    assert.match(r.message, /NONAKTIF/);
    assert.equal(fake.verifyCalls.includes(O6), false);
    await av.saveSettings({ enabled: true });
    const state = await av.getAutoVerifyState();
    assert.equal(fake.verifyCalls.includes(O6), true);
    const view = state.orders.find((o) => o.orderNumber === O6);
    assert.equal(view?.paymentOpened, true);
  });
  await test("tombol manual membuka rekening order lain", async () => {
    const O2 = "22222222222222222222";
    const r = await av.verifyManually(O2);
    assert.equal(r.verified, true, r.message);
    assert.equal(orders[O2]!.kyc, 2);
  });
  await test("tombol manual tetap menolak order BUY", async () => {
    const r = await av.verifyManually("33333333333333333333");
    assert.equal(r.verified, false);
    assert.match(r.message, /bukan SELL/);
  });
  await test("kredensial chat WebSocket terbaca", async () => {
    const c = await av.retrieveChatCredential();
    assert.equal(c.ok, true);
  });
  await test("semua request bertanda tangan HMAC valid", () => {
    assert.equal(fake.badSignatures, 0);
  });

  await fake.close();
  console.log(`\n${passed} lulus, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

void main();
