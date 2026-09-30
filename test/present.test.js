import assert from "node:assert/strict";
import test from "node:test";
import {
  asProducts,
  categoryMarket,
  categoryTree,
  createTreeCache,
  describeResult,
  parseCategoryMatches,
  searchKeywords,
  summarizeMarket,
} from "../server/present.js";

test("销量为 -1 时保持无法预估，合计不把未知当成 0", () => {
  const products = asProducts({
    products: [
      {
        asin: "B001",
        title: "Known",
        brand: "Alpha",
        StoreName: "Alpha Store",
        buyboxSeller: "Alpha Seller",
        listingSalesVolumeOfMonth: 120,
        listingSalesOfMonth: 2400,
        salesPrice: 1999,
      },
      {
        asin: "B002",
        title: "Unknown",
        brand: "Beta",
        listingSalesVolumeOfMonth: -1,
        listingSalesOfMonth: -1,
        salesPrice: 500,
      },
    ],
  });
  assert.equal(products[1].monthlySales, null);
  assert.equal(products[1].monthlySalesUnknown, true);
  assert.equal(products[1].monthlyRevenueCents, null);
  const market = summarizeMarket(products);
  assert.equal(market.estimatedMonthlySales, 120);
  assert.equal(market.salesUnknownCount, 1);
  assert.equal(market.estimatedMonthlyRevenueCents, 2400);
  assert.equal(market.brandCount, 2);
  assert.equal(market.storeCount, 1);
});

test("全部无法预估时，市场规模是空而不是 0", () => {
  const market = summarizeMarket(asProducts([
    { asin: "B009", title: "No sales", listingSalesVolumeOfMonth: -1 },
  ]));
  assert.equal(market.productCount, 1);
  assert.equal(market.estimatedMonthlySales, null);
  assert.equal(market.estimatedMonthlyRevenueCents, null);
});

test("类目名称搜索接受文档中的 JSON 字符串", () => {
  const parsed = parseCategoryMatches(JSON.stringify([
    { nodeid: "3743561", name: "Kitchen & Dining", CNName: "厨房与餐饮" },
    { nodeId: "99", Name: "Other" },
  ]));
  assert.equal(parsed.unparsed, false);
  assert.equal(parsed.items[0].nodeId, "3743561");
  assert.equal(parsed.items[0].cnName, "厨房与餐饮");
  assert.equal(parsed.items[1].name, "Other");
});

test("关键词查询把两个官方接口的结果分开，未知销量不补数", async () => {
  const calls = [];
  const client = {
    configured: true,
    async call(endpoint, params) {
      calls.push({ endpoint, params });
      if (endpoint === "KeywordQuery") {
        return envelope(0, [{
          keyword: "power bank",
          keywordCNName: "充电宝",
          rank: 100,
          searchVolume: 80000,
          SalesVolumeOf90D: 4000,
          ProductCount: 2000,
          cpc: 125,
          top3Brand: ["Anker"],
        }]);
      }
      return envelope(0, [{
        asin: "B0CVM8TXHP",
        title: "Bank",
        buyboxSeller: "Shop",
        StoreName: "Shop Store",
        listingSalesVolumeOfMonth: -1,
        salesPrice: 2599,
      }]);
    },
  };
  const result = await searchKeywords(client, { keyword: " power bank " });
  assert.deepEqual(calls.map((call) => call.endpoint).sort(), ["KeywordQuery", "KeywordSearchResults"]);
  assert.equal(calls[0].params.pattern.keyword, "power bank");
  assert.equal(result.keywords.items[0].keywordCNName, "充电宝");
  assert.equal(result.competitors.products[0].monthlySales, null);
  assert.equal(result.competitors.stores[0].storeName, "Shop Store");
  assert.equal(result.competitors.stores[0].salesKnownCount, 0);
});

test("类目市场同时请求榜单和销量趋势", async () => {
  const calls = [];
  const client = {
    configured: true,
    async call(endpoint, params) {
      calls.push({ endpoint, params });
      if (endpoint === "CategoryRequest") {
        return envelope(0, { products: [{ asin: "B001", title: "Mug", brand: "A", listingSalesVolumeOfMonth: 5, salesPrice: 1000 }] });
      }
      return envelope(0, ["202401", 10, "202402", 12]);
    },
  };
  const result = await categoryMarket(client, { nodeId: "3743561" });
  assert.deepEqual(calls, [
    { endpoint: "CategoryRequest", params: { nodeId: "3743561" } },
    { endpoint: "CategoryTrend", params: { nodeId: "3743561", trendIndex: 0 } },
  ]);
  assert.equal(result.listing.market.estimatedMonthlySales, 5);
  assert.deepEqual(result.trend.points, [{ month: "202401", value: 10 }, { month: "202402", value: 12 }]);
});

test("类目树第二次读取缓存，不再调用接口", async () => {
  let calls = 0;
  const client = {
    configured: true,
    async call() {
      calls += 1;
      return envelope(0, [{ Id: 1, ParentId: 0, NodeId: "3743561", Name: "Kitchen", CNName: "厨房" }], 5);
    },
  };
  const cache = createTreeCache();
  const first = await categoryTree(client, cache, {});
  const second = await categoryTree(client, cache, {});
  assert.equal(calls, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.usage.requestConsumed, 0);
  assert.equal(second.tree.nodes[0].cnName, "厨房");
});

test("没有密钥时查询直接拒绝，且不调用客户端", async () => {
  let called = false;
  const client = {
    configured: false,
    async call() { called = true; },
  };
  await assert.rejects(() => searchKeywords(client, { keyword: "lamp" }), /SORFTIME_ACCOUNT_SK/);
  assert.equal(called, false);
});

test("HTTP 401 的说明里没有数字结果", () => {
  const message = describeResult({ httpStatus: 401, code: Number.NaN, message: "", data: null });
  assert.match(message, /401/);
  assert.equal(/\d{3,}/.test(message.replace("401", "")), false);
});

function envelope(code, data, requestConsumed = 1) {
  return {
    ok: code === 0,
    httpStatus: 200,
    code,
    message: code === 0 ? "success" : "暂无数据",
    data,
    requestLeft: 90,
    requestConsumed,
  };
}
