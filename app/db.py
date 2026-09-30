"""SQLite 存储。页面只读这里，两次抓取之间也能打开。"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterator

from app.config import Settings
from app.orders import ParsedOrder, local_date

_db_lock = threading.Lock()
_ready: set[str] = set()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS order_items (
    amazon_order_id TEXT NOT NULL,
    order_item_id TEXT NOT NULL,
    marketplace_id TEXT NOT NULL,
    asin TEXT NOT NULL DEFAULT '',
    sku TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL,
    revenue_amount TEXT,
    currency_code TEXT,
    purchase_at TEXT NOT NULL,
    purchase_date TEXT NOT NULL,
    fulfillment_status TEXT NOT NULL,
    PRIMARY KEY (amazon_order_id, order_item_id)
);

CREATE INDEX IF NOT EXISTS idx_order_items_purchase_date
    ON order_items (purchase_date);

CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    message TEXT,
    orders_seen INTEGER NOT NULL DEFAULT 0,
    items_upserted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_state (
    marketplace_key TEXT PRIMARY KEY,
    cursor_at TEXT,
    last_success_at TEXT
);

CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

_CENT = Decimal("0.01")


def init_db(settings: Settings) -> None:
    settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    conn = _connect(settings.database_path)
    try:
        conn.executescript(_SCHEMA)
        _align_timezone(conn, settings.sales_timezone)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    _ready.add(str(settings.database_path))


def recover_stale_runs(settings: Settings) -> None:
    """上次进程若在抓取中退出，把残留的 running 记成失败。"""
    with connection(settings) as conn:
        _mark_stale_runs(conn)


@contextmanager
def connection(settings: Settings) -> Iterator[sqlite3.Connection]:
    if str(settings.database_path) not in _ready:
        init_db(settings)
    with _db_lock:
        conn = _connect(settings.database_path)
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def apply_parsed_orders(settings: Settings, orders: list[ParsedOrder]) -> int:
    written = 0
    with connection(settings) as conn:
        for order in orders:
            conn.execute(
                "DELETE FROM order_items WHERE amazon_order_id = ?",
                (order.order_id,),
            )
            for line in order.lines:
                conn.execute(
                    """
                    INSERT INTO order_items (
                        amazon_order_id, order_item_id, marketplace_id, asin, sku, title,
                        quantity, revenue_amount, currency_code, purchase_at, purchase_date,
                        fulfillment_status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        line.order_id,
                        line.order_item_id,
                        line.marketplace_id,
                        line.asin,
                        line.sku,
                        line.title,
                        line.quantity,
                        line.revenue_amount,
                        line.currency_code,
                        line.purchase_at,
                        line.purchase_date,
                        line.fulfillment_status,
                    ),
                )
                written += 1
    return written


def list_products(settings: Settings) -> list[dict[str, str]]:
    with connection(settings) as conn:
        rows = conn.execute(
            """
            SELECT o.asin, o.sku, o.title
            FROM order_items AS o
            JOIN (
                SELECT asin, sku, MAX(purchase_at) AS purchase_at
                FROM order_items
                GROUP BY asin, sku
            ) AS latest
              ON latest.asin = o.asin
             AND latest.sku = o.sku
             AND latest.purchase_at = o.purchase_at
            GROUP BY o.asin, o.sku
            ORDER BY o.title, o.asin, o.sku
            """
        ).fetchall()
    return [{"asin": row["asin"], "sku": row["sku"], "title": row["title"]} for row in rows]


def query_sales(
    settings: Settings,
    start: str,
    end: str,
    asin: str | None,
    sku: str | None,
) -> dict[str, object]:
    clauses = ["purchase_date >= ?", "purchase_date <= ?"]
    params: list[object] = [start, end]
    if asin is not None or sku is not None:
        clauses.append("asin = ?")
        clauses.append("sku = ?")
        params.extend([asin or "", sku or ""])
    where = " AND ".join(clauses)
    with connection(settings) as conn:
        rows = conn.execute(
            f"""
            SELECT purchase_date, asin, sku, title, quantity, revenue_amount,
                   currency_code, amazon_order_id
            FROM order_items
            WHERE {where}
            ORDER BY purchase_date, asin, sku
            """,
            params,
        ).fetchall()
        has_sync = _last_success_at(conn, settings.marketplace_key) is not None

    return _aggregate(rows, has_sync=has_sync, timezone_name=settings.sales_timezone, start=start, end=end)


