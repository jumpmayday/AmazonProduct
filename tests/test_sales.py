from datetime import datetime, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.db import query_sales
from app.main import app
from app.orders import extract_order, item_product_revenue, local_date
from app.sync import _run_lock, build_query, execute_sync, trigger_sync


@pytest.fixture(autouse=True)
def isolated_env(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "sales.db"))
    monkeypatch.setenv("SYNC_ON_STARTUP", "false")
    monkeypatch.setenv("SALES_TIMEZONE", "UTC")
    monkeypatch.setenv("SP_API_REGION", "na")
    monkeypatch.setenv("SP_API_MARKETPLACE_IDS", "ATVPDKIKX0DER")
    monkeypatch.setenv("SYNC_INTERVAL_HOURS", "6")
    monkeypatch.setenv("SYNC_LOOKBACK_DAYS", "30")
    for name in ("LWA_CLIENT_ID", "LWA_CLIENT_SECRET", "SP_API_REFRESH_TOKEN"):
        monkeypatch.delenv(name, raising=False)


def test_revenue_uses_item_minus_discount_and_ignores_shipping():
    amount, currency = item_product_revenue(
        {
            "proceeds": {
                "breakdowns": [
                    {"type": "ITEM", "subtotal": {"amount": "25.00", "currencyCode": "USD"}},
                    {"type": "DISCOUNT", "subtotal": {"amount": "3.00", "currencyCode": "USD"}},
                    {"type": "SHIPPING", "subtotal": {"amount": "5.00", "currencyCode": "USD"}},
                    {"type": "TAX", "subtotal": {"amount": "1.10", "currencyCode": "USD"}},
                ]
            }
        }
    )
    assert amount == Decimal("22.00")
    assert currency == "USD"


def test_missing_proceeds_does_not_invent_revenue():
    amount, currency = item_product_revenue({"product": {"price": {"unitPrice": {"amount": "9.99", "currencyCode": "USD"}}}})
    assert amount is None
    assert currency is None


def test_local_date_uses_sales_timezone():
    assert local_date("2026-01-02T02:00:00Z", "America/Los_Angeles") == "2026-01-01"
    assert local_date("2026-01-02T02:00:00Z", "UTC") == "2026-01-02"


def test_cancelled_order_is_marked_excluded():
    parsed = extract_order(
        {"orderId": "ORDER-1", "fulfillment": {"fulfillmentStatus": "CANCELLED"}},
        "ATVPDKIKX0DER",
        "UTC",
    )
    assert parsed is not None
    assert parsed.excluded is True
    assert parsed.lines == ()


def test_build_query_lookback_then_cursor():
    settings = load_settings()
    moment = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)
    first = build_query(settings, None, now=moment)
    assert first["createdAfter"] == "2026-08-31T11:57:00Z"
    assert first["createdBefore"] == "2026-09-30T11:57:00Z"
    assert first["includedData"] == "PROCEEDS,FULFILLMENT"
    assert "lastUpdatedAfter" not in first

    nxt = build_query(settings, "2026-09-01T00:00:00Z", now=moment)
    assert nxt["lastUpdatedAfter"] == "2026-08-31T23:58:00Z"
    assert nxt["lastUpdatedBefore"] == "2026-09-30T11:57:00Z"
    assert "createdAfter" not in nxt


def test_sync_persists_sales_and_filters_products():
    settings = _configured()
    client = _Client([_page(), _second_page()])
    execute_sync(settings, "manual", client=client)

    assert client.calls[1]["paginationToken"] == "NEXT"
    assert client.calls[1]["createdAfter"] == client.calls[0]["createdAfter"]
    body = query_sales(settings, "2024-12-01", "2024-12-31", None, None)
    assert body["has_sync"] is True
    assert body["totals"]["units"] == 4
    assert body["totals"]["orders"] == 1
    assert body["totals"]["revenue_by_currency"] == [{"currency": "USD", "amount": "32.00"}]
    assert body["totals"]["missing_revenue_units"] == 1

    filtered = query_sales(settings, "2024-12-01", "2024-12-31", "B0TEST0001", "SKU-1")
    assert filtered["totals"]["units"] == 2
    assert filtered["by_product"][0]["title"] == "夹具水杯"
    assert filtered["series"][0]["date"] == "2024-12-25"

    other_day = query_sales(settings, "2024-12-01", "2024-12-24", None, None)
    assert other_day["totals"]["units"] == 0
    assert other_day["series"] == []


def test_cancelled_follow_up_removes_saved_lines():
    settings = _configured()
    execute_sync(settings, "manual", client=_Client([_page(next_token="")]))
    execute_sync(
        settings,
        "schedule",
        client=_Client(
            [
                {
                    "orders": [
                        {
                            "orderId": "TEST-ORDER-1",
                            "createdTime": "2024-12-25T10:30:00Z",
                            "fulfillment": {"fulfillmentStatus": "CANCELLED"},
                            "orderItems": [],
                        }
                    ],
                    "lastUpdatedBefore": "2024-12-26T00:00:00Z",
                }
            ]
        ),
    )
    body = query_sales(settings, "2024-12-01", "2024-12-31", None, None)
    assert body["totals"]["units"] == 0
    assert body["has_sync"] is True


