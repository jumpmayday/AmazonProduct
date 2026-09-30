const statusEl = document.querySelector("#status");
const keywordForm = document.querySelector("#keyword-form");
const keywordResult = document.querySelector("#keyword-result");
const categorySearchForm = document.querySelector("#category-search-form");
const categoryMarketForm = document.querySelector("#category-market-form");
const categoryResult = document.querySelector("#category-result");
const treeButton = document.querySelector("#tree-load");
const nodeInput = document.querySelector("#node-id");

let configured = false;
let treeNodes = [];
let treeFocus = "0";
let treeCrumbs = [];

document.querySelector("#tab-keyword").addEventListener("click", () => selectTab("keyword"));
document.querySelector("#tab-category").addEventListener("click", () => selectTab("category"));
keywordForm.addEventListener("submit", onKeywordSearch);
categorySearchForm.addEventListener("submit", onCategorySearch);
categoryMarketForm.addEventListener("submit", onCategoryMarket);
treeButton.addEventListener("click", () => loadTree(false));

init();

async function init() {
  try {
    const status = await getJson("/api/status");
    configured = Boolean(status.configured);
    renderStatus(status);
  } catch {
    configured = false;
    renderStatus(null);
  }
  setLocked(!configured);
}

function selectTab(name) {
  const keyword = name === "keyword";
  document.querySelector("#tab-keyword").setAttribute("aria-selected", String(keyword));
  document.querySelector("#tab-category").setAttribute("aria-selected", String(!keyword));
  document.querySelector("#panel-keyword").hidden = !keyword;
  document.querySelector("#panel-category").hidden = keyword;
}

async function onKeywordSearch(event) {
  event.preventDefault();
  const keyword = new FormData(keywordForm).get("keyword");
  await run(keywordResult, () => postJson("/api/keywords/search", { keyword }), renderKeyword);
}

async function onCategorySearch(event) {
  event.preventDefault();
  const name = new FormData(categorySearchForm).get("name");
  await run(categoryResult, () => postJson("/api/categories/search", { name }), renderCategorySearch);
}

async function onCategoryMarket(event) {
  event.preventDefault();
  await run(categoryResult, () => postJson("/api/categories/market", { nodeId: nodeInput.value }), renderMarket);
}

async function loadTree(refresh) {
  await run(categoryResult, () => postJson("/api/categories/tree", { refresh }), (payload) => {
    treeNodes = payload.tree?.nodes || [];
    treeFocus = "0";
    treeCrumbs = [];
    renderTree(payload);
  });
}

async function openDetail(keyword) {
  if (!configured) return;
  setLocked(true);
  let slot = document.querySelector("#keyword-detail");
  if (!slot) {
    slot = document.createElement("div");
    slot.id = "keyword-detail";
    keywordResult.prepend(slot);
  }
  slot.replaceChildren(note("正在查询这个关键词的详情。"));
  try {
    const payload = await postJson("/api/keywords/detail", { keyword });
    slot.replaceChildren();
    renderDetail(slot, payload);
  } catch (error) {
    slot.replaceChildren(note(error.message || "详情查询失败", true));
  } finally {
    setLocked(!configured);
  }
}

async function run(host, request, render) {
  if (!configured) return;
  setLocked(true);
  host.replaceChildren(note("正在向 Sorftime 查询，请等待。关闭页面前不要重复点击。"));
  try {
    const payload = await request();
    host.replaceChildren();
    render(payload);
    host.scrollIntoView({ block: "start" });
  } catch (error) {
    host.replaceChildren(note(error.message || "查询失败", true));
  } finally {
    setLocked(!configured);
  }
}

function renderStatus(status) {
  statusEl.replaceChildren();
  if (!status) {
    statusEl.className = "status missing";
    statusEl.append(heading("无法确认配置"), paragraph("请确认服务已启动，并设置环境变量 SORFTIME_ACCOUNT_SK。"));
    return;
  }
  if (!status.configured) {
    statusEl.className = "status missing";
    statusEl.append(
      heading("还没有配置 Sorftime Account-SK"),
      paragraph("应用已经启动。在设置环境变量之前，不会调用 Sorftime，页面也不会填入任何示例销量、关键词或市场规模。"),
      paragraph("1. 在 Sorftime 后台复制 Account-SK，它和 CLI 使用同一把密钥。"),
      paragraph("2. 在启动目录执行 export SORFTIME_ACCOUNT_SK=你的密钥"),
      paragraph("3. 重新运行 npm start，然后打开这个页面。"),
    );
    return;
  }
  statusEl.className = "status ready";
  statusEl.append(
    heading("密钥已放在服务端"),
    paragraph("只查询亚马逊美国站（domain = 1）。每次点击都会按 Sorftime 实际用量扣减 Request，这里不保存查询，也不会定时刷新。"),
  );
}

