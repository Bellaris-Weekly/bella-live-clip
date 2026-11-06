# 日志服务部署

实际部署配置只保存在 GitHub Actions Secret `LOG_SERVICE_CONFIG`，不提交到仓库。

Worker 和 D1 由你创建，域名由你管理。工作流只核对现有 Worker 与数据库，执行表结构迁移，再更新 Worker；不创建资源，不检查或修改自定义域名。

在 GitHub Actions 中手动运行 **Deploy diagnostic log service**，选择 `main`；之后 main 推送也会自动更新。配置未填写时自动部署跳过，手动运行报错。部署凭证需要相应 Worker 与 D1 的编辑权限。

部署成功只表示数据库迁移和 Worker 更新完成，不代表公开接口已验证。插件发布构建会静默上报正常运行、导出性能和错误；普通开发构建没有日志地址，不会上报。


## 页面和下载

部署后打开日志 Worker 域名的 `/admin/`，可按时间、来源、版本、导出方式、运行状态、级别及任务编号筛选；点击事件查看阶段耗时、当前等待与原始 JSON。“只看这次任务”会串起该操作的全部事件。页面默认最近 24 小时，可开启每 10 秒刷新。统计卡片只统计当前页，不代表数据库全量。

- `GET /admin/api/logs`：分页读取，每页默认 50 条，最多 200 条。支持 `source`、`event`、`level`、`version`、`mode`、`outcome`、`operation`、`from`、`to`、`limit`、`cursor`。时间过滤包含起止时刻；返回 `snapshot` 截止时间和 `nextCursor`，相同时间戳按来源与编号继续分页。
- `GET /admin/api/logs/download`：按相同筛选条件下载 JSONL，包含完整上下文，不限于当前页面。按 200 条批次流式读取；单次上限 5,000 条，超限返回 413，须缩小时间范围，不会静默截断。
- `HEAD /admin/api/logs/download`：下载前检查条数，返回 `X-Log-Count` 和固定截止时间 `X-Log-Snapshot`。
- `POST /v1/logs`：保持原写入契约，事件使用不同 `id`，重试保持同一个 `id`。保留 90 天日志。

页面、脚本、查询和下载接口均位于 `/admin/` 下；访问 `/admin` 会跳转到 `/admin/`。原来的 `/`、`/viewer.js`、`/api/logs` 和 `/api/logs/download` 返回 404，不保留公开读取入口。当前应用代码仍按要求不做鉴权。后续可以用 Cloudflare Access 统一保护 `/admin` 和 `/admin/*`；为用户脚本保留匿名写入的 `/v1/logs`，邮箱鉴权无需加入前端代码。

迁移 `0002_log_queries.sql` 增加排序、任务和导出方式索引，既有日志继续可查询。前端 HTML、CSS 和脚本由同一个 Worker 返回，不需要另建 Pages 或静态资源部署。

## 运行事件和性能字段

客户端通过 `context.operation.id` 关联一次操作，`operation.sequence` 是客户端序号；`received_at` 是服务端收到时间，`clientAt` 是客户端时间。导出事件包括 `export_started`、`export_progress`、`export_stalled`、`export_completed`、`export_canceled`、`export_failed`；整场使用 `recording_download_` 前缀，主动停止并保存使用 `stopped`。普通加载也记录开始和完成，预览保留独立失败事件。

`context.metrics` 提供：

- `elapsedMs` / `firstPacketMs`：处理历时和首个编码包延迟，不含选择文件保存位置。
- `stages`：每阶段完成调用次数、累计耗时和最长单次耗时；各阶段可能重叠或嵌套，不能求和解释总耗时。
- `active`：尚未结束的调用数量及最早调用已等待多久，卡住时心跳仍读取实时数据。
- `latency`：固定桶估算的 P50/P95 耗时上界，不是精确分位数。
- `counters` / `gauges`：帧数、字节数、表情与归档窗口处理量，以及缓冲当前量和峰值。
- `encoder`：编码规格和请求的硬件偏好；浏览器未提供真实硬件使用率，不据此宣称使用了硬编码。

`stageTimes` 记录操作阶段时间，包含文件选择时间；`runtime` 记录页面可见性、进度未推进时间、定时器延迟、丢弃日志计数及可用的 JS 堆数据。`throughput` 是含等待的平均处理帧率/实时倍速，不是编码器峰值；运行时使用已处理视频时长，完成时使用选区/成品时长。JS 堆与媒体缓冲不是整个浏览器或 GPU 的内存占用。

日志使用数值白名单汇总，凭据及 URL 查询参数在客户端清理，服务端再脱敏；不包含弹幕文本、图片、媒体内容或文件路径。上报不阻塞导出，每次失败最多重试一次；发送并发为 2、队列最多 32，积压心跳合并。周期为 10 秒，不按帧或媒体包发网络请求。服务端对带任务编号的日志限制同任务每分钟 12 条、同来源每分钟 600 条；旧式无任务日志沿用每来源每分钟 60 条限制。断网、页面关闭或限流可能丢日志，缺少终态不直接等于导出失败。

验证：`npm run verify` 检查客户端、真实 SQLite 查询、脱敏和部署打包；`node --test tools/tests/e2e/logs-viewer.e2e.mjs` 验证浏览器筛选、关联、分页、完整下载及移动端布局。正常导出指标同时由媒体浏览器回归验证。