def test_app_starts_without_credentials_and_manual_sync_skips():
    with TestClient(app) as client:
        status = client.get("/api/status").json()
        assert status["configured"] is False
        assert status["last_success_at"] is None
        assert status["next_run_at"]
        assert any("SP_API_REFRESH_TOKEN" in issue for issue in status["issues"])

        sales = client.get("/api/sales").json()
        assert sales["has_sync"] is False
        assert sales["series"] == []
        assert sales["totals"]["units"] == 0
        assert sales["totals"]["revenue_by_currency"] == []

        sync = client.post("/api/sync").json()
        assert sync["started"] is False
        assert sync["reason"] == "not_configured"

        runs = client.get("/api/sync-runs").json()["runs"]
        assert runs[0]["trigger"] == "manual"
        assert runs[0]["status"] == "skipped"
        assert runs[0]["items_upserted"] == 0

        page = client.get("/")
        assert page.status_code == 200
        assert "立即抓取" in page.text
        assert "亚马逊商品销量" in page.text
        assert "99.99" not in page.text

        products = client.get("/api/products").json()
        assert products["products"] == []

        invalid = client.get("/api/sales", params={"start": "2024-13-01", "end": "2024-12-31"})
        assert invalid.status_code == 400


def test_saved_sales_are_visible_through_the_api():
    settings = _configured()
    execute_sync(settings, "manual", client=_Client([_page(next_token="")]))
    with TestClient(app) as client:
        body = client.get(
            "/api/sales",
            params={"start": "2024-12-01", "end": "2024-12-31", "asin": "B0TEST0001", "sku": "SKU-1"},
        ).json()
        assert body["totals"]["units"] == 2
        assert body["totals"]["revenue_by_currency"][0]["amount"] == "22.00"
        status = client.get("/api/status").json()
        assert status["configured"] is True
        assert status["last_success_at"]


def test_trigger_sync_refuses_a_second_runner():
    settings = _configured()
    assert _run_lock.acquire(blocking=False)
    try:
        result = trigger_sync(settings, "manual")
    finally:
        _run_lock.release()
    assert result["started"] is False
    assert result["reason"] == "already_running"


def test_failed_sync_does_not_mark_success():
    settings = _configured()

    class Boom:
        def search_orders(self, params):
            raise RuntimeError("network down")

        def close(self):
            return None

    execute_sync(settings, "manual", client=Boom())
    body = query_sales(settings, "2024-12-01", "2024-12-31", None, None)
    assert body["has_sync"] is False
    assert body["totals"]["units"] == 0


def test_repo_does_not_commit_secrets():
    root = load_settings.__globals__["ROOT"]
    gitignore = (root / ".gitignore").read_text(encoding="utf-8")
    assert ".env" in gitignore
    example = (root / ".env.example").read_text(encoding="utf-8")
    assert "SP_API_REFRESH_TOKEN=" in example
    assert "Atza|" not in example
    for path in (root / "app").glob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "Atza|" not in text
        assert "AKIA" not in text


class _Client:
    def __init__(self, pages):
        self.pages = list(pages)
        self.calls = []

    def search_orders(self, params):
        self.calls.append(dict(params))
        return self.pages.pop(0)

    def close(self):
        return None


def _configured():
    import os

    os.environ["LWA_CLIENT_ID"] = "client-id"
    os.environ["LWA_CLIENT_SECRET"] = "client-secret"
    os.environ["SP_API_REFRESH_TOKEN"] = "refresh-token"
    return load_settings()


def _page(next_token="NEXT"):
    body = {
        "orders": [
            {
                "orderId": "TEST-ORDER-1",
                "createdTime": "2024-12-25T10:30:00Z",
                "salesChannel": {"marketplaceId": "ATVPDKIKX0DER", "marketplaceName": "Amazon.com"},
                "fulfillment": {"fulfillmentStatus": "SHIPPED"},
                "orderItems": [
                    {
                        "orderItemId": "ITEM-1",
                        "quantityOrdered": 2,
                        "product": {"asin": "B0TEST0001", "sellerSku": "SKU-1", "title": "夹具水杯"},
                        "proceeds": {
                            "breakdowns": [
                                {"type": "ITEM", "subtotal": {"amount": "25.00", "currencyCode": "USD"}},
                                {"type": "DISCOUNT", "subtotal": {"amount": "3.00", "currencyCode": "USD"}},
                                {"type": "SHIPPING", "subtotal": {"amount": "5.00", "currencyCode": "USD"}},
                            ]
                        },
                    },
                    {
                        "orderItemId": "ITEM-2",
                        "quantityOrdered": 1,
                        "product": {"asin": "B0TEST0002", "sellerSku": "SKU-2", "title": "夹具壶"},
                        "proceeds": {
                            "breakdowns": [
                                {"type": "ITEM", "subtotal": {"amount": "10.00", "currencyCode": "USD"}}
                            ]
                        },
                    },
                    {
                        "orderItemId": "ITEM-3",
                        "quantityOrdered": 1,
                        "product": {"asin": "B0TEST0003", "sellerSku": "SKU-3", "title": "待处理夹具"},
                    },
                ],
            }
        ],
        "lastUpdatedBefore": "2024-12-25T15:00:00Z",
    }
    if next_token:
        body["pagination"] = {"nextToken": next_token}
    return body


def _second_page():
    return {"orders": [], "lastUpdatedBefore": "2024-12-25T15:00:00Z"}
