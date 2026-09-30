const REGION_NAME = { na: "北美", eu: "欧洲", fe: "远东" };
const TRIGGER_NAME = { schedule: "定时", manual: "手动", startup: "启动" };
const STATUS_NAME = {
  success: "成功",
  error: "失败",
  skipped: "已跳过",
  running: "进行中",
};

const startInput = document.querySelector("#start-date");
const endInput = document.querySelector("#end-date");
const productSelect = document.querySelector("#product-select");
const filterForm = document.querySelector("#filter-form");
const syncButton = document.querySelector("#sync-button");
const banner = document.querySelector("#banner");
const topMeta = document.querySelector("#top-meta");
const kpis = document.querySelector("#kpis");
const chart = document.querySelector("#chart");
const chartNote = document.querySelector("#chart-note");
const productTable = document.querySelector("#product-table");
const dailyTable = document.querySelector("#daily-table");
const runsEl = document.querySelector("#runs");

let products = [];
let pollTimer = null;
let wasRunning = false;
let timezoneName = "UTC";

filterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadSales().catch(showError);
});

syncButton.addEventListener("click", async () => {
  syncButton.disabled = true;
  try {
    const result = await api("/api/sync", { method: "POST" });
    if (!result.started) {
      showBanner(result.message || "没有开始抓取", "warn");
    }
    await refreshLive();
  } catch (error) {
    showError(error);
  } finally {
    syncButton.disabled = wasRunning;
  }
});

boot().catch(showError);

async function boot() {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 29);
  startInput.value = isoDate(start);
  endInput.value = isoDate(today);
  await Promise.all([refreshLive(), loadProducts(), loadSales(), loadRuns()]);
}

