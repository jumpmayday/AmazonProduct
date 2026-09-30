import { SorftimeError } from "./sorftime.js";

const CODE_TEXT = new Map([
  [0, "成功"],
  [4, "积分余额不足"],
  [10, "请求参数错误"],
  [11, "暂无数据"],
  [16, "该站点不支持此接口"],
  [19, "仅支持细分类目"],
  [400, "当前 IP 未在 Sorftime 白名单中"],
  [401, "接口未开放或密钥无效"],
  [402, "无权查看此数据"],
  [500, "本月请求数量已达限额"],
  [501, "一分钟内请求已达限额"],
  [502, "一天内请求已达限额"],
]);

const TREE_TIMEOUT_MS = 180_000;
const KEYWORD_PAGE_SIZE = 20;
const COMPETITOR_PAGE_SIZE = 50;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function createTreeCache() {
  return { entry: null };
}

export function statusPayload(client) {
  return {
    ok: true,
    configured: Boolean(client?.configured),
    envVar: "SORFTIME_ACCOUNT_SK",
    domain: 1,
    site: "亚马逊美国站",
    metered: true,
  };
}

export async function searchKeywords(client, body) {
  ensureConfigured(client);
  const keyword = requireText(body?.keyword, "请输入关键词", 200);
  const [keywords, competitors] = await Promise.all([
    settle(client.call("KeywordQuery", {
      pattern: { keyword },
      pageIndex: 1,
      pageSize: KEYWORD_PAGE_SIZE,
    })),
    settle(client.call("KeywordSearchResults", {
      keyword,
      pageIndex: 1,
      pageSize: COMPETITOR_PAGE_SIZE,
    })),
  ]);
  const products = competitors.envelope.code === 0 ? asProducts(competitors.envelope.data) : [];
  return {
    ok: keywords.envelope.code === 0 || competitors.envelope.code === 0,
    keyword,
    referenceCost: 10,
    usage: combineUsage([keywords.envelope, competitors.envelope]),
    keywords: section(keywords.envelope, {
      items: keywords.envelope.code === 0 ? asKeywords(keywords.envelope.data) : [],
    }),
    competitors: section(competitors.envelope, {
      products,
      stores: competitors.envelope.code === 0 ? summarizeStores(products) : [],
      brands: competitors.envelope.code === 0 ? summarizeBrands(products) : [],
    }),
  };
}

export async function keywordDetail(client, body) {
  ensureConfigured(client);
  const keyword = requireText(body?.keyword, "请输入关键词", 200);
  const envelope = await callOrFail(client.call("KeywordRequest", { keyword }));
  const detail = envelope.code === 0 ? asKeywordDetail(envelope.data) : null;
  return {
    ok: envelope.code === 0 && detail != null,
    keyword,
    referenceCost: 1,
    usage: combineUsage([envelope]),
    detail: section(envelope, { item: detail }),
  };
}

export async function searchCategories(client, body) {
  ensureConfigured(client);
  const name = requireText(body?.name, "请输入类目名称", 80);
  const envelope = await callOrFail(client.call("CategorySearchFromName", { name }));
  const parsed = envelope.code === 0 ? parseCategoryMatches(envelope.data) : { items: [], unparsed: false, preview: "" };
  return {
    ok: envelope.code === 0,
    name,
    referenceCost: 1,
    usage: combineUsage([envelope]),
    categories: section(envelope, parsed),
  };
}

export async function categoryMarket(client, body) {
  ensureConfigured(client);
  const nodeId = requireNodeId(body?.nodeId);
  const [listing, trend] = await Promise.all([
    settle(client.call("CategoryRequest", { nodeId })),
    settle(client.call("CategoryTrend", { nodeId, trendIndex: 0 })),
  ]);
  const products = listing.envelope.code === 0 ? asProducts(listing.envelope.data) : [];
  const trendPoints = trend.envelope.code === 0 ? parseTrend(trend.envelope.data) : [];
  return {
    ok: listing.envelope.code === 0,
    nodeId,
    referenceCost: 7,
    usage: combineUsage([listing.envelope, trend.envelope]),
    listing: section(listing.envelope, {
      products,
      market: products.length ? summarizeMarket(products) : null,
      stores: products.length ? summarizeStores(products) : [],
      brands: products.length ? summarizeBrands(products) : [],
    }),
    trend: section(trend.envelope, { points: trendPoints }),
  };
}

