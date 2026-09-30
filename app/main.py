"""网页和定时任务在同一个进程里。"""

from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager
from datetime import date, timezone
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import Settings, load_settings
from app.db import (
    default_date_range,
    init_db,
    last_success_at,
    latest_run,
    list_products,
    list_runs,
    query_sales,
    recover_stale_runs,
)
from app.sync import start_scheduler, sync_running, trigger_sync

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_RANGE_DAYS = 800
_scheduler: BackgroundScheduler | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _scheduler
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logging.getLogger("apscheduler").setLevel(logging.WARNING)
    settings = load_settings()
    init_db(settings)
    recover_stale_runs(settings)
    _scheduler = start_scheduler()
    logger.info(
        "销量服务已启动 region=%s marketplaces=%s configured=%s",
        settings.region,
        ",".join(settings.marketplace_ids),
        settings.configured,
    )
    if settings.sync_on_startup:
        trigger_sync(settings, "startup")
    try:
        yield
    finally:
        if _scheduler is not None:
            _scheduler.shutdown(wait=False)
            _scheduler = None


app = FastAPI(title="亚马逊商品销量", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def api_no_store(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/status")
def status() -> dict[str, object]:
    settings = load_settings()
    return _status_payload(settings)


@app.get("/api/products")
def products() -> dict[str, object]:
    settings = load_settings()
    return {"products": list_products(settings)}


@app.get("/api/sales")
def sales(
    start: str | None = None,
    end: str | None = None,
    asin: str | None = None,
    sku: str | None = None,
) -> dict[str, object]:
    settings = load_settings()
    default_start, default_end = default_date_range(settings.sales_timezone)
    start_day = start or default_start
    end_day = end or default_end
    _validate_range(start_day, end_day)
    return query_sales(settings, start_day, end_day, asin, sku)


@app.get("/api/sync-runs")
def sync_runs(limit: int = Query(default=8, ge=1, le=50)) -> dict[str, object]:
    settings = load_settings()
    return {"runs": list_runs(settings, limit)}


@app.post("/api/sync")
def manual_sync() -> dict[str, object]:
    settings = load_settings()
    return trigger_sync(settings, "manual")


def main() -> None:
    import uvicorn

    settings = load_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


def _status_payload(settings: Settings) -> dict[str, object]:
    next_run_at = None
    if _scheduler is not None:
        job = _scheduler.get_job("sales-sync")
        if job is not None and job.next_run_time is not None:
            next_run_at = job.next_run_time.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "configured": settings.configured,
        "issues": list(settings.blocking_issues),
        "warnings": list(settings.warnings),
        "region": settings.region,
        "endpoint": settings.endpoint,
        "marketplace_ids": list(settings.marketplace_ids),
        "interval_hours": settings.interval_hours,
        "lookback_days": settings.lookback_days,
        "timezone": settings.sales_timezone,
        "last_success_at": last_success_at(settings),
        "next_run_at": next_run_at,
        "running": sync_running(),
        "last_run": latest_run(settings),
    }


def _validate_range(start: str, end: str) -> None:
    if not _DATE.match(start) or not _DATE.match(end):
        raise HTTPException(status_code=400, detail="日期格式应为 YYYY-MM-DD")
    try:
        start_day = date.fromisoformat(start)
        end_day = date.fromisoformat(end)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="日期无效") from exc
    if start_day > end_day:
        raise HTTPException(status_code=400, detail="开始日期不能晚于结束日期")
    if (end_day - start_day).days > MAX_RANGE_DAYS:
        raise HTTPException(status_code=400, detail=f"日期范围请不要超过 {MAX_RANGE_DAYS} 天")