function renderKeyword(payload) {
  keywordResult.append(usageLine(payload));
  keywordResult.append(keywordTable(payload.keywords));
  keywordResult.append(productBlock("竞品", payload.competitors));
  keywordResult.append(groupBlock("店铺", payload.competitors?.stores, storeRow));
  keywordResult.append(groupBlock("品牌", payload.competitors?.brands, brandRow));
}

function renderDetail(host, payload) {
  const box = document.createElement("article");
  box.className = "detail";
  box.append(heading(payload.detail?.ok ? `关键词详情：${payload.keyword}` : "关键词详情"));
  box.append(usageLine(payload));
  if (!payload.detail?.ok || !payload.detail.item) {
    box.append(note(payload.detail?.message || "没有详情", true));
    host.append(box);
    return;
  }
  const item = payload.detail.item;
  box.append(definitionList([
    ["中文名", item.keywordCNName || "—"],
    ["周搜索排名", formatCount(item.rank)],
    ["近 30 天搜索量", formatCount(item.searchVolume)],
    ["近 90 天购买量", formatCount(item.salesVolumeOf90D)],
    ["近 90 天点击量", item.clickUnpublished ? "未公布" : formatCount(item.clickOf90D)],
    ["过去 360 天搜索转化比", formatPercent(item.searchConversionRate)],
    ["竞品数量", formatCount(item.productCount)],
    ["CPC 精准竞价", formatUsd(item.cpcCents)],
    ["前 3 品牌", item.top3Brand.join("、") || "—"],
    ["前 3 ASIN", item.top3Asin.join("、") || "—"],
  ]));
  if (item.categories?.length) {
    box.append(heading("关联细分类目"));
    box.append(categoryDetailTable(item.categories));
  }
  if (item.searchVolumeTrend?.length) {
    box.append(heading("搜索量趋势"));
    box.append(trendChart(item.searchVolumeTrend));
  }
  host.append(box);
}

function renderCategorySearch(payload) {
  categoryResult.append(usageLine(payload));
  const box = document.createElement("article");
  box.className = "block";
  box.append(heading("类目搜索"));
  if (!payload.categories?.ok) {
    box.append(note(payload.categories?.message || "没有结果", true));
    categoryResult.append(box);
    return;
  }
  const items = payload.categories.items || [];
  if (!items.length) {
    box.append(note(payload.categories.unparsed ? "接口有返回，但没有识别出 nodeId。" : "没有匹配的类目。"));
    if (payload.categories.preview) {
      const pre = document.createElement("pre");
      pre.textContent = payload.categories.preview;
      box.append(pre);
    }
    categoryResult.append(box);
    return;
  }
  const list = document.createElement("div");
  list.className = "match-list";
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "match";
    const copy = document.createElement("div");
    copy.append(strongText(item.cnName || item.name || item.nodeId));
    const small = document.createElement("small");
    small.textContent = `${item.name || "未返回英文名"} · NodeId ${item.nodeId}`;
    copy.append(small);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inline-button";
    button.textContent = "查看市场";
    button.addEventListener("click", () => {
      nodeInput.value = item.nodeId;
      categoryMarketForm.requestSubmit();
    });
    card.append(copy, button);
    list.append(card);
  }
  box.append(list);
  categoryResult.append(box);
}

function renderMarket(payload) {
  categoryResult.append(usageLine(payload));
  const listing = payload.listing;
  const box = document.createElement("article");
  box.className = "block";
  box.append(heading(`类目市场 · ${payload.nodeId}`));
  if (!listing?.ok) {
    box.append(note(listing?.message || "没有市场数据", true));
    categoryResult.append(box);
    categoryResult.append(trendBlock(payload.trend));
    return;
  }
  if (!listing.market) {
    box.append(note(listing.message || "这个类目没有返回榜单产品。"));
    categoryResult.append(box);
    categoryResult.append(trendBlock(payload.trend));
    return;
  }
  box.append(paragraph("下面的合计只加总这次榜单里能够估算的产品，不是另外编造的市场规模。"));
  box.append(marketCards(listing.market));
  categoryResult.append(box);
  categoryResult.append(trendBlock(payload.trend));
  categoryResult.append(productBlock("榜单产品", listing));
  categoryResult.append(groupBlock("店铺", listing.stores, storeRow));
  categoryResult.append(groupBlock("品牌", listing.brands, brandRow));
}