def last_success_at(settings: Settings) -> str | None:
    with connection(settings) as conn:
        return _last_success_at(conn, settings.marketplace_key)


def get_cursor(settings: Settings) -> str | None:
    with connection(settings) as conn:
        row = conn.execute(
            "SELECT cursor_at FROM sync_state WHERE marketplace_key = ?",
            (settings.marketplace_key,),
        ).fetchone()
    if row is None:
        return None
    return row["cursor_at"]


def save_success(settings: Settings, cursor_at: str | None, finished_at: str) -> None:
    with connection(settings) as conn:
        conn.execute(
            """
            INSERT INTO sync_state (marketplace_key, cursor_at, last_success_at)
            VALUES (?, ?, ?)
            ON CONFLICT(marketplace_key) DO UPDATE SET
                cursor_at = excluded.cursor_at,
                last_success_at = excluded.last_success_at
            """,
            (settings.marketplace_key, cursor_at, finished_at),
        )


def start_run(settings: Settings, trigger: str, started_at: str) -> int:
    with connection(settings) as conn:
        cursor = conn.execute(
            """
            INSERT INTO sync_runs (trigger, status, started_at, message, orders_seen, items_upserted)
            VALUES (?, 'running', ?, '', 0, 0)
            """,
            (trigger, started_at),
        )
        return int(cursor.lastrowid)


def finish_run(
    settings: Settings,
    run_id: int,
    *,
    status: str,
    finished_at: str,
    message: str,
    orders_seen: int,
    items_upserted: int,
) -> None:
    with connection(settings) as conn:
        conn.execute(
            """
            UPDATE sync_runs
               SET status = ?, finished_at = ?, message = ?, orders_seen = ?, items_upserted = ?
             WHERE id = ?
            """,
            (status, finished_at, message, orders_seen, items_upserted, run_id),
        )


def record_finished_run(
    settings: Settings,
    *,
    trigger: str,
    status: str,
    message: str,
) -> None:
    now = utc_now()
    with connection(settings) as conn:
        conn.execute(
            """
            INSERT INTO sync_runs (
                trigger, status, started_at, finished_at, message, orders_seen, items_upserted
            ) VALUES (?, ?, ?, ?, ?, 0, 0)
            """,
            (trigger, status, now, now, message),
        )