export async function categoryTree(client, cache, body) {
  ensureConfigured(client);
  const refresh = Boolean(body?.refresh);
  if (!refresh && cache.entry) {
    return {
      ok: true,
      cached: true,
      loadedAt: cache.entry.loadedAt,
      referenceCost: 0,
      usage: { requestConsumed: 0, requestLeft: null, cached: true },
      tree: {
        ok: true,
        code: 0,
        message: "使用本次进程里已经加载的类目树，没有再次请求 Sorftime。",
        nodes: cache.entry.nodes,
      },
    };
  }
  const envelope = await callOrFail(client.call("CategoryTree", {}, { timeoutMs: TREE_TIMEOUT_MS }));
  const nodes = envelope.code === 0 ? slimTree(envelope.data) : null;
  if (envelope.code === 0 && nodes) {
    cache.entry = { nodes, loadedAt: new Date().toISOString() };
  }
  if (envelope.code === 0 && !nodes) {
    return {
      ok: false,
      cached: false,
      loadedAt: null,
      referenceCost: 5,
      usage: combineUsage([envelope]),
      tree: {
        ok: false,
        code: 0,
        message: "类目树返回无法识别，没有缓存，也没有编造类目。",
        nodes: [],
      },
    };
  }
  return {
    ok: envelope.code === 0,
    cached: false,
    loadedAt: cache.entry?.loadedAt ?? null,
    referenceCost: 5,
    usage: combineUsage([envelope]),
    tree: section(envelope, { nodes: nodes ?? [] }),
  };
}

export function describeResult(envelope) {
  if (!envelope) return "没有返回";
  if (envelope.httpStatus === 401) {
    return "Account-SK 未被 Sorftime 接受（HTTP 401）。请检查环境变量 SORFTIME_ACCOUNT_SK。";
  }
  if (envelope.httpStatus >= 400 && !Number.isFinite(envelope.code)) {
    return `Sorftime 返回 HTTP ${envelope.httpStatus}，没有业务数据。`;
  }
  if (!Number.isFinite(envelope.code)) {
    return envelope.message || "Sorftime 返回无法识别，没有展示数字。";
  }
  if (envelope.code === 0) return envelope.message || "成功";
  const known = CODE_TEXT.get(envelope.code);
  const detail = typeof envelope.message === "string" ? envelope.message.trim() : "";
  if (known && detail && detail.toLowerCase() !== "success" && detail !== known) {
    return `${known}：${detail}`;
  }
  return known || detail || "请求失败";
}

export function parseCategoryMatches(data) {
  let value = data;
  for (let depth = 0; depth < 2 && typeof value === "string"; depth += 1) {
    const trimmed = value.trim();
    if (!trimmed) return { items: [], unparsed: false, preview: "" };
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { items: [], unparsed: true, preview: clip(trimmed) };
    }
  }
  const list = extractCategoryList(value);
  const items = list.map(toCategoryMatch).filter(Boolean).slice(0, 5);
  if (!items.length && value != null && value !== "") {
    return { items: [], unparsed: true, preview: clip(JSON.stringify(value)) };
  }
  return { items, unparsed: false, preview: "" };
}

export function asProducts(data) {
  return productList(data).map(toProduct).filter((item) => item.asin || item.title);
}

