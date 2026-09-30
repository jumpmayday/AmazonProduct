"""从环境变量读取配置。密钥只存在于进程环境中，不写进仓库。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent

REGIONS = {
    "na": "https://sellingpartnerapi-na.amazon.com",
    "eu": "https://sellingpartnerapi-eu.amazon.com",
    "fe": "https://sellingpartnerapi-fe.amazon.com",
}

DEFAULT_MARKETPLACE_ID = "ATVPDKIKX0DER"
DEFAULT_INTERVAL_HOURS = 6.0
MIN_INTERVAL_HOURS = 0.25
DEFAULT_LOOKBACK_DAYS = 30
MAX_LOOKBACK_DAYS = 730
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000

_TRUTHY = {"1", "true", "yes", "on"}

load_dotenv(ROOT / ".env", override=False)


@dataclass(frozen=True)
class Settings:
    lwa_client_id: str
    lwa_client_secret: str
    refresh_token: str
    region: str
    endpoint: str
    marketplace_ids: tuple[str, ...]
    interval_hours: float
    lookback_days: int
    database_path: Path
    sales_timezone: str
    host: str
    port: int
    sync_on_startup: bool
    blocking_issues: tuple[str, ...]
    warnings: tuple[str, ...]

    @property
    def configured(self) -> bool:
        return not self.blocking_issues

    @property
    def marketplace_key(self) -> str:
        return ",".join(self.marketplace_ids)


def load_settings() -> Settings:
    issues: list[str] = []
    warnings: list[str] = []

    client_id = _text("LWA_CLIENT_ID")
    client_secret = _text("LWA_CLIENT_SECRET")
    refresh_token = _text("SP_API_REFRESH_TOKEN")
    if not client_id:
        issues.append("缺少 LWA_CLIENT_ID（Login with Amazon 客户端 ID）")
    if not client_secret:
        issues.append("缺少 LWA_CLIENT_SECRET（Login with Amazon 客户端密钥）")
    if not refresh_token:
        issues.append("缺少 SP_API_REFRESH_TOKEN（卖家自授权刷新令牌）")

    region = _text("SP_API_REGION").lower() or "na"
    endpoint = REGIONS.get(region, "")
    if region not in REGIONS:
        issues.append("SP_API_REGION 只能是 na、eu 或 fe")

    marketplaces = tuple(
        part.strip()
        for part in (_text("SP_API_MARKETPLACE_IDS") or DEFAULT_MARKETPLACE_ID).split(",")
        if part.strip()
    )
    if not marketplaces:
        issues.append("SP_API_MARKETPLACE_IDS 至少要有一个 Marketplace ID")

    interval = _positive_float("SYNC_INTERVAL_HOURS", DEFAULT_INTERVAL_HOURS, warnings)
    if interval < MIN_INTERVAL_HOURS:
        warnings.append(
            f"SYNC_INTERVAL_HOURS={interval:g} 过小，定时任务按 {MIN_INTERVAL_HOURS:g} 小时（15 分钟）执行"
        )
        interval = MIN_INTERVAL_HOURS

    lookback = _positive_int("SYNC_LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS, warnings)
    if lookback > MAX_LOOKBACK_DAYS:
        warnings.append(
            f"SYNC_LOOKBACK_DAYS={lookback} 超过订单接口约两年的保留期，已按 {MAX_LOOKBACK_DAYS} 天回看"
        )
        lookback = MAX_LOOKBACK_DAYS

    timezone_name = _text("SALES_TIMEZONE") or "UTC"
    try:
        ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        issues.append(
            f"SALES_TIMEZONE={timezone_name} 不是有效的 IANA 时区，例如 Asia/Shanghai 或 America/Los_Angeles"
        )
        timezone_name = "UTC"

    host = _text("HOST") or DEFAULT_HOST
    port = _port(warnings)
    database_path = _database_path()
    sync_on_startup = _text("SYNC_ON_STARTUP").lower() in _TRUTHY

    return Settings(
        lwa_client_id=client_id,
        lwa_client_secret=client_secret,
        refresh_token=refresh_token,
        region=region,
        endpoint=endpoint,
        marketplace_ids=marketplaces,
        interval_hours=interval,
        lookback_days=lookback,
        database_path=database_path,
        sales_timezone=timezone_name,
        host=host,
        port=port,
        sync_on_startup=sync_on_startup,
        blocking_issues=tuple(issues),
        warnings=tuple(warnings),
    )


def _text(name: str) -> str:
    return os.environ.get(name, "").strip()


def _positive_float(name: str, default: float, warnings: list[str]) -> float:
    raw = _text(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        warnings.append(f"{name}={raw} 不是数字，已改用 {default:g}")
        return default
    if value <= 0:
        warnings.append(f"{name} 需要大于 0，已改用 {default:g}")
        return default
    return value


def _positive_int(name: str, default: int, warnings: list[str]) -> int:
    raw = _text(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        warnings.append(f"{name}={raw} 不是整数，已改用 {default}")
        return default
    if value <= 0:
        warnings.append(f"{name} 需要大于 0，已改用 {default}")
        return default
    return value


def _port(warnings: list[str]) -> int:
    raw = _text("PORT")
    if not raw:
        return DEFAULT_PORT
    try:
        value = int(raw)
    except ValueError:
        warnings.append(f"PORT={raw} 不是整数，已改用 {DEFAULT_PORT}")
        return DEFAULT_PORT
    if value < 1 or value > 65535:
        warnings.append(f"PORT={value} 超出范围，已改用 {DEFAULT_PORT}")
        return DEFAULT_PORT
    return value


def _database_path() -> Path:
    raw = _text("DATABASE_PATH") or "data/sales.db"
    path = Path(raw)
    if not path.is_absolute():
        path = ROOT / path
    return path
