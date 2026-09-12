# 第三方许可

bella-live-clip 自有源码采用 MIT（见 LICENSE）。生成的用户脚本还包含以下依赖，保留其各自许可证：

| 依赖 | 版本 | 许可证 | 原始源码 |
| --- | --- | --- | --- |
| Mediabunny | 1.56.1 | MPL-2.0 | https://www.npmjs.com/package/mediabunny/v/1.56.1 |
| hls.js | 1.6.16 | Apache-2.0 | https://www.npmjs.com/package/hls.js/v/1.6.16 |

完整许可证存放于 licenses 目录，构建保留依赖内联版权声明。依赖源码未作修改；可通过上表对应版本 npm 包取得完整源码。esbuild 仅用于构建，不作为用户脚本运行时依赖。

交互行为及仓库发布流程参考 Bellaris-Weekly/bella-gif-helper（MIT 自有代码，Copyright (c) 2026 Bellaris Weekly）。未引入 GIF 编码或 GPL 运行时组件。