function renderTree(payload) {
  const box = document.createElement("article");
  box.className = "block";
  box.append(heading(payload.cached ? "类目树（进程内缓存）" : "类目树"));
  box.append(usageLine(payload));
  if (!payload.tree?.ok) {
    box.append(note(payload.tree?.message || "类目树没有返回", true));
    categoryResult.append(box);
    return;
  }
  const tools = document.createElement("div");
  tools.className = "tree-tools";
  const filter = document.createElement("input");
  filter.type = "text";
  filter.placeholder = "在已加载的类目里筛选名称或 NodeId";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "inline-button";
  reload.textContent = "重新加载";
  reload.addEventListener("click", () => loadTree(true));
  tools.append(filter, reload);
  const browser = document.createElement("div");
  box.append(tools, browser);
  const paint = () => paintTree(browser, filter.value.trim());
  filter.addEventListener("input", paint);
  paint();
  categoryResult.append(box);
}

function paintTree(browser, filterText) {
  browser.replaceChildren();
  if (filterText) {
    const hits = treeNodes.filter((node) => {
      const haystack = `${node.name} ${node.cnName} ${node.nodeId}`.toLowerCase();
      return haystack.includes(filterText.toLowerCase());
    }).slice(0, 30);
    browser.append(paragraph(hits.length ? `显示前 ${hits.length} 条匹配，点击后查看市场。` : "已加载的类目里没有匹配。"));
    browser.append(nodeButtons(hits));
    return;
  }
  const crumbs = document.createElement("div");
  crumbs.className = "crumb";
  const root = document.createElement("button");
  root.type = "button";
  root.className = "text-button";
  root.textContent = "全部一级类目";
  root.addEventListener("click", () => {
    treeFocus = "0";
    treeCrumbs = [];
    paintTree(browser, "");
  });
  crumbs.append(root);
  for (const crumb of treeCrumbs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = crumb.label;
    button.addEventListener("click", () => {
      treeFocus = crumb.id;
      treeCrumbs = treeCrumbs.slice(0, treeCrumbs.indexOf(crumb) + 1);
      paintTree(browser, "");
    });
    crumbs.append(document.createTextNode(" / "), button);
  }
  const children = treeNodes.filter((node) => node.parentId === treeFocus);
  browser.append(crumbs);
  browser.append(paragraph(children.length ? "可以进入下一级，也可以直接查看这一级的市场。" : "这一级下面没有子类目。"));
  if (treeFocus !== "0") {
    const current = treeNodes.find((node) => node.id === treeFocus);
    if (current) browser.append(nodeButtons([current]));
  }
  browser.append(nodeButtons(children, {
    drill: true,
    onDrill: (node) => {
      treeCrumbs.push({ id: node.id, label: node.cnName || node.name || node.nodeId });
      treeFocus = node.id;
      paintTree(browser, "");
    },
  }));
}

function nodeButtons(nodes, options = {}) {
  const list = document.createElement("div");
  list.className = "level-list";
  for (const node of nodes) {
    const card = document.createElement("article");
    card.className = "match";
    const title = node.cnName || node.name || node.nodeId;
    const copy = document.createElement("div");
    copy.append(strongText(title));
    const small = document.createElement("small");
    small.textContent = `${node.name || "未返回英文名"} · NodeId ${node.nodeId}`;
    copy.append(small);
    const actions = document.createElement("div");
    actions.className = "tree-tools";
    const market = document.createElement("button");
    market.type = "button";
    market.className = "inline-button";
    market.textContent = "查看市场";
    market.addEventListener("click", () => {
      nodeInput.value = node.nodeId;
      categoryMarketForm.requestSubmit();
    });
    actions.append(market);
    if (options.drill) {
      const enter = document.createElement("button");
      enter.type = "button";
      enter.textContent = "下一级";
      enter.addEventListener("click", () => options.onDrill(node));
      actions.append(enter);
    }
    card.append(copy, actions);
    list.append(card);
  }
  return list;
}

