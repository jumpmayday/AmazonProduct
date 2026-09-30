import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";

/** 与官方 sorftime-cli `src/lib/api.ts` 相同的 HTTP 入口。美国站 domain 固定为 1。 */
export const SORFTIME_API_BASE = "https://cli.sorftime.com/api/";
export const US_DOMAIN = "1";
export const ACCOUNT_SK_ENV = "SORFTIME_ACCOUNT_SK";

const DEFAULT_TIMEOUT_MS = 60_000;

export class SorftimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "SorftimeError";
    this.status = 502;
  }
}

export function readAccountSk(env = process.env) {
  const value = env[ACCOUNT_SK_ENV];
  return typeof value === "string" ? value.trim() : "";
}

export function createSorftimeClient({
  accountSk,
  fetchImpl = fetch,
  baseUrl = SORFTIME_API_BASE,
  domain = US_DOMAIN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const configured = Boolean(accountSk);
  return {
    configured,
    async call(endpoint, params = {}, options = {}) {
      if (!configured) {
        throw new SorftimeError("未配置 SORFTIME_ACCOUNT_SK");
      }
      assertEndpoint(endpoint);
      const url = new URL(endpoint, baseUrl);
      url.searchParams.set("domain", domain);
      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `BasicAuth ${accountSk}`,
            Browser: "Cli",
          },
          body: JSON.stringify(params ?? {}),
          signal: AbortSignal.timeout(options.timeoutMs ?? timeoutMs),
        });
      } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") {
          throw new SorftimeError("Sorftime 请求超时");
        }
        throw new SorftimeError("无法连接 Sorftime");
      }
      const text = await response.text();
      const decoded = decodeResponse(text);
      return normalizeEnvelope(decoded, response.status);
    },
  };
}

export function decodeResponse(data) {
  if (typeof data !== "string") return data;
  const decompressed = decompressBase64(data);
  if (decompressed != null) return decompressed;
  return parseJsonOrRaw(data);
}

export function normalizeEnvelope(body, httpStatus = 200) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return emptyEnvelope(httpStatus);
  }
  const lowered = {};
  for (const [key, value] of Object.entries(body)) {
    lowered[String(key).toLowerCase().trim()] = value;
  }
  const code = Number(lowered.code);
  return {
    ok: httpStatus >= 200 && httpStatus < 300 && code === 0,
    httpStatus,
    code: Number.isFinite(code) ? code : Number.NaN,
    message: typeof lowered.message === "string" ? lowered.message : "",
    data: lowered.data === undefined ? null : lowered.data,
    requestLeft: finiteOrNull(lowered.requestleft),
    requestConsumed: finiteOrNull(lowered.requestconsumed),
  };
}

function assertEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !/^[A-Za-z][A-Za-z0-9]{1,80}$/.test(endpoint)) {
    throw new SorftimeError("接口名称不正确");
  }
}

function decompressBase64(data) {
  const trimmed = data.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
  let buffer;
  try {
    buffer = Buffer.from(trimmed, "base64");
  } catch {
    return null;
  }
  if (buffer.length === 0) return null;
  const decompressed = tryDecompress(buffer);
  if (!decompressed) return null;
  const text = new TextDecoder("utf-8").decode(decompressed).trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  return parseJsonOrRaw(text);
}

function tryDecompress(buffer) {
  const attempts = [gunzipSync, inflateSync, inflateRawSync];
  for (const decompress of attempts) {
    try {
      return decompress(buffer);
    } catch {
      // 官方客户端会依次尝试 gzip、zlib 和 raw deflate。
    }
  }
  return null;
}

function parseJsonOrRaw(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function emptyEnvelope(httpStatus) {
  return {
    ok: false,
    httpStatus,
    code: Number.NaN,
    message: "",
    data: null,
    requestLeft: null,
    requestConsumed: null,
  };
}

function finiteOrNull(value) {
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
