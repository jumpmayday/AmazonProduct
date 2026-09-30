import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { createTreeCache } from "../server/present.js";
import { createServer } from "../server/server.js";
import { createSorftimeClient } from "../server/sorftime.js";

test("未配置密钥时页面和接口都说明如何配置，且没有示例数字", async () => {
  const app = createServer({ client: createSorftimeClient({ accountSk: "" }) });
  const port = await listen(app);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /SORFTIME_ACCOUNT_SK/);
    assert.match(html, /不会出现示例销量/);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`).then((response) => response.json());
    assert.equal(status.configured, false);
    const denied = await fetch(`http://127.0.0.1:${port}/api/keywords/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: "lamp" }),
    });
    const body = await denied.json();
    assert.equal(denied.status, 503);
    assert.match(body.error, /SORFTIME_ACCOUNT_SK/);
    assert.equal(JSON.stringify(body).includes("listingSales"), false);
  } finally {
    await close(app);
  }
});

test("关键词和类目市场会把官方响应渲染成 JSON，密钥不出现在响应里", async () => {
  const seen = [];
  const upstream = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      seen.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw || "{}") });
      const endpoint = req.url.split("?")[0].split("/").pop();
      const payload = fakePayload(endpoint);
      const compressed = endpoint === "CategoryRequest";
      const json = JSON.stringify(payload);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(compressed ? gzipSync(Buffer.from(json)).toString("base64") : json);
    });
  });
  await listen(upstream);
  const upstreamPort = upstream.address().port;
  const client = createSorftimeClient({
    accountSk: "live-test-secret",
    baseUrl: `http://127.0.0.1:${upstreamPort}/api/`,
  });
  const app = createServer({ client, treeCache: createTreeCache() });
  const port = await listen(app);
  try {
    const keyword = await post(port, "/api/keywords/search", { keyword: "power bank" });
    assert.equal(keyword.status, 200);
    assert.equal(keyword.body.keywords.items[0].searchVolume, 80000);
    assert.equal(keyword.body.competitors.products[0].monthlySales, 320);
    assert.equal(keyword.body.competitors.products[0].storeName, "North Store");
    assert.equal(keyword.body.competitors.products[1].monthlySales, null);

    const market = await post(port, "/api/categories/market", { nodeId: "3743561" });
    assert.equal(market.body.listing.market.estimatedMonthlySales, 50);
    assert.equal(market.body.trend.points[0].value, 40);
    assert.equal(JSON.stringify(market.body).includes("live-test-secret"), false);
    assert.ok(seen.some((call) => call.url.startsWith("/api/KeywordQuery?domain=1")));
    assert.ok(seen.some((call) => call.url.startsWith("/api/CategoryTrend?domain=1")));
    assert.ok(seen.every((call) => call.authorization === "BasicAuth live-test-secret"));
  } finally {
    await close(app);
    await close(upstream);
  }
});

test("静态文件拒绝目录穿越", async () => {
  const app = createServer({ client: createSorftimeClient({ accountSk: "" }) });
  const port = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/%2e%2e/%2e%2e/package.json`);
    assert.equal(response.status, 404);
  } finally {
    await close(app);
  }
});

function fakePayload(endpoint) {
  if (endpoint === "KeywordQuery") {
    return {
      code: 0,
      message: "success",
      requestLeft: 70,
      requestConsumed: 5,
      data: [{ keyword: "power bank", searchVolume: 80000, rank: 12, cpc: 80 }],
    };
  }
  if (endpoint === "KeywordSearchResults") {
    return {
      code: 0,
      message: "success",
      requestLeft: 65,
      requestConsumed: 5,
      data: [
        { asin: "B001", title: "One", StoreName: "North Store", buyboxSeller: "North", listingSalesVolumeOfMonth: 320, listingSalesOfMonth: 6400, salesPrice: 1999 },
        { asin: "B002", title: "Two", listingSalesVolumeOfMonth: -1 },
      ],
    };
  }
  if (endpoint === "CategoryRequest") {
    return {
      code: 0,
      message: "success",
      requestLeft: 60,
      requestConsumed: 5,
      data: { products: [{ asin: "B010", title: "Mug", brand: "Mile", StoreName: "Mile Shop", listingSalesVolumeOfMonth: 50, salesPrice: 1299 }] },
    };
  }
  return {
    code: 0,
    message: "success",
    requestLeft: 58,
    requestConsumed: 2,
    data: ["202401", 40, "202402", 44],
  };
}

async function post(port, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