def list_runs(settings: Settings, limit: int = 8) -> list[dict[str, object]]:
    with connection(settings) as conn:
        rows = conn.execute(
            """
            SELECT id, trigger, status, started_at, finished_at, message, orders_seen, items_upserted
            FROM sync_runs
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [_run_dict(row) for row in rows]


def latest_run(settings: Settings) -> dict[str, object] | None:
    runs = list_runs(settings, limit=1)
    if not runs:
        return None
    return runs[0]


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _aggregate(
    rows: list[sqlite3.Row],
    *,
    has_sync: bool,
    timezone_name: str,
    start: str,
    end: str,
) -> dict[str, object]:
    day_units: dict[str, int] = {}
    day_money: dict[str, dict[str, Decimal]] = {}
    day_missing: dict[str, int] = {}
    product_units: dict[tuple[str, str], int] = {}
    product_money: dict[tuple[str, str], dict[str, Decimal]] = {}
    product_title: dict[tuple[str, str], str] = {}
    product_missing: dict[tuple[str, str], int] = {}
    orders: set[str] = set()
    total_units = 0
    missing_units = 0
    currency_totals: dict[str, Decimal] = {}

    for row in rows:
        quantity = int(row["quantity"])
        total_units += quantity
        orders.add(row["amazon_order_id"])
        day = row["purchase_date"]
        day_units[day] = day_units.get(day, 0) + quantity
        key = (row["asin"], row["sku"])
        product_units[key] = product_units.get(key, 0) + quantity
        product_title[key] = row["title"]
        amount = _money(row["revenue_amount"])
        currency = row["currency_code"]
        if amount is None or not currency:
            missing_units += quantity
            day_missing[day] = day_missing.get(day, 0) + quantity
            product_missing[key] = product_missing.get(key, 0) + quantity
            continue
        day_money.setdefault(day, {})
        day_money[day][currency] = day_money[day].get(currency, Decimal("0")) + amount
        product_money.setdefault(key, {})
        product_money[key][currency] = product_money[key].get(currency, Decimal("0")) + amount
        currency_totals[currency] = currency_totals.get(currency, Decimal("0")) + amount

    series = [
        {
            "date": day,
            "units": day_units[day],
            "revenue_by_currency": _money_list(day_money.get(day, {})),
            "missing_revenue_units": day_missing.get(day, 0),
        }
        for day in sorted(day_units)
    ]
    by_product = [
        {
            "asin": asin,
            "sku": sku,
            "title": product_title[(asin, sku)],
            "units": product_units[(asin, sku)],
            "revenue_by_currency": _money_list(product_money.get((asin, sku), {})),
            "missing_revenue_units": product_missing.get((asin, sku), 0),
        }
        for asin, sku in sorted(product_units, key=lambda item: (-product_units[item], item[0], item[1]))
    ]
    return {
        "timezone": timezone_name,
        "start": start,
        "end": end,
        "has_sync": has_sync,
        "series": series,
        "by_product": by_product,
        "totals": {
            "units": total_units,
            "orders": len(orders),
            "revenue_by_currency": _money_list(currency_totals),
            "missing_revenue_units": missing_units,
        },
    }


def _money_list(amounts: dict[str, Decimal]) -> list[dict[str, str]]:
    return [
        {"currency": currency, "amount": _format_money(amounts[currency])}
        for currency in sorted(amounts)
    ]


def _format_money(amount: Decimal) -> str:
    quantized = amount.quantize(_CENT, rounding=ROUND_HALF_UP)
    return f"{quantized:.2f}"


def _money(value: object) -> Decimal | None:
    if value is None or value == "":
        return None
    return Decimal(str(value))


def _last_success_at(conn: sqlite3.Connection, marketplace_key: str) -> str | None:
    row = conn.execute(
        "SELECT last_success_at FROM sync_state WHERE marketplace_key = ?",
        (marketplace_key,),
    ).fetchone()
    if row is None:
        return None
    return row["last_success_at"]


def _run_dict(row: sqlite3.Row) -> dict[str, object]:
    return {
        "id": row["id"],
        "trigger": row["trigger"],
        "status": row["status"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "message": row["message"],
        "orders_seen": row["orders_seen"],
        "items_upserted": row["items_upserted"],
    }


def _mark_stale_runs(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        UPDATE sync_runs
           SET status = 'error',
               finished_at = COALESCE(finished_at, ?),
               message = '进程在抓取过程中停止'
         WHERE status = 'running'
        """,
        (utc_now(),),
    )


def _align_timezone(conn: sqlite3.Connection, sales_timezone: str) -> None:
    row = conn.execute("SELECT value FROM app_meta WHERE key = 'sales_timezone'").fetchone()
    current = row["value"] if row else None
    if current == sales_timezone:
        return
    rows = conn.execute("SELECT rowid, purchase_at FROM order_items").fetchall()
    for item in rows:
        purchase_date = local_date(str(item["purchase_at"]), sales_timezone)
        if purchase_date is None:
            continue
        conn.execute(
            "UPDATE order_items SET purchase_date = ? WHERE rowid = ?",
            (purchase_date, item["rowid"]),
        )
    conn.execute(
        """
        INSERT INTO app_meta (key, value) VALUES ('sales_timezone', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (sales_timezone,),
    )


def _connect(path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def default_date_range(sales_timezone: str, *, today: datetime | None = None) -> tuple[str, str]:
    from zoneinfo import ZoneInfo

    moment = today or datetime.now(timezone.utc)
    local_today = moment.astimezone(ZoneInfo(sales_timezone)).date()
    start = local_today - timedelta(days=29)
    return start.isoformat(), local_today.isoformat()
