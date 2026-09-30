import { createServer } from "./server.js";
import { createSorftimeClient, readAccountSk } from "./sorftime.js";
import { createTreeCache } from "./present.js";

const client = createSorftimeClient({ accountSk: readAccountSk() });
const port = Number(process.env.PORT || 3000);
const server = createServer({ client, treeCache: createTreeCache() });

server.listen(port, () => {
  console.log(`美亚查询已启动：http://localhost:${port}`);
  if (client.configured) {
    console.log("已读取 SORFTIME_ACCOUNT_SK。查询会按 Sorftime 实际用量计费。");
  } else {
    console.log("未配置 SORFTIME_ACCOUNT_SK。页面可以打开，不会请求 Sorftime，也不会显示编造数据。");
  }
});