async function refreshLive() {
  const status = await api("/api/status");
  renderStatus(status);
  const finished = wasRunning && !status.running;
  wasRunning = status.running;
  syncButton.disabled = status.running;
  syncButton.textContent = status.running ? "正在抓取…" : "立即抓取";
  if (finished) {
    await Promise.all([loadProducts(), loadSales(), loadRuns()]);
  } else {
    await loadRuns();
  }
  if (status.running && !pollTimer) {
    pollTimer = setInterval(() => {
      refreshLive().catch(showError);
    }, 2000);
  }
  if (!status.running && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function loadProducts() {
  const selected = productSelect.value;
  const body = await api("/api/products");
  products = body.products || [];
  const options = ['<option value="">全部商品</option>'];
  products.forEach((product) => {
    const value = productKey(product);
    const label = productLabel(product);
    options.push(`<option value="${esc(value)}">${esc(label)}</option>`);
  });
  productSelect.innerHTML = options.join("");
  if ([...productSelect.options].some((option) => option.value === selected)) {
    productSelect.value = selected;
  }
}

async function loadSales() {
  const params = new URLSearchParams({
    start: startInput.value,
    end: endInput.value,
  });
  const selected = selectedProduct();
  if (selected) {
    params.set("asin", selected.asin);
    params.set("sku", selected.sku);
  }
  const body = await api(`/api/sales?${params.toString()}`);
  timezoneName = body.timezone || timezoneName;
  renderSales(body);
}

async function loadRuns() {
  const body = await api("/api/sync-runs");
  renderRuns(body.runs || []);
}

function renderStatus(status) {
  const region = REGION_NAME[status.region] || status.region || "";
  const markets = (status.marketplace_ids || []).join("、");
  const success = status.last_success_at ? formatTime(status.last_success_at) : "尚未成功抓取";
  const next = status.next_run_at ? formatTime(status.next_run_at) : "未排程";
  topMeta.innerHTML = [
    `${esc(region)} · ${esc(markets)}`,
    `上次成功抓取：${esc(success)}`,
    `下次定时抓取：${esc(next)}（每 ${esc(String(status.interval_hours))} 小时）`,
  ].join("<br>");

  if (!status.configured) {
    const items = (status.issues || []).map((issue) => `<li>${esc(issue)}</li>`).join("");
    banner.hidden = false;
    banner.className = "banner warn";
    banner.innerHTML = `<h2>凭证还没配齐，页面可以打开</h2>
      <p>服务已启动，销量保持为空，不会填入虚构数字。把下面的环境变量写进 <code>.env</code> 后，再点「立即抓取」。</p>
      <ul>${items}</ul>`;
    return;
  }
  if (status.running) {
    showBanner("正在从 Selling Partner API 拉取订单…", "ok");
    return;
  }
  const last = status.last_run;
  if (last && last.status === "error") {
    showBanner(`最近一次抓取失败：${last.message || ""}`, "bad");
    return;
  }
  if (!status.last_success_at) {
    showBanner("凭证已配置。还没有成功抓取，可以点「立即抓取」，或等待定时任务。", "ok");
    return;
  }
  if (status.warnings && status.warnings.length) {
    showBanner(status.warnings.join(" "), "warn");
    return;
  }
  banner.hidden = true;
  banner.innerHTML = "";
}

function renderSales(body) {
  const totals = body.totals || {};
  const synced = Boolean(body.has_sync);
  const showNumbers = synced || (totals.units || 0) > 0;
  const units = showNumbers ? formatUnits(totals.units || 0) : "—";
  const orders = showNumbers ? formatUnits(totals.orders || 0) : "—";
  const revenue = showNumbers ? formatRevenueList(totals.revenue_by_currency) : "—";
  const missing = totals.missing_revenue_units || 0;
  const missingNote = showNumbers && missing
    ? `另有 ${formatUnits(missing)} 件还没有货款明细`
    : "";
  kpis.innerHTML = `
    <article class="kpi"><span>销量（件）</span><strong>${esc(units)}</strong></article>
    <article class="kpi"><span>商品销售额</span><strong>${esc(revenue)}</strong>${missingNote ? `<em>${esc(missingNote)}</em>` : ""}</article>
    <article class="kpi"><span>订单数</span><strong>${esc(orders)}</strong></article>`;

  const series = body.series || [];
  if (!series.length) {
    chart.innerHTML = `<p class="empty">${synced ? "这个日期范围内没有已保存的订单。" : "还没有销量。配置凭证并抓取成功后，这里才会出现数字。"}</p>`;
    chartNote.textContent = synced
      ? `日期按 ${body.timezone} 归日。没有订单的日期不会画成 0。`
      : "未成功抓取之前，不显示占位销量。";
  } else {
    chartNote.textContent = chartCaption(series, body.timezone);
    chart.innerHTML = renderChart(series);
  }
  productTable.innerHTML = renderProductTable(body.by_product || []);
  dailyTable.innerHTML = renderDailyTable(series);
}

function renderChart(series) {
  const width = Math.max(640, series.length * 36);
  const height = 220;
  const pad = { top: 16, right: 12, bottom: 48, left: 36 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const maxUnits = Math.max(...series.map((point) => point.units), 1);
  const slot = innerW / series.length;
  const singleCurrency = sharedCurrency(series);
  const revenues = singleCurrency
    ? series.map((point) => Number((point.revenue_by_currency[0] || {}).amount || 0))
    : [];
  const maxRevenue = singleCurrency ? Math.max(...revenues, 1) : 1;
  const bars = series.map((point, index) => {
    const barH = (point.units / maxUnits) * innerH;
    const x = pad.left + index * slot + slot * 0.2;
    const y = pad.top + innerH - barH;
    const w = slot * 0.6;
    const label = index % labelStep(series.length) === 0 ? point.date.slice(5) : "";
    return `<g>
      <title>${esc(point.date)}：${esc(String(point.units))} 件</title>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barH.toFixed(1)}" rx="4" fill="#2f6f56"></rect>
      <text x="${(x + w / 2).toFixed(1)}" y="${height - 18}" text-anchor="middle" font-size="11" fill="#5c6b63">${esc(label)}</text>
    </g>`;
  }).join("");
  let line = "";
  if (singleCurrency) {
    const coords = revenues.map((amount, index) => {
      const x = pad.left + index * slot + slot * 0.5;
      const y = pad.top + innerH - (amount / maxRevenue) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    line = `<polyline fill="none" stroke="#c46a2c" stroke-width="2" points="${coords.join(" ")}"></polyline>`;
  }
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="每日销量柱状图">
    <line x1="${pad.left}" y1="${pad.top + innerH}" x2="${width - pad.right}" y2="${pad.top + innerH}" stroke="#d5e0d8"></line>
    ${bars}
    ${line}
  </svg>`;
}

function renderProductTable(rows) {
  if (!rows.length) {
    return `<p class="empty">没有商品行。</p>`;
  }
  const body = rows.map((row) => `<tr>
    <td class="title-cell">${esc(row.title || "（无标题）")}</td>
    <td>${esc(row.asin || "—")}</td>
    <td>${esc(row.sku || "—")}</td>
    <td class="num">${esc(formatUnits(row.units))}</td>
    <td class="num">${esc(formatRevenueList(row.revenue_by_currency))}</td>
  </tr>`).join("");
  return `<table>
    <thead><tr><th>商品</th><th>ASIN</th><th>SKU</th><th class="num">件数</th><th class="num">商品销售额</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderDailyTable(series) {
  if (!series.length) {
    return `<p class="empty">没有按日数据。</p>`;
  }
  const body = series.map((point) => `<tr>
    <td>${esc(point.date)}</td>
    <td class="num">${esc(formatUnits(point.units))}</td>
    <td class="num">${esc(formatRevenueList(point.revenue_by_currency))}</td>
  </tr>`).join("");
  return `<table>
    <thead><tr><th>日期</th><th class="num">件数</th><th class="num">商品销售额</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderRuns(runs) {
  if (!runs.length) {
    runsEl.innerHTML = `<p class="empty">还没有抓取记录。定时任务会按间隔运行，也可以手动抓取。</p>`;
    return;
  }
  const body = runs.map((run) => `<tr>
    <td>${esc(formatTime(run.finished_at || run.started_at))}</td>
    <td>${esc(TRIGGER_NAME[run.trigger] || run.trigger)}</td>
    <td>${esc(STATUS_NAME[run.status] || run.status)}</td>
    <td class="num">${esc(String(run.orders_seen))}</td>
    <td class="num">${esc(String(run.items_upserted))}</td>
    <td>${esc(run.message || "")}</td>
  </tr>`).join("");
  runsEl.innerHTML = `<table>
    <thead><tr><th>时间</th><th>来源</th><th>状态</th><th class="num">订单</th><th class="num">商品行</th><th>说明</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function chartCaption(series, timezone) {
  const currency = sharedCurrency(series);
  const base = `柱形是件数。日期按 ${timezone} 归日。`;
  if (currency) {
    return `${base} 折线是商品销售额（${currency}）。`;
  }
  return `${base} 存在多种币种或缺少货款时，不把金额画成一条线。`;
}

function sharedCurrency(series) {
  let currency = null;
  for (const point of series) {
    const monies = point.revenue_by_currency || [];
    if ((point.missing_revenue_units || 0) > 0 || monies.length !== 1) {
      return null;
    }
    if (currency === null) {
      currency = monies[0].currency;
    } else if (currency !== monies[0].currency) {
      return null;
    }
  }
  return currency;
}

function selectedProduct() {
  const value = productSelect.value;
  if (!value) {
    return null;
  }
  const sep = value.indexOf("|");
  return {
    asin: decodeURIComponent(value.slice(0, sep)),
    sku: decodeURIComponent(value.slice(sep + 1)),
  };
}

function productKey(product) {
  return `${encodeURIComponent(product.asin || "")}|${encodeURIComponent(product.sku || "")}`;
}

function productLabel(product) {
  const name = product.title || "（无标题）";
  const ids = [product.asin, product.sku].filter(Boolean).join(" / ");
  return ids ? `${name}（${ids}）` : name;
}

function formatRevenueList(entries) {
  if (!entries || !entries.length) {
    return "—";
  }
  return entries.map((entry) => formatMoney(entry.amount, entry.currency)).join(" · ");
}

function formatMoney(amount, currency) {
  const value = Number(amount);
  if (!currency || Number.isNaN(value)) {
    return amount == null ? "—" : String(amount);
  }
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch (_error) {
    return `${amount} ${currency}`;
  }
}

function formatUnits(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function formatTime(iso) {
  if (!iso) {
    return "—";
  }
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  }).format(moment);
}

function isoDate(moment) {
  const month = String(moment.getMonth() + 1).padStart(2, "0");
  const day = String(moment.getDate()).padStart(2, "0");
  return `${moment.getFullYear()}-${month}-${day}`;
}

function labelStep(count) {
  if (count <= 12) return 1;
  if (count <= 31) return 2;
  return Math.ceil(count / 12);
}

function showBanner(message, kind) {
  banner.hidden = false;
  banner.className = `banner ${kind}`;
  banner.textContent = message;
}

function showError(error) {
  showBanner(error instanceof Error ? error.message : "请求失败", "bad");
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.detail || data.message || "请求失败";
    throw new Error(typeof message === "string" ? message : "请求失败");
  }
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}
