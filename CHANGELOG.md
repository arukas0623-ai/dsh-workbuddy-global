# Changelog

本项目的所有值得记录的变更都写在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.2] - 2026-09-11

### 修复

- 模型目录改读 `/v3/config`，请求带上桌面 App 的 User-Agent。此前的口径少了
  `gpt-6-astra`、`deepseek-v4.1-flash`、`hy4-preview-f` 三个模型。
- `/v3/config` 不可用时退回 `/v2/enterprises/personal/models`，并记录一条日志。

### 变更

- 目录筛选（剔除非对话标签、跳过缺少上下文信息的条目、映射推理档位与计费）抽成
  `lib/pure.js` 的 `selectChatModels()`。
- 静态兜底模型表补上上述三个模型。

## [0.1.1] - 2026-09-11

### 修复

- 凭据文件的兜底探测没有生效：读取时只用了候选列表的第一个路径，未按候选顺序探测，
  也从未检查国内版文件名下的国际账号。
- `package.json` 的 `files` 补上 `tools/`、`tests/`、`CHANGELOG.md`。

### 变更

- 凭据文件选取逻辑抽成 `lib/pure.js` 的 `pickDesktopAuthPath()`，文件系统访问由调用方注入。

## [0.1.0] - 2026-09-11

首个版本。

### 新增

- 注册 provider `workbuddy-global`，把 WorkBuddy 国际版（`www.workbuddy.ai`）的模型接入 DSH，
  与官方插件 `dsh-workbuddy-connect`（国内版）并存，在模型选择器里各自成组。
- 国际版上游客户端：对话、模型目录、积分查询、令牌续期四条链路。
- 只读复用 WorkBuddy 桌面 App 的登录状态；续期结果写进插件自有副本
  （`$DSH_HOME/.workbuddy-global-auth.json`），不写 App 的文件。
- 只监听 `127.0.0.1` 的 OpenAI 兼容 shim，补齐国际版上游的线路要求
  （强制流式、`developer` → `system`、`tool_choice` 压成字符串、CLI 请求头），
  并用每进程随机共享密钥 + 常量时间比较做访问控制。
- 设置卡片：登录账号、令牌有效期、剩余积分、当前有优惠的模型。
- `tools/label-upstream-as-cn.mjs`：把官方插件的显示名改成「WorkBuddy 国内版」，
  便于两个分组区分（幂等，可 `--restore` 还原）。

### 说明

- 需要 DSH 核心 `0.1.5-rc.1` 及以上（与官方插件 0.4.0 同一档）。
- 运行期依赖全部由 DSH 本体提供，本项目没有构建步骤。

[0.1.2]: https://github.com/arukas0623-ai/dsh-workbuddy-global/releases/tag/v0.1.2
[0.1.1]: https://github.com/arukas0623-ai/dsh-workbuddy-global/releases/tag/v0.1.1
[0.1.0]: https://github.com/arukas0623-ai/dsh-workbuddy-global/releases/tag/v0.1.0