function keywordTable(section) {
  const box = document.createElement("article");
  box.className = "block";
  box.append(heading("关键词数据"));
  if (!section?.ok) {
    box.append(note(section?.message || "没有关键词数据", true));
    return box;
  }
  if (!section.items?.length) {
    box.append(note("接口成功，但没有返回关键词。"));
    return box;
  }
  const table = document.createElement("table");
  table.append(row(["关键词", "中文", "周排名", "近30天搜索量", "近90天购买量", "竞品数", "CPC", "前3品牌", ""], true));
  for (const item of section.items) {
    const detail = document.createElement("button");
    detail.type = "button";
    detail.className = "text-button";
    detail.textContent = "详情（约 1 次）";
    detail.addEventListener("click", () => openDetail(item.keyword));
    const cell = document.createElement("td");
    cell.append(detail);
    const tr = row([
      item.keyword,
      item.keywordCNName || "—",
      formatCount(item.rank),
      formatCount(item.searchVolume),
      formatCount(item.salesVolumeOf90D),
      formatCount(item.productCount),
      formatUsd(item.cpcCents),
      item.top3Brand.join("、") || "—",
    ]);
    tr.append(cell);
    table.append(tr);
  }
  box.append(table);
  return box;
}

function productBlock(title, section) {
  const box = document.createElement("article");
  box.className = "block";
  box.append(heading(title));
  if (!section?.ok) {
    box.append(note(section?.message || "没有产品数据", true));
    return box;
  }
  const products = section.products || [];
  if (!products.length) {
    box.append(note("接口成功，但没有返回产品。"));
    return box;
  }
  const table = document.createElement("table");
  table.append(row(["产品", "品牌", "预估月销量", "预估月销售额", "成交价", "Buy Box 卖家", "店铺", "卖家数", "大类排名"], true));
  for (const product of products) {
    table.append(productRow(product));
  }
  box.append(table);
  return box;
}

function productRow(product) {
  const tr = document.createElement("tr");
  const productCell = document.createElement("td");
  const wrap = document.createElement("div");
  wrap.className = "product";
  if (product.image) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = product.image;
    img.referrerPolicy = "no-referrer";
    wrap.append(img);
  }
  const text = document.createElement("div");
  text.append(strongText(product.title || "未返回标题"));
  const asin = document.createElement("div");
  asin.className = "asin";
  asin.textContent = product.asin || "无 ASIN";
  text.append(asin);
  wrap.append(text);
  productCell.append(wrap);
  tr.append(productCell);
  const values = [
    product.brand || "—",
    product.monthlySalesUnknown ? "无法预估" : formatCount(product.monthlySales),
    formatUsd(product.monthlyRevenueCents),
    formatUsd(product.salesPriceCents),
    sellerText(product),
    product.storeName || "未返回店铺名",
    formatCount(product.sellerCount),
    formatCount(product.rank),
  ];
  for (const value of values) {
    const td = document.createElement("td");
    td.textContent = value;
    if (value !== product.brand && value !== sellerText(product) && value !== (product.storeName || "未返回店铺名")) td.className = "num";
    tr.append(td);
  }
  return tr;
}

function groupBlock(title, rows, fill) {
  const box = document.createElement("article");
  box.className = "block";
  box.append(heading(title));
  if (!rows?.length) {
    box.append(note(`这次结果里没有可汇总的${title}。`));
    return box;
  }
  const table = document.createElement("table");
  table.append(fill(null, true));
  for (const item of rows) table.append(fill(item));
  box.append(paragraph(`按本次返回的产品汇总。销量为无法预估的产品不计入销量合计。`));
  box.append(table);
  return box;
}

function storeRow(item, header = false) {
  if (header) return row(["店铺", "Buy Box 卖家", "卖家 ID", "地区", "产品数", "可估算月销量合计"], true);
  return row([
    item.storeName,
    item.seller,
    item.sellerId || "—",
    item.sellerCountry || "—",
    formatCount(item.productCount),
    item.salesKnownCount ? formatCount(item.estimatedMonthlySales) : "无法预估",
  ]);
}

function brandRow(item, header = false) {
  if (header) return row(["品牌", "产品数", "可估算月销量合计"], true);
  return row([
    item.brand,
    formatCount(item.productCount),
    item.salesKnownCount ? formatCount(item.estimatedMonthlySales) : "无法预估",
  ]);
}

function marketCards(market) {
  const cards = document.createElement("div");
  cards.className = "cards";
  cards.append(
    card("榜单产品", formatCount(market.productCount)),
    card("可估算月销量", market.estimatedMonthlySales == null ? "无法预估" : formatCount(market.estimatedMonthlySales), `${market.salesKnownCount} 个产品有销量，${market.salesUnknownCount} 个无法预估`),
    card("可估算月销售额", formatUsd(market.estimatedMonthlyRevenueCents), `${market.revenueKnownCount} 个产品有销售额`),
    card("平均成交价", formatUsd(market.averageSalesPriceCents), `${market.priceKnownCount} 个产品有成交价`),
    card("品牌", formatCount(market.brandCount), "按返回的品牌名去重"),
    card("店铺", formatCount(market.storeCount), "按返回的店铺名去重"),
    card("Buy Box 卖家", formatCount(market.sellerCount), "按返回的卖家名去重"),
  );
  return cards;
}

