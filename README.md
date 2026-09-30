# 美亚查询

给一个人用的亚马逊美国站查询页。没有账号，没有登录，也不会定时刷新。

你可以：

- 按关键词查看搜索数据、预估销量、竞品和店铺
- 按类目名称搜索，或在类目树里点选，查看该类目的榜单和市场

市场上的数字全部来自 [Sorftime 官方 HTTP API](https://www.sorftime.com/zh-CN/api)。调用方式和开源的 [Sorftime CLI](https://www.sorftime.com/cli) 一致：服务端向 `https://cli.sorftime.com/api/{接口名}?domain=1` 发 `POST`，请求头为 `Authorization: BasicAuth <Account-SK>`。`domain=1` 表示美国站。

不登录 Sorftime 网站，也不抓取亚马逊页面。

## 本地运行

需要 Node.js 20 或更高版本。

```bash
git clone https://github.com/jumpmayday/AmazonProduct.git
cd AmazonProduct
export SORFTIME_ACCOUNT_SK=你的Account-SK
npm start
```

浏览器打开 <http://localhost:3000>。

换端口：

```bash
PORT=8080 npm start
```

Account-SK 在 Sorftime 后台获取，和 CLI 共用同一把密钥。只放在环境变量里。不要写进代码，不要提交到 Git。仓库里的 `.env.example` 只是空模板。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `SORFTIME_ACCOUNT_SK` | Sorftime Account-SK。没有它时程序仍会启动。 |
| `PORT` | 可选。默认 `3000`。 |

没有 `SORFTIME_ACCOUNT_SK` 时：

- 页面会说明要配置哪一个变量、怎样启动
- 查询按钮不可用
- 服务端不会向 Sorftime 发请求
- 不会显示编造的销量、关键词或市场规模

## 调用是按次计费的

Sorftime 按请求次数计费。本应用只有你点击时才请求，没有后台轮询。

页面上的「约 N 次」来自官方接口文档，真正扣减以接口返回的 `requestConsumed` 为准，页面会同时显示剩余次数 `requestLeft`。

| 你点的按钮 | 官方接口 | 文档中的参考消耗 |
| --- | --- | --- |
| 查询关键词 | `KeywordQuery` + `KeywordSearchResults` | 5 + 5 |
| 关键词详情 | `KeywordRequest` | 1 |
| 搜索类目 | `CategorySearchFromName` | 1 |
| 查看市场 | `CategoryRequest` + `CategoryTrend`（销量趋势，trendIndex=0） | 5 + 2 |
| 加载类目树 | `CategoryTree` | 5 |

类目树成功后缓存在这次进程的内存里。再次点击「加载类目树」不会重复扣费。点「重新加载」才会再请求一次。进程退出后缓存消失。

接口返回「暂无数据」、密钥被拒绝，或销量字段为「无法预估」时，页面只说明原因，不会补一个数字。

## 测试

```bash
npm test
```

测试使用本地假的 Sorftime 响应，不会访问真实接口，也不会消耗 Request。

## 不做的事

评论、定时刷新、多用户和登录都不在这个应用里。
