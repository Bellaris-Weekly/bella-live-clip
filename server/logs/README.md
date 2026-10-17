# 诊断日志服务

一个 Cloudflare Worker 接收 JSON，写入一个 D1 数据库；使用 `source` 区分插件或其他项目。只有写入接口，没有公开查询、删除或管理页面。本轮只提供服务端，插件尚未自动上传错误。

## 部署配置

所有实际部署信息只放在仓库的 GitHub Actions Secret **`LOG_SERVICE_CONFIG`** 中。内容为 JSON，结构如下；示例值是假数据，需要替换，不要提交实际配置文件：

```json
{
  "cloudflare": {
    "account_id": "00000000000000000000000000000000",
    "api_token": "REPLACE_WITH_API_TOKEN"
  },
  "worker": {
    "name": "example-log-worker",
    "domain": "logs.example.com"
  },
  "database": {
    "name": "example-log-database",
    "id": "00000000-0000-0000-0000-000000000000",
    "binding": "LOGS_DB"
  }
}
```

Worker、D1 和自定义域名需要你事先在同一个 Cloudflare 账户中创建，并将域名关联到对应 Worker。可以先部署 Cloudflare 的默认示例；不需要另接 Workers Builds。数据库初始为空即可，表结构随版本迁移；Worker 的数据库绑定由部署配置设置为 `LOGS_DB`。自定义域名必须启用并完成证书配置。

API Token 限定在该账户，授予 **Workers Scripts：Edit** 和 **D1：Edit**。R2 的 S3 Access Key 不能替代此 Token。部署只读取现有域名关联，无需 DNS 编辑或 Zone 的 Workers Routes 编辑权限。查询控制台使用你的 Cloudflare 账户权限，不使用插件端管理凭据。

GitHub → Settings → Secrets and variables → Actions → Secrets，添加上述单个 Secret；无需配置同名变量或其他单项部署变量。随后 Actions → **Deploy diagnostic log service** → Run workflow，选择 `main`。以后 main 推送会自动验证并更新。

工作流先核对现有 Worker、数据库名称与 ID、自定义域名归属，再迁移数据库和更新代码；缺少资源就停止，不创建替代资源。配置未填写时，push 跳过部署，手动运行则明确失败。fork PR 只测试，不获得部署 Secret。生产更新串行运行，不取消已开始的迁移。

代码没有 `route` / `routes` 配置，保留 Cloudflare 面板管理的域名；关闭 `workers.dev` 与预览 URL，不作为自定义域名失败时的替代入口。每次部署后，发送一条 `source=log-service-smoke` 的人工测试日志，再通过 D1 管理 API 按 ID 回读，确认实际写入。测试日志保留在数据库中。工作流只输出屏蔽后的诊断，临时部署配置结束后删除；实际配置不作为 artifact 上传。

线上验证失败不代表代码回滚：此时迁移或代码可能已经生效，排查配置、域名证书和权限后重新运行工作流。部署完成仅表示服务端可用，客户端接入另行完成。

## 接口

`POST https://<自定义域名>/v1/logs`，`Content-Type: application/json`。匿名 CORS 支持 POST/OPTIONS，不接收浏览器身份凭据。以下 7 个顶层字段都必填，其他项目特有字段放入 `context`：

```json
{
  "id": "run-123-error-1",
  "source": "example-client",
  "event": "export_failed",
  "level": "error",
  "version": "1.0.0",
  "message": "Synthetic export failure",
  "context": {
    "page": "https://www.bilibili.com/video/BVexample",
    "mode": "original",
    "durationSeconds": 3600,
    "estimatedBytes": 3000000000,
    "stage": "mux"
  }
}
```

`id/source/event/version` 使用字母数字开头，后续允许字母数字和 `._:-`；version 还允许 `+`。长度上限依次为 128/64/96/64。`level` 为 error、warn 或 info。message 非空且最多 16384 个 JavaScript 字符；context 为对象，嵌套深度最多 32。整个请求体实际 UTF-8 字节数最多 65536，不信任 Content-Length。不要把完整媒体文件或全部运行对象放进日志。

相同 `(source,id)` 重试不会重复入库，也不覆盖已有记录；不同项目可以使用相同 id。客户端必须为每条事件生成稳定 ID，重试沿用。201 表示新增，200 表示此前已接收；都返回 `{ "ok": true, "duplicate": false/true }`。400 格式错误，413 过大，415 类型错误，404 路径错误，405 方法错误，503 数据库暂不可用。失败响应不回显日志内容或数据库详情。

服务端递归过滤可识别的 Cookie、Authorization、令牌、密码、API Secret、URL 访问签名；保留公开路径、内容标识、普通查询参数。不能识别所有无字段名的不透明秘密，所以客户端也应只发送明确需要的字段。服务端不主动记录请求头、IP 或 User-Agent。

接口公开可写，`source` 是分类标签而非身份认证，CORS 也不是认证；掌握地址的调用方可以构造日志。当前按内部轻量使用设计，未增加登录、告警、自动清理或速率配额。需要在 Cloudflare 查看实际用量并按运营需要调整访问策略。日志不会自动过期。

## 手动验证与查询

以下域名只是示例，替换为实际地址：

```sh
curl --fail-with-body https://logs.example.com/v1/logs \
  -H 'Content-Type: application/json' \
  --data '{"id":"manual-check-1","source":"manual-check","event":"test","level":"info","version":"1","message":"Synthetic test","context":{}}'
```

Cloudflare → D1 → 指定数据库 → Console，查询最近的记录：

```sql
SELECT received_at, source, version, event, message, context
FROM logs
ORDER BY received_at DESC
LIMIT 100;
```

按项目和错误统计（排除部署验证日志）：

```sql
SELECT source, version, event, COUNT(*) AS count
FROM logs
WHERE level = 'error' AND received_at >= '2026-01-01T00:00:00.000Z'
GROUP BY source, version, event
ORDER BY count DESC;
```

需要读完整一条时，用 source 和 id 精确查找，不在公开接口添加查询能力。数据库中 received_at 是服务端 UTC 时间，context 是 JSON 文本。

## 本地开发

Node.js 22.13+，仓库内安装锁定依赖。`server/logs/wrangler.json` 只含虚构的本地数据库标识，不可直接用于线上部署。

```sh
npm ci
npm run logs:check
npx wrangler d1 migrations apply LOGS_DB --local --config server/logs/wrangler.json --persist-to .local/log-service-state
npx wrangler dev --local --config server/logs/wrangler.json --persist-to .local/log-service-state
```

本地接口默认位于 `http://localhost:8787/v1/logs`。将前面的 curl 改为此地址即可测试。运行 `npm test` 验证运行时和部署预检；`npm run verify` 执行仓库完整验证。线上更新只使用 `npm run logs:deploy`，它从环境读取单个 Secret，不在命令行参数传令牌，不提供创建资源的命令。

参考：[Wrangler 配置与面板路由管理](https://developers.cloudflare.com/workers/wrangler/configuration/)、[Worker 域名读取权限](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)。
