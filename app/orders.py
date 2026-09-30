"""把 Orders API v2026-01-01 的订单解析成可入库的商品行。

商品销售额取 proceeds 里 type=ITEM 的货款，再减去 type=DISCOUNT。
运费、税费、礼品包装不计入。没有货款明细时不估算金额。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

EXCLUDED_STATUSES = frozenset({"CANCELLED", "UNFULFILLABLE"})
_MONEY_KINDS = frozenset({"ITEM", "DISCOUNT"})


@dataclass(frozen=True)
class SalesLine:
    order_id: str
    order_item_id: str
    marketplace_id: str
    asin: str
    sku: str
    title: str
    quantity: int
    revenue_amount: str | None
    currency_code: str | None
    purchase_at: str
    purchase_date: str
    fulfillment_status: str


@dataclass(frozen=True)
class ParsedOrder:
    order_id: str
    excluded: bool
    lines: tuple[SalesLine, ...]


def extract_order(order: dict, fallback_marketplace: str, sales_timezone: str) -> ParsedOrder | None:
    if not isinstance(order, dict):
        return None
    order_id = str(order.get("orderId") or "").strip()
    if not order_id:
        return None

    fulfillment = order.get("fulfillment") if isinstance(order.get("fulfillment"), dict) else {}
    status = str(fulfillment.get("fulfillmentStatus") or "UNKNOWN").strip().upper() or "UNKNOWN"
    if status in EXCLUDED_STATUSES:
        return ParsedOrder(order_id=order_id, excluded=True, lines=())

    created = str(order.get("createdTime") or "").strip()
    purchase_date = local_date(created, sales_timezone)
    if purchase_date is None:
        return None

    channel = order.get("salesChannel") if isinstance(order.get("salesChannel"), dict) else {}
    marketplace_id = str(channel.get("marketplaceId") or fallback_marketplace).strip() or fallback_marketplace

    lines: list[SalesLine] = []
    items = order.get("orderItems")
    if not isinstance(items, list):
        items = []
    for item in items:
        line = _line(
            item,
            order_id=order_id,
            marketplace_id=marketplace_id,
            purchase_at=created,
            purchase_date=purchase_date,
            status=status,
        )
        if line is not None:
            lines.append(line)
    return ParsedOrder(order_id=order_id, excluded=False, lines=tuple(lines))


def item_product_revenue(item: dict) -> tuple[Decimal | None, str | None]:
    """返回 (商品销售额, 币种)。缺少 ITEM 货款时金额为 None。"""
    proceeds = item.get("proceeds") if isinstance(item.get("proceeds"), dict) else {}
    breakdowns = proceeds.get("breakdowns")
    if not isinstance(breakdowns, list):
        return None, None

    item_total = Decimal("0")
    discount_total = Decimal("0")
    currency: str | None = None
    saw_item = False
    for row in breakdowns:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("type") or "").upper()
        if kind not in _MONEY_KINDS:
            continue
        money = row.get("subtotal") if isinstance(row.get("subtotal"), dict) else {}
        amount = _decimal(money.get("amount"))
        if amount is None:
            continue
        code = str(money.get("currencyCode") or "").strip() or None
        if currency is None:
            currency = code
        elif code and currency and code != currency:
            return None, None
        if kind == "ITEM":
            saw_item = True
            item_total += amount
        else:
            discount_total += amount if amount < 0 else -amount
    if not saw_item:
        return None, currency
    return item_total + discount_total, currency


def local_date(iso_timestamp: str, sales_timezone: str) -> str | None:
    text = iso_timestamp.strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        moment = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    try:
        zone = ZoneInfo(sales_timezone)
    except ZoneInfoNotFoundError:
        zone = ZoneInfo("UTC")
    return moment.astimezone(zone).date().isoformat()


def _line(
    item: object,
    *,
    order_id: str,
    marketplace_id: str,
    purchase_at: str,
    purchase_date: str,
    status: str,
) -> SalesLine | None:
    if not isinstance(item, dict):
        return None
    order_item_id = str(item.get("orderItemId") or "").strip()
    quantity = _quantity(item.get("quantityOrdered"))
    if not order_item_id or quantity is None or quantity <= 0:
        return None
    product = item.get("product") if isinstance(item.get("product"), dict) else {}
    revenue, currency = item_product_revenue(item)
    return SalesLine(
        order_id=order_id,
        order_item_id=order_item_id,
        marketplace_id=marketplace_id,
        asin=str(product.get("asin") or "").strip()[:20],
        sku=str(product.get("sellerSku") or "").strip()[:200],
        title=str(product.get("title") or "").strip()[:500],
        quantity=quantity,
        revenue_amount=format(revenue, "f") if revenue is not None else None,
        currency_code=currency,
        purchase_at=purchase_at,
        purchase_date=purchase_date,
        fulfillment_status=status,
    )


def _quantity(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _decimal(value: object) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
