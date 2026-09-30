"""官方 Selling Partner API 客户端。

认证只用 Login with Amazon 访问令牌（x-amz-access-token）。
2023-10-02 起 SP-API 不再要求 AWS SigV4。
订单读的是 Orders API v2026-01-01 searchOrders，不抓取网站页面。
"""

from __future__ import annotations

import logging
import re
import threading
import time

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)

LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token"
ORDERS_PATH = "/orders/2026-01-01/orders"
USER_AGENT = "AmazonProduct/1.0 (Language=Python)"
SEARCH_ORDERS_RATE = 0.0056
SEARCH_ORDERS_BURST = 20
MAX_ATTEMPTS = 5
RETRYABLE_STATUS = frozenset({429, 500, 502, 503})
_TOKEN_RE = re.compile(r"Atza\|[A-Za-z0-9_\-]+")


class SpApiError(Exception):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class TokenBucket:
    """searchOrders 默认限额：每秒 0.0056 次，突发 20。"""

    def __init__(self, rate: float, capacity: int):
        self.rate = rate
        self.capacity = capacity
        self.tokens = float(capacity)
        self.updated = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                elapsed = now - self.updated
                self.updated = now
                self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                delay = (1 - self.tokens) / self.rate
            if delay >= 1:
                logger.info("等待 SP-API 速率限制 %.0f 秒", delay)
            time.sleep(delay)

    def penalize(self) -> None:
        with self._lock:
            self.tokens = 0
            self.updated = time.monotonic()


class SpApiClient:
    def __init__(self, settings: Settings):
        if not settings.endpoint:
            raise SpApiError("SP-API 区域未配置，无法发起请求")
        self._settings = settings
        self._token: str | None = None
        self._token_exp = 0.0
        self._bucket = TokenBucket(SEARCH_ORDERS_RATE, SEARCH_ORDERS_BURST)
        self._http = httpx.Client(
            timeout=httpx.Timeout(60.0, connect=15.0),
            follow_redirects=False,
        )

    def close(self) -> None:
        self._http.close()

    def search_orders(self, params: dict[str, str | int]) -> dict:
        body = self._request("GET", ORDERS_PATH, params)
        if not isinstance(body, dict) or not isinstance(body.get("orders"), list):
            raise SpApiError("SP-API 返回的订单列表无法识别")
        return body

    def _request(self, method: str, path: str, params: dict[str, str | int]) -> dict:
        auth_retried = False
        last_error = "SP-API 请求失败"
        for attempt in range(1, MAX_ATTEMPTS + 1):
            self._bucket.acquire()
            try:
                response = self._http.request(
                    method,
                    self._settings.endpoint + path,
                    params=params,
                    headers=self._headers(),
                )
            except httpx.HTTPError as exc:
                last_error = f"连接 SP-API 失败：{exc.__class__.__name__}"
                logger.warning("%s（第 %s 次）", last_error, attempt)
                if attempt == MAX_ATTEMPTS:
                    raise SpApiError(last_error) from exc
                time.sleep(min(30, 2 ** attempt))
                continue

            logger.info("SP-API %s %s -> %s", method, path, response.status_code)
            if response.status_code == 403 and not auth_retried:
                auth_retried = True
                self._token = None
                continue
            if response.status_code in RETRYABLE_STATUS and attempt < MAX_ATTEMPTS:
                self._bucket.penalize()
                delay = _retry_delay(response, attempt)
                logger.warning("SP-API HTTP %s，%.0f 秒后重试", response.status_code, delay)
                time.sleep(delay)
                continue
            if response.status_code >= 400:
                raise SpApiError(_error_message(response), response.status_code)
            try:
                payload = response.json()
            except ValueError as exc:
                raise SpApiError("SP-API 返回的不是 JSON") from exc
            if not isinstance(payload, dict):
                raise SpApiError("SP-API 返回的不是 JSON 对象")
            return payload
        raise SpApiError(last_error)

    def _headers(self) -> dict[str, str]:
        return {
            "x-amz-access-token": self._access_token(),
            "accept": "application/json",
            "user-agent": USER_AGENT,
        }

    def _access_token(self) -> str:
        now = time.time()
        if self._token and now < self._token_exp:
            return self._token
        try:
            response = self._http.post(
                LWA_TOKEN_URL,
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": self._settings.refresh_token,
                    "client_id": self._settings.lwa_client_id,
                    "client_secret": self._settings.lwa_client_secret,
                },
                headers={"content-type": "application/x-www-form-urlencoded"},
            )
        except httpx.HTTPError as exc:
            raise SpApiError(f"连接 Login with Amazon 失败：{exc.__class__.__name__}") from exc
        if response.status_code != 200:
            raise SpApiError(
                "无法换取 LWA 访问令牌：" + _error_message(response),
                response.status_code,
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise SpApiError("LWA 响应不是 JSON") from exc
        token = payload.get("access_token") if isinstance(payload, dict) else None
        if not isinstance(token, str) or not token:
            raise SpApiError("LWA 响应里没有 access_token")
        expires_in = payload.get("expires_in") if isinstance(payload, dict) else 3600
        try:
            lifetime = int(expires_in)
        except (TypeError, ValueError):
            lifetime = 3600
        self._token = token
        self._token_exp = now + max(30, lifetime - 60)
        return token


def _retry_delay(response: httpx.Response, attempt: int) -> float:
    header = response.headers.get("retry-after", "").strip()
    if header:
        try:
            return max(1.0, float(header))
        except ValueError:
            return float(min(180, 30 * attempt))
    return float(min(180, 30 * attempt))


def _error_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return f"HTTP {response.status_code}"
    if isinstance(body, dict):
        errors = body.get("errors")
        if isinstance(errors, list) and errors:
            parts: list[str] = []
            for err in errors[:3]:
                if isinstance(err, dict):
                    text = err.get("message") or err.get("code") or "未知错误"
                    parts.append(str(text))
            if parts:
                return f"HTTP {response.status_code}：" + "；".join(parts)
        description = body.get("error_description") or body.get("error")
        if description:
            return redact(f"HTTP {response.status_code}：{description}")
    return f"HTTP {response.status_code}"


def redact(text: str) -> str:
    return _TOKEN_RE.sub("[redacted]", text)[:300]
