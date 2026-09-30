"""定时与手动抓取。同一时间只跑一个任务。"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.background import BackgroundScheduler

from app.config import MIN_INTERVAL_HOURS, Settings, load_settings
from app.db import (
    apply_parsed_orders,
    finish_run,
    get_cursor,
    record_finished_run,
    save_success,
    start_run,
    utc_now,
)
from app.orders import extract_order
from app.sp_api import SpApiClient, SpApiError

logger = logging.getLogger(__name__)

JOB_ID = "sales-sync"
MAX_PAGES = 500
CLOCK_SKEW = timedelta(minutes=3)
CURSOR_OVERLAP = timedelta(minutes=2)
INCLUDED_DATA = "PROCEEDS,FULFILLMENT"

_run_lock = threading.Lock()


def sync_running() -> bool:
    return _run_lock.locked()


def start_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(
        _scheduled_sync,
        "interval",
        minutes=_interval_minutes(load_settings()),
        id=JOB_ID,
        max_instances=1,
        coalesce=True,
        replace_existing=True,
    )
    scheduler.start()
    return scheduler


def trigger_sync(settings: Settings, trigger: str, *, background: bool = True) -> dict[str, object]:
    if not settings.configured:
        message = "未配置，已跳过：" + "；".join(settings.blocking_issues)
        record_finished_run(settings, trigger=trigger, status="skipped", message=message)
        return {
            "started": False,
            "reason": "not_configured",
            "message": message,
            "missing": list(settings.blocking_issues),
        }
    if not _run_lock.acquire(blocking=False):
        return {
            "started": False,
            "reason": "already_running",
            "message": "已有抓取任务在运行",
            "missing": [],
        }
    if background:
        threading.Thread(
            target=_run_locked,
            args=(settings, trigger),
            name=f"sales-sync-{trigger}",
            daemon=True,
        ).start()
        return {"started": True, "reason": "started", "message": "已开始抓取", "missing": []}
    try:
        execute_sync(settings, trigger)
    finally:
        _run_lock.release()
    return {"started": True, "reason": "finished", "message": "抓取已结束", "missing": []}


def execute_sync(settings: Settings, trigger: str, client: SpApiClient | None = None) -> None:
    started_at = utc_now()
    run_id = start_run(settings, trigger, started_at)
    orders_seen = 0
    items_written = 0
    owns_client = False
    api = client
    try:
        if api is None:
            api = SpApiClient(settings)
            owns_client = True
        params = build_query(settings, get_cursor(settings))
        cursor = params.get("createdBefore") or params.get("lastUpdatedBefore")
        for page in range(1, MAX_PAGES + 1):
            body = api.search_orders(params)
            orders = body["orders"]
            orders_seen += len(orders)
            parsed = []
            for order in orders:
                extracted = extract_order(
                    order,
                    settings.marketplace_ids[0],
                    settings.sales_timezone,
                )
                if extracted is not None:
                    parsed.append(extracted)
            items_written += apply_parsed_orders(settings, parsed)
            reported = body.get("lastUpdatedBefore") or body.get("createdBefore")
            if isinstance(reported, str) and reported.strip():
                cursor = reported.strip()
            token = _next_token(body)
            if not token:
                break
            if page == MAX_PAGES:
                raise SpApiError("分页次数超过上限，已停止")
            params = dict(params)
            params["paginationToken"] = token
        finished_at = utc_now()
        save_success(settings, str(cursor) if cursor else None, finished_at)
        finish_run(
            settings,
            run_id,
            status="success",
            finished_at=finished_at,
            message=f"已同步 {orders_seen} 个订单，写入 {items_written} 条商品行。",
            orders_seen=orders_seen,
            items_upserted=items_written,
        )
        logger.info("抓取完成 trigger=%s orders=%s items=%s", trigger, orders_seen, items_written)
    except Exception as exc:
        logger.exception("抓取失败 trigger=%s", trigger)
        finish_run(
            settings,
            run_id,
            status="error",
            finished_at=utc_now(),
            message=_failure_message(exc),
            orders_seen=orders_seen,
            items_upserted=items_written,
        )
    finally:
        if owns_client and api is not None:
            api.close()


def build_query(settings: Settings, cursor_at: str | None, *, now: datetime | None = None) -> dict[str, str | int]:
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    end = moment.astimezone(timezone.utc) - CLOCK_SKEW
    common: dict[str, str | int] = {
        "marketplaceIds": ",".join(settings.marketplace_ids),
        "includedData": INCLUDED_DATA,
        "maxResultsPerPage": 100,
    }
    if cursor_at:
        start = _parse_utc(cursor_at) - CURSOR_OVERLAP
        common["lastUpdatedAfter"] = _iso(start)
        common["lastUpdatedBefore"] = _iso(end)
        return common
    start = end - timedelta(days=settings.lookback_days)
    common["createdAfter"] = _iso(start)
    common["createdBefore"] = _iso(end)
    return common


def _scheduled_sync() -> None:
    settings = load_settings()
    result = trigger_sync(settings, "schedule")
    if not result["started"]:
        logger.info("定时抓取未启动：%s", result["message"])


def _run_locked(settings: Settings, trigger: str) -> None:
    try:
        execute_sync(settings, trigger)
    finally:
        _run_lock.release()


def _interval_minutes(settings: Settings) -> int:
    hours = max(settings.interval_hours, MIN_INTERVAL_HOURS)
    return max(15, round(hours * 60))


def _next_token(body: dict) -> str:
    pagination = body.get("pagination")
    if not isinstance(pagination, dict):
        return ""
    token = pagination.get("nextToken")
    if not isinstance(token, str):
        return ""
    return token.strip()


def _parse_utc(value: str) -> datetime:
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _failure_message(exc: Exception) -> str:
    if isinstance(exc, SpApiError):
        return str(exc)[:500]
    return f"抓取失败：{exc.__class__.__name__}"