function trendBlock(section) {
  const box = document.createElement("article");
  box.className = "block";
  box.append(heading("类目销量趋势"));
  if (!section?.ok) {
    box.append(note(section?.message || "没有趋势数据", true));
    return box;
  }
  if (!section.points?.length) {
    box.append(note("接口成功，但没有返回趋势点。"));
    return box;
  }
  box.append(paragraph("CategoryTrend，trendIndex = 0，表示该类目 Top100 的销量趋势。"));
  box.append(trendChart(section.points));
  return box;
}

function trendChart(points) {
  const max = Math.max(...points.map((point) => point.value), 1);
  const chart = document.createElement("div");
  chart.className = "bars";
  for (const point of points) {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${Math.max(4, Math.round((point.value / max) * 120))}px`;
    bar.title = `${formatMonth(point.month)}：${formatCount(point.value)}`;
    const label = document.createElement("span");
    label.textContent = formatMonth(point.month).slice(2);
    bar.append(label);
    chart.append(bar);
  }
  return chart;
}

function categoryDetailTable(rows) {
  const table = document.createElement("table");
  table.append(row(["NodeId", "名称", "月销量", "均价原值", "均评价"], true));
  for (const rowData of rows) {
    table.append(row([
      rowData.nodeId || "—",
      rowData.name || "—",
      formatCount(rowData.monthlySales),
      formatCount(rowData.averagePriceRaw),
      formatCount(rowData.averageRatings),
    ]));
  }
  return table;
}

function usageLine(payload) {
  const line = document.createElement("p");
  line.className = "usage";
  const usage = payload.usage;
  if (!usage) {
    line.textContent = "这次没有返回消耗信息。";
    return line;
  }
  if (usage.cached) {
    line.textContent = "这次使用进程内缓存，没有向 Sorftime 计费。";
    return line;
  }
  const parts = [];
  if (typeof payload.referenceCost === "number") parts.push(`官方文档参考消耗约 ${payload.referenceCost} 次`);
  if (typeof usage.requestConsumed === "number") parts.push(`接口返回本次消耗 ${usage.requestConsumed} 次 Request`);
  else parts.push("接口没有返回本次消耗");
  if (typeof usage.requestLeft === "number") parts.push(`剩余 ${usage.requestLeft} 次`);
  line.textContent = parts.join(" · ");
  return line;
}

function card(label, value, noteText = "") {
  const el = document.createElement("article");
  el.className = "card";
  const span = document.createElement("span");
  span.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value;
  el.append(span, strong);
  if (noteText) {
    const small = document.createElement("span");
    small.textContent = noteText;
    el.append(small);
  }
  return el;
}

function row(values, header = false) {
  const tr = document.createElement("tr");
  for (const value of values) {
    const cell = document.createElement(header ? "th" : "td");
    cell.textContent = value;
    tr.append(cell);
  }
  return tr;
}

function definitionList(pairs) {
  const list = document.createElement("dl");
  list.className = "cards";
  for (const [label, value] of pairs) list.append(card(label, value));
  return list;
}

function heading(text) {
  const el = document.createElement("h2");
  el.textContent = text;
  return el;
}

function paragraph(text) {
  const el = document.createElement("p");
  el.className = "message";
  el.textContent = text;
  return el;
}

function note(text, isError = false) {
  const el = paragraph(text);
  if (isError) el.classList.add("error");
  return el;
}

function strongText(text) {
  const el = document.createElement("strong");
  el.textContent = text;
  return el;
}

function sellerText(product) {
  const country = product.sellerCountry ? `（${product.sellerCountry}）` : "";
  const channel = product.isFba ? " · FBA" : "";
  return `${product.buyboxSeller || "未返回卖家"}${country}${channel}`;
}

function formatCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatUsd(cents) {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value}%`;
}

function formatMonth(value) {
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function setLocked(locked) {
  for (const button of document.querySelectorAll("button")) {
    button.disabled = button.getAttribute("role") === "tab" ? false : locked;
  }
  for (const input of document.querySelectorAll("input")) input.disabled = locked;
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}