export function summarizeMarket(products) {
  const tally = emptyTally();
  const brands = new Set();
  const stores = new Set();
  const sellers = new Set();
  for (const product of products) {
    addSales(tally, product);
    if (product.brand) brands.add(product.brand);
    if (product.storeName) stores.add(product.storeName);
    if (product.buyboxSeller) sellers.add(product.buyboxSeller);
  }
  return {
    productCount: products.length,
    estimatedMonthlySales: tally.salesKnown ? tally.sales : null,
    salesKnownCount: tally.salesKnown,
    salesUnknownCount: tally.salesUnknown,
    estimatedMonthlyRevenueCents: tally.revenueKnown ? tally.revenue : null,
    revenueKnownCount: tally.revenueKnown,
    averageSalesPriceCents: tally.priceKnown ? Math.round(tally.priceSum / tally.priceKnown) : null,
    priceKnownCount: tally.priceKnown,
    brandCount: brands.size,
    storeCount: stores.size,
    sellerCount: sellers.size,
  };
}

export function summarizeStores(products) {
  const groups = new Map();
  for (const product of products) {
    const storeName = product.storeName || "未返回店铺名";
    const seller = product.buyboxSeller || "未返回卖家";
    const key = `${storeName}\u0000${seller}`;
    const group = groups.get(key) ?? {
      storeName,
      seller,
      sellerId: product.buyboxSellerId || "",
      sellerCountry: product.sellerCountry || "",
      named: Boolean(product.storeName),
      productCount: 0,
      estimatedMonthlySales: 0,
      salesKnownCount: 0,
      salesUnknownCount: 0,
    };
    group.productCount += 1;
    if (typeof product.monthlySales === "number") {
      group.estimatedMonthlySales += product.monthlySales;
      group.salesKnownCount += 1;
    } else {
      group.salesUnknownCount += 1;
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort(byKnownSales);
}

export function summarizeBrands(products) {
  const groups = new Map();
  for (const product of products) {
    const brand = product.brand || "未返回品牌";
    const group = groups.get(brand) ?? {
      brand,
      named: Boolean(product.brand),
      productCount: 0,
      estimatedMonthlySales: 0,
      salesKnownCount: 0,
      salesUnknownCount: 0,
    };
    group.productCount += 1;
    if (typeof product.monthlySales === "number") {
      group.estimatedMonthlySales += product.monthlySales;
      group.salesKnownCount += 1;
    } else {
      group.salesUnknownCount += 1;
    }
    groups.set(brand, group);
  }
  return [...groups.values()].sort(byKnownSales);
}

export function parseTrend(data) {
  const series = typeof data === "string" ? parseJsonOrNull(data) : data;
  if (!Array.isArray(series)) return [];
  const points = [];
  for (let index = 0; index + 1 < series.length; index += 2) {
    const month = String(series[index] ?? "");
    const value = finiteOrNull(series[index + 1]);
    if (!/^\d{6}$/.test(month) || value == null) continue;
    points.push({ month, value });
  }
  return points;
}

export function slimTree(data) {
  if (!Array.isArray(data)) return null;
  const nodes = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const nodeId = text(pick(item, "NodeId", "nodeId", "nodeid"));
    if (!nodeId) continue;
    const idValue = pick(item, "Id", "id");
    const id = idValue == null ? nodeId : String(idValue);
    const parentRaw = pick(item, "ParentId", "parentId");
    nodes.push({
      id,
      parentId: parentRaw == null ? "0" : String(parentRaw),
      nodeId,
      name: text(pick(item, "Name", "name")),
      cnName: text(pick(item, "CNName", "cnName")),
    });
  }
  return nodes;
}

function asKeywords(data) {
  return keywordList(data).map(toKeyword).filter((item) => item.keyword);
}

function asKeywordDetail(data) {
  const raw = firstObject(data);
  if (!raw) return null;
  const base = toKeyword(raw);
  if (!base.keyword) return null;
  return {
    ...base,
    searchVolumeTrend: parseTrend(raw.searchVolumeTrend),
    categories: parseAssociatedCategories(raw.associatedWithCategoryDetail),
  };
}

function toKeyword(raw) {
  const click = finiteOrNull(pick(raw, "ClickOf90D"));
  return {
    keyword: text(pick(raw, "keyword")),
    keywordCNName: text(pick(raw, "keywordCNName")),
    rank: finiteOrNull(pick(raw, "rank")),
    rankChangeOfWeekly: finiteOrNull(pick(raw, "rankChangeOfWeekly")),
    searchVolume: finiteOrNull(pick(raw, "searchVolume")),
    salesVolumeOf90D: finiteOrNull(pick(raw, "SalesVolumeOf90D", "salesVolumeOf90d")),
    clickOf90D: click === -1 ? null : click,
    clickUnpublished: click === -1,
    searchConversionRate: finiteOrNull(pick(raw, "searchConversionRate")),
    searchConversionRateD90: finiteOrNull(pick(raw, "searchConversionRateD90")),
    productCount: finiteOrNull(pick(raw, "ProductCount", "productCount")),
    cpcCents: finiteOrNull(pick(raw, "cpc")),
    cpcRange: text(pick(raw, "cpcRange")),
    top3Brand: stringList(pick(raw, "top3Brand")),
    top3Asin: stringList(pick(raw, "top3asin", "top3Asin")),
    season: text(pick(raw, "season")),
    shareClickRate: finiteOrNull(pick(raw, "shareClickRate")),
    shareConversionRate: finiteOrNull(pick(raw, "shareConversionRate")),
  };
}

function toProduct(raw) {
  const monthlySales = finiteOrNull(pick(raw, "listingSalesVolumeOfMonth"));
  const monthlyRevenue = finiteOrNull(pick(raw, "listingSalesOfMonth"));
  return {
    asin: text(pick(raw, "asin", "ASIN")),
    title: text(pick(raw, "title", "Title")),
    brand: text(pick(raw, "brand", "Brand")),
    image: httpUrl(firstString(pick(raw, "photo", "Photo"))),
    salesPriceCents: nonNegative(pick(raw, "salesPrice")),
    monthlySales: monthlySales === -1 ? null : monthlySales,
    monthlySalesUnknown: monthlySales == null || monthlySales === -1,
    monthlyRevenueCents: monthlyRevenue == null || monthlyRevenue < 0 ? null : monthlyRevenue,
    buyboxSeller: text(pick(raw, "buyboxSeller")),
    buyboxSellerId: text(pick(raw, "buyboxSellerId")),
    sellerCountry: text(pick(raw, "buyboxSellerAddress")),
    storeName: text(pick(raw, "StoreName", "storeName")),
    sellerCount: finiteOrNull(pick(raw, "sellerCount")),
    rank: finiteOrNull(pick(raw, "rank")),
    ratings: finiteOrNull(pick(raw, "ratings")),
    ratingsCount: finiteOrNull(pick(raw, "ratingsCount")),
    isFba: Boolean(pick(raw, "isFBA", "isFba")),
  };
}

function parseAssociatedCategories(value) {
  const rows = Array.isArray(value) ? value : parseJsonOrNull(value);
  if (!Array.isArray(rows)) return [];
  return rows.filter(Array.isArray).map((row) => ({
    nodeId: text(row[0]),
    name: text(row[1]),
    monthlySales: finiteOrNull(row[2]),
    averagePriceRaw: finiteOrNull(row[3]),
    averageRatings: finiteOrNull(row[4]),
  })).filter((row) => row.nodeId || row.name);
}

function section(envelope, extra) {
  return {
    ok: envelope.code === 0,
    code: Number.isFinite(envelope.code) ? envelope.code : null,
    message: describeResult(envelope),
    requestConsumed: envelope.requestConsumed,
    requestLeft: envelope.requestLeft,
    ...extra,
  };
}

function combineUsage(envelopes) {
  let consumed = 0;
  let consumedKnown = false;
  const lefts = [];
  for (const envelope of envelopes) {
    if (typeof envelope.requestConsumed === "number") {
      consumed += envelope.requestConsumed;
      consumedKnown = true;
    }
    if (typeof envelope.requestLeft === "number") lefts.push(envelope.requestLeft);
  }
  return {
    requestConsumed: consumedKnown ? consumed : null,
    requestLeft: lefts.length ? Math.min(...lefts) : null,
    cached: false,
  };
}

async function settle(promise) {
  try {
    return { envelope: await promise };
  } catch (error) {
    const message = error instanceof SorftimeError ? error.message : "无法连接 Sorftime";
    return {
      envelope: {
        ok: false,
        httpStatus: 0,
        code: Number.NaN,
        message,
        data: null,
        requestLeft: null,
        requestConsumed: null,
      },
    };
  }
}

async function callOrFail(promise) {
  const settled = await settle(promise);
  return settled.envelope;
}

function ensureConfigured(client) {
  if (!client?.configured) {
    throw new HttpError(503, "未配置环境变量 SORFTIME_ACCOUNT_SK。应用已启动，但不会向 Sorftime 发请求，也没有示例数字。");
  }
}

function requireText(value, message, maxLength) {
  if (typeof value !== "string") throw new HttpError(400, message);
  const textValue = value.trim().replace(/[\u0000-\u001F]/g, "");
  if (!textValue) throw new HttpError(400, message);
  if (textValue.length > maxLength) throw new HttpError(400, `内容请少于 ${maxLength} 个字符`);
  return textValue;
}

function requireNodeId(value) {
  const nodeId = requireText(value, "请输入类目 NodeId", 40);
  if (!/^[0-9A-Za-z_-]{1,40}$/.test(nodeId)) {
    throw new HttpError(400, "NodeId 格式不正确");
  }
  return nodeId;
}

function productList(data) {
  if (Array.isArray(data)) return data.filter(isObject);
  if (!isObject(data)) return [];
  const nested = pick(data, "products", "Products");
  return Array.isArray(nested) ? nested.filter(isObject) : [];
}

function keywordList(data) {
  if (Array.isArray(data)) return data.filter(isObject);
  if (!isObject(data)) return [];
  const nested = pick(data, "keywords", "list", "data");
  return Array.isArray(nested) ? nested.filter(isObject) : [];
}

function extractCategoryList(value) {
  if (Array.isArray(value)) return value.filter(isObject);
  if (!isObject(value)) return [];
  for (const key of ["list", "items", "categories", "data", "nodes"]) {
    if (Array.isArray(value[key])) return value[key].filter(isObject);
  }
  if (pick(value, "nodeId", "nodeid", "NodeId")) return [value];
  return [];
}

function toCategoryMatch(item) {
  const nodeId = text(pick(item, "nodeId", "nodeid", "NodeId", "NodeID"));
  if (!nodeId) return null;
  return {
    nodeId,
    name: text(pick(item, "name", "Name", "categoryName")),
    cnName: text(pick(item, "cnName", "CNName", "cnname")),
  };
}

function firstObject(data) {
  if (isObject(data) && !Array.isArray(data)) return data;
  if (Array.isArray(data)) return data.find(isObject) ?? null;
  return null;
}

function emptyTally() {
  return { sales: 0, salesKnown: 0, salesUnknown: 0, revenue: 0, revenueKnown: 0, priceSum: 0, priceKnown: 0 };
}

function addSales(tally, product) {
  if (typeof product.monthlySales === "number") {
    tally.sales += product.monthlySales;
    tally.salesKnown += 1;
  } else {
    tally.salesUnknown += 1;
  }
  if (typeof product.monthlyRevenueCents === "number") {
    tally.revenue += product.monthlyRevenueCents;
    tally.revenueKnown += 1;
  }
  if (typeof product.salesPriceCents === "number") {
    tally.priceSum += product.salesPriceCents;
    tally.priceKnown += 1;
  }
}

function byKnownSales(left, right) {
  const leftSales = left.salesKnownCount ? left.estimatedMonthlySales : -1;
  const rightSales = right.salesKnownCount ? right.estimatedMonthlySales : -1;
  return rightSales - leftSales || right.productCount - left.productCount;
}

function pick(obj, ...keys) {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null) return obj[key];
  }
  return undefined;
}

function text(value) {
  if (value == null) return "";
  return String(value).trim();
}

function firstString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((item) => typeof item === "string") ?? "";
  return "";
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter(Boolean);
}

function httpUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : "";
  } catch {
    return "";
  }
}

function nonNegative(value) {
  const number = finiteOrNull(value);
  return number == null || number < 0 ? null : number;
}

function finiteOrNull(value) {
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJsonOrNull(value) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clip(value) {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object";
}
