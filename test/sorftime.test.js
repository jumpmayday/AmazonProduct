import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import { createSorftimeClient, decodeResponse, normalizeEnvelope, readAccountSk } from "../server/sorftime.js";

test("未配置时不读取空格以外的密钥，也不会把密钥当成已配置", () => {
  assert.equal(readAccountSk({}), "");
  assert.equal(readAccountSk({ SORFTIME_ACCOUNT_SK: "  " }), "");
  assert.equal(readAccountSk({ SORFTIME_ACCOUNT_SK: " sk-test " }), "sk-test");
});

test("压缩过的官方响应能解成 JSON", () => {
  const payload = { code: 0, message: "success", data: { products: [{ asin: "B000TEST" }] }, requestLeft: 8 };
  const encoded = gzipSync(Buffer.from(JSON.stringify(payload))).toString("base64");
  const decoded = decodeResponse(encoded);
  assert.equal(decoded.data.products[0].asin, "B000TEST");
});

test("普通 JSON 原样解析", () => {
  const decoded = decodeResponse(JSON.stringify({ code: 11, message: "暂无数据", data: null }));
  assert.equal(decoded.code, 11);
  assert.equal(decoded.data, null);
});

test("返回外壳忽略大小写和字段名里的空格", () => {
  const envelope = normalizeEnvelope({
    Code: 0,
    Message: "success",
    Data: [],
    RequestLeft: 12,
    "requestconsumed ": 5,
  }, 200);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.requestLeft, 12);
  assert.equal(envelope.requestConsumed, 5);
  assert.deepEqual(envelope.data, []);
});

test("空的 HTTP 401 不会变成业务数据", () => {
  const envelope = normalizeEnvelope(decodeResponse(""), 401);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.httpStatus, 401);
  assert.equal(envelope.data, null);
  assert.equal(Number.isFinite(envelope.code), false);
});

test("客户端按官方 CLI 的地址、域名和 BasicAuth 调用", async () => {
  const seen = [];
  const upstream = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      seen.push({
        url: req.url,
        authorization: req.headers.authorization,
        browser: req.headers.browser,
        body: JSON.parse(raw),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, message: "success", data: [], requestLeft: 3, requestConsumed: 1 }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address();
  try {
    const client = createSorftimeClient({
      accountSk: "secret-account-sk",
      baseUrl: `http://127.0.0.1:${port}/api/`,
    });
    const envelope = await client.call("KeywordRequest", { keyword: "power bank" });
    assert.equal(envelope.code, 0);
    assert.equal(envelope.requestConsumed, 1);
    assert.equal(seen[0].url, "/api/KeywordRequest?domain=1");
    assert.equal(seen[0].authorization, "BasicAuth secret-account-sk");
    assert.equal(seen[0].browser, "Cli");
    assert.deepEqual(seen[0].body, { keyword: "power bank" });
    assert.equal(JSON.stringify(envelope).includes("secret-account-sk"), false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("没有密钥时 call 不会发出请求", async () => {
  let called = false;
  const client = createSorftimeClient({
    accountSk: "",
    fetchImpl() {
      called = true;
      throw new Error("不应发出请求");
    },
  });
  assert.equal(client.configured, false);
  await assert.rejects(() => client.call("KeywordRequest", { keyword: "x" }));
  assert.equal(called, false);
});
