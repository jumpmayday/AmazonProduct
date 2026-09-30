# 亚马逊商品销量

一个本地网页。它按设定的间隔调用亚马逊官方 **Selling Partner API（SP-API）**，读取**卖家自己授权账号**的订单，把件数和商品销售额存进 SQLite，并在浏览器里按日期、按商品查看。

网页和定时任务在同一个进程里。没有配齐凭证时，服务照样启动：页面说明缺什么，销量表保持为空，不会填入虚构数字。

## 环境

- Python 3.11 或更新版本
- 能访问 `api.amazon.com` 和对应区域的 `sellingpartnerapi-*.amazon.com`

## 本地运行

在仓库根目录执行：

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python -m app
```

浏览器打开 <http://127.0.0.1:8000>。

默认只监听 `127.0.0.1`。订单数据留在本机的 `data/sales.db`（已写入 `.gitignore`）。

改完 `.env` 后重新启动进程。定时任务会按启动时读到的间隔运行；凭证在每次抓取时重新读取。

## 页面上能做什么

- 按日期范围、按商品查看件数和商品销售额
- 看到上次成功抓取的时间，以及下一次定时抓取的时间
- 点「立即抓取」马上拉一次。若当时已有任务在跑，这次不会并行再开一条

定时抓取默认每 **6 小时**一次，进程启动后先等到间隔结束才跑第一轮。若希望启动后立刻拉一次，把 `SYNC_ON_STARTUP=true`。

## 配置官方 SP-API

本应用只调用官方 Orders API `v2026-01-01` 的 `searchOrders`，读取你自己店铺的订单。它不抓取亚马逊网站页面，也不使用第三方爬虫。

自 2023-10-02 起，SP-API 不再要求 AWS IAM 或 SigV4 签名。请求只带 Login with Amazon 换到的访问令牌。说明见 [SP-API 不再要求 AWS IAM 或 SigV4](https://developer-docs.amazon.com/sp-api/changelog/sp-api-will-no-longer-require-aws-iam-or-aws-signature-version-4)。

建议按私有应用来接自己的卖家账号：

1. 用卖家账号登录 [Solution Provider Portal](https://solutionproviderportal.amazon.com/)，注册开发者并创建一个 **私有应用**。登记步骤见 [注册应用](https://developer-docs.amazon.com/sp-api/docs/registering-your-application)。
2. 为应用勾选 Orders API 可用的角色。卖家自用、又不需要买家姓名、邮箱和地址时，选 **Inventory and Order Tracking（库存和订单跟踪）** 即可。本应用不会请求 `BUYER` 或 `RECIPIENT` 数据集。
3. 在应用里对自己的卖家账号做自授权，保存刷新令牌。步骤见 [私有应用自授权](https://developer-docs.amazon.com/sp-api/docs/self-authorization)。刷新令牌通常只显示一次。
4. 在应用详情里复制 LWA Client ID 和 LWA Client Secret。
5. 确认区域和站点，写入 `.env`。Marketplace ID 列表见 [Marketplace IDs](https://developer-docs.amazon.com/sp-api/docs/marketplace-ids)。订单接口说明见 [Orders API](https://developer-docs.amazon.com/sp-api/docs/orders-api)。

| 区域 | `SP_API_REGION` | 端点 | 常见站点 |
| --- | --- | --- | --- |
| 北美 | `na` | `sellingpartnerapi-na.amazon.com` | 美国 `ATVPDKIKX0DER`、加拿大 `A2EUQ1WTGCTBG2`、墨西哥 `A1AM78C64UM0Y8` |
| 欧洲 | `eu` | `sellingpartnerapi-eu.amazon.com` | 英国 `A1F83G8C2ARO7P`、德国 `A1PA6795UKMFR9`、法国 `A13V1IB3VIYZZH`、意大利 `APJ6JRA9NG5V4`、西班牙 `A1RKKUPIHCS9HS` |
| 远东 | `fe` | `sellingpartnerapi-fe.amazon.com` | 日本 `A1VC38T7YXB528`、澳大利亚 `A39IBJ37TRP1C6`、新加坡 `A19VAU5U5O7RUS` |

多个站点用英文逗号分隔，例如 `SP_API_MARKETPLACE_IDS=ATVPDKIKX0DER,A2EUQ1WTGCTBG2`。这些站点必须属于同一个区域。

刷新令牌等同于店铺授权。只放在 `.env` 或部署环境的环境变量里，不要提交到 Git，也不要贴到聊天记录。

## 环境变量

| 变量 | 必填 | 默认 | 作用 |
| --- | --- | --- | --- |
| `LWA_CLIENT_ID` | 是 | 空 | LWA 客户端 ID |
| `LWA_CLIENT_SECRET` | 是 | 空 | LWA 客户端密钥 |
| `SP_API_REFRESH_TOKEN` | 是 | 空 | 自授权刷新令牌 |
| `SP_API_REGION` | 否 | `na` | `na`、`eu` 或 `fe` |
| `SP_API_MARKETPLACE_IDS` | 否 | `ATVPDKIKX0DER` | 逗号分隔的 Marketplace ID |
| `SYNC_INTERVAL_HOURS` | 否 | `6` | 定时抓取间隔（小时）。小于 0.25 时按 15 分钟执行 |
| `SYNC_LOOKBACK_DAYS` | 否 | `30` | 第一次抓取向前回看的天数，最大 730 |
| `SYNC_ON_STARTUP` | 否 | `false` | `true` 时启动后立刻抓一次 |
| `DATABASE_PATH` | 否 | `data/sales.db` | SQLite 文件。相对路径相对仓库根目录 |
| `SALES_TIMEZONE` | 否 | `UTC` | 下单时间归日用的 IANA 时区，如 `Asia/Shanghai`、`America/Los_Angeles` |
| `HOST` | 否 | `127.0.0.1` | 监听地址 |
| `PORT` | 否 | `8000` | 监听端口 |

模板见 `.env.example`。

## 数据口径

每次抓取调用：

`GET /orders/2026-01-01/orders?includedData=PROCEEDS,FULFILLMENT`

- **件数**：`orderItems[].quantityOrdered`
- **商品销售额**：`proceeds.breakdowns` 里 `type=ITEM` 的货款，减去 `type=DISCOUNT`。不含运费、税费和礼品包装
- 待处理订单有时还没有货款明细。件数仍会计入，金额留空，页面会标出「还没有货款明细」，不会用标价去乘
- **不计入**履约状态为 `CANCELLED`（已取消）或 `UNFULFILLABLE`（无法配送）的订单。之后若订单被取消，下一次抓取会把已保存的商品行删掉
- 订单接口不返回大约两年以前的订单
- `searchOrders` 的默认限额大约是每秒 0.0056 次、突发 20 次。订单很多时，翻页会按这个限额等待

第一次抓取用 `createdAfter` / `createdBefore` 回看 `SYNC_LOOKBACK_DAYS`。成功之后用响应里的更新时间做增量，并重叠 2 分钟，避免漏掉边界上的更新。要重新回看更长区间，先停掉进程，删除 `data/sales.db`，把 `SYNC_LOOKBACK_DAYS` 调大后再启动。

本地只保存订单号、订单行号、站点、ASIN、SKU、标题、件数、商品销售额、币种、下单时间和履约状态。

## 测试

```bash
pip install -r requirements-dev.txt
pytest
```

测试使用夹具响应，不会访问亚马逊，也不会往页面里写入演示销量。
