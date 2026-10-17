# 日志服务部署

实际部署配置只保存在 GitHub Actions Secret `LOG_SERVICE_CONFIG`，不提交到仓库。

Worker 和 D1 由你创建，域名由你管理。工作流只核对现有 Worker 与数据库，执行表结构迁移，再更新 Worker；不创建资源，不检查或修改自定义域名。

在 GitHub Actions 中手动运行 **Deploy diagnostic log service**，选择 `main`；之后 main 推送也会自动更新。配置未填写时自动部署跳过，手动运行报错。部署凭证需要相应 Worker 与 D1 的编辑权限。

部署成功只表示数据库迁移和 Worker 更新完成，不代表公开接口已验证。插件发布构建已接入静默错误上报。
