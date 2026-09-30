import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError, categoryMarket, categoryTree, keywordDetail, searchCategories, searchKeywords, statusPayload } from "./present.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const BODY_LIMIT = 16_384;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createServer({ client, publicDir = PUBLIC_DIR, treeCache }) {
  const cache = treeCache ?? { entry: null };
  return createHttpServer(async (req, res) => {
    try {
      await route(req, res, { client, publicDir, cache });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "服务暂时不可用";
      if (!(error instanceof HttpError)) console.error(error);
      sendJson(res, status, { ok: false, error: message });
    }
  });
}

async function route(req, res, context) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, statusPayload(context.client));
    return;
  }
  if (req.method === "GET" && (url.pathname === "/favicon.ico")) {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    await postApi(req, res, url.pathname, context);
    return;
  }
  if (req.method === "GET") {
    await serveStatic(res, context.publicDir, url.pathname);
    return;
  }
  throw new HttpError(405, "不支持的请求方法");
}

async function postApi(req, res, pathname, context) {
  const body = await readJson(req);
  const handlers = {
    "/api/keywords/search": () => searchKeywords(context.client, body),
    "/api/keywords/detail": () => keywordDetail(context.client, body),
    "/api/categories/search": () => searchCategories(context.client, body),
    "/api/categories/market": () => categoryMarket(context.client, body),
    "/api/categories/tree": () => categoryTree(context.client, context.cache, body),
  };
  const handler = handlers[pathname];
  if (!handler) throw new HttpError(404, "没有这个接口");
  sendJson(res, 200, await handler());
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "请求格式不正确");
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "请求格式不正确");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function serveStatic(res, publicDir, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolvePublic(publicDir, requested);
  if (!filePath) throw new HttpError(404, "没有这个页面");
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new HttpError(404, "没有这个页面");
  }
  if (!fileStat.isFile()) throw new HttpError(404, "没有这个页面");
  const type = MIME[path.extname(filePath)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  createReadStream(filePath).pipe(res);
}

function resolvePublic(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^[/\\]+/, "");
  const full = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(`${rootResolved}${path.sep}`)) return null;
  return full;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}
