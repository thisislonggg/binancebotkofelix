/** Server Binance C2C tiruan untuk tes: memvalidasi tanda tangan HMAC seperti Binance asli. */
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";

export type FakeOrder = { tradeType: "SELL" | "BUY"; orderStatus: string; kyc: number; nick: string };

export type Fake = {
  url: string;
  orders: Record<string, FakeOrder>;
  verifyCalls: string[];
  /** "ok" | "reject" | "reject1" (tolak sekali lalu ok) */
  verifyMode: string;
  badSignatures: number;
  close(): Promise<void>;
};

export async function startFakeBinance(secret: string, orders: Record<string, FakeOrder>): Promise<Fake> {
  const fake = { orders, verifyCalls: [] as string[], verifyMode: "ok", badSignatures: 0 } as Fake;
  const send = (res: import("node:http").ServerResponse, body: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url || "/", "http://x");
      // Validasi tanda tangan: query string (atau body form) tanpa &signature=…
      const signedPart = u.search.length > 1 ? u.search.slice(1) : body;
      const idx = signedPart.lastIndexOf("&signature=");
      const ok =
        idx > 0 &&
        createHmac("sha256", secret).update(signedPart.slice(0, idx)).digest("hex") === signedPart.slice(idx + 11) &&
        req.headers["x-mbx-apikey"] === "test-key";
      if (!ok) {
        fake.badSignatures++;
        return send(res, { code: "-1022", msg: "Signature for this request is not valid." });
      }
      const params = new URLSearchParams(signedPart);
      const no = params.get("orderNumber") || params.get("adOrderNo") || (body.startsWith("{") ? JSON.parse(body).orderNumber : "");
      const row = (n: string) => ({
        orderNumber: n,
        tradeType: orders[n]!.tradeType,
        orderStatus: orders[n]!.orderStatus,
        amount: "100",
        totalPrice: "1685000",
        unitPrice: "16850",
        asset: "USDT",
        fiat: "IDR",
        counterPartNickName: orders[n]!.nick,
        createTime: Date.now(),
      });

      if (u.pathname === "/sapi/v1/c2c/orderMatch/listUserOrderHistory") {
        const tt = params.get("tradeType");
        return send(res, { code: "000000", data: Object.keys(orders).filter((k) => orders[k]!.tradeType === tt).map(row) });
      }
      if (u.pathname.endsWith("/orderMatch/getUserOrderDetail")) {
        if (!orders[no]) return send(res, { code: "-1", msg: "order not found" });
        return send(res, { code: "000000", data: { ...row(no), additionalKycVerify: orders[no]!.kyc } });
      }
      if (u.pathname === "/sapi/v1/c2c/orderMatch/verifiedAdditionalKyc") {
        fake.verifyCalls.push(no);
        if (fake.verifyMode === "reject") return send(res, { code: "-9000", msg: "Ditolak (fake)" });
        if (fake.verifyMode === "reject1") {
          fake.verifyMode = "ok";
          return send(res, { code: "-9000", msg: "Ditolak sekali (fake)" });
        }
        if (orders[no]) orders[no]!.kyc = 2;
        return send(res, { code: "000000", data: { success: true } });
      }
      if (u.pathname === "/sapi/v1/c2c/chat/retrieveChatCredential") {
        return send(res, { code: "000000", data: { chatWssUrl: "wss://im.example/chat", listenKey: "lk", listenToken: "lt" } });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () => new Promise((r) => server.close(() => r()));
  return fake;
}
