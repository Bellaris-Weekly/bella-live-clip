# bella-live-clip

## 开发约定

- 自有代码位于 `src/`；元数据统一维护在 `src/header.txt`，不要直接修改生成的 userscript。
- 修改后运行 `npm run verify`，同时提交源码与根目录 `bella-live-clip.user.js`。
- 发布版本同步更新元数据、package.json、package-lock.json 与 README 的当前版本。
- 优先修复问题所属类别；回归测试覆盖至少一个不同的同类样本。
- 保留第三方许可声明，依赖版本固定；不得移除打包产物内的许可证注释。
- 不提交 Cookie、令牌、签名媒体链接、.env、下载视频或本地测试产物。
- 删除文件使用 trash。

## 发布

GitHub Actions 在 push / 外部 PR 时验证；main 通过后同步到 R2。
R2 四项凭据仅配置到 GitHub Secrets。未配置时跳过上传，可配置后手动运行工作流。

## 提交

标题采用英文轻量 Conventional Commits；正文用中文说明变化与验证。
