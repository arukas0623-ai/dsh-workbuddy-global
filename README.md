# dsh-workbuddy-global

把 **WorkBuddy 国际版**（`www.workbuddy.ai`）的模型接入 DeepSeek Harness（DSH）。

它与官方插件 [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect)（WorkBuddy 国内版：
`copilot.tencent.com` / `codebuddy.cn`）注册成**两个不同的 provider**，因此在 DSH 的模型选择器里
各自成组，可以随时切换、互不干扰。

[English](./README.en.md)

---

## 为什么需要单独一个插件

官方插件的 `src/upstream.ts` 已经预留了国际版分支（`WorkBuddyRegion = 'cn' | 'global'`、`GLOBAL_BASE`、
`regionOf()`），但 global 分支沿用了国内版的接口路径，实测两处都不通：

| 调用 | 结果 | 国际站的真实路径 |
|---|---|---|
| `GET www.workbuddy.ai/console/enterprises/personal/models` | **HTTP 500** | `/v3/config` |
| `POST www.workbuddy.ai/v2/billing/meter/get-user-resource` | **HTTP 404** | `/billing/meter/get-user-resource-summary` |

另外，一个插件实例只读一份凭据文件、只注册一个 provider，天然挂不了两个账号。所以国际版这里单独实现。

## 两版接口对照

| 能力 | 国内版 | 国际版 |
|---|---|---|
| provider | `workbuddy` | `workbuddy-global` |
| 对话 | `copilot.tencent.com/v2/chat/completions` | `www.workbuddy.ai/v2/chat/completions` |
| 模型目录 | `copilot.tencent.com/console/enterprises/personal/models` | `www.workbuddy.ai/v3/config` |
| 积分 | `codebuddy.cn/v2/billing/meter/get-user-resource` | `www.workbuddy.ai/billing/meter/get-user-resource-summary` |
| 令牌续期 | `/v2/plugin/auth/token/refresh` | `/v2/auth/token/refresh` |
| 凭据文件 | `workbuddy-desktop.info` | `workbuddy-desktop-ai.info` |

两份凭据都在 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\`
（macOS 在 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/`）。

## 模型目录

模型清单取自桌面 App 使用的 `/v3/config`，请求会带上桌面 App 的 User-Agent —— 服务端按 UA 返回
不同的目录，同一个地址用 CLI 的 UA 只会拿到一份更旧的基础目录。若 `/v3/config` 不可用，插件会退回
`/v2/enterprises/personal/models` 并记一条日志。

具体有哪些模型由服务端按账号权限决定。目录里标记为非对话用途的模型（`text-to-image`）会被剔除，
与桌面 App 的处理一致；除此之外插件不做裁剪。

## 安装

前置：已安装并登录 WorkBuddy 国际版桌面 App —— 插件复用它的登录状态（只读），账号切换自动跟随。

```bash
dsh plugin --profile web add github:arukas0623-ai/dsh-workbuddy-global
```

重启 DSH 后，模型选择器里会出现 **WorkBuddy 国际版** 分组。

> 桌面版 `DeepSeekHarness.exe` 实际启动的是 **web** profile，所以用 `--profile web`。

## 工作原理

和官方插件同构：

1. 只读地读取 WorkBuddy 桌面 App 的凭据文件；续期结果写进插件自己的副本（`$DSH_HOME/.workbuddy-global-auth.json`），**绝不写 App 的文件**。两者取过期时间更晚的那个生效。
2. 起一个只监听 `127.0.0.1` 的 OpenAI 兼容 shim，由它补齐国际版上游的线路要求：
   - 强制 `stream: true`（上游不接受非流式）；
   - `role: "developer"` 改写成 `"system"`（pi-ai 按 OpenAI 约定发 `developer`，上游会以 HTTP 400 / code 11128 拒绝）；
   - `tool_choice` 压成字符串（对象形式上游返回 400）；
   - 补上 CLI 形状的请求头。
3. pi-ai 的 provider 指向这个 shim。

**安全**：shim 每进程生成 32 字节随机共享密钥，pi-ai 把它当 `apiKey` 发出来，shim 用常量时间比较校验后才转发；真实令牌始终由 shim 自己从凭据库解析，密钥不上传、不落盘。本机其它进程即便知道端口也调不通——挡它的是那个每进程随机的密钥。shim 另外校验 `Host` / `Origin` / `Content-Type`，挡的是 DNS-rebinding 与跨站页面。

## 配置

设置 → 插件 → **WorkBuddy 国际版**：

- `authFile` —— 凭据文件路径。留空即按下面的顺序自动找：
  1. 设置里的 `authFile`，或环境变量 `WORKBUDDY_GLOBAL_AUTH_FILE`（两者都逐字使用，不做探测）；
  2. `%LOCALAPPDATA%`、再 `%APPDATA%` 下的 `workbuddy-desktop-ai.info`，命中即用；
  3. 都没有才退一步看国内版文件名 `workbuddy-desktop.info`，且只有它内容里的 `domain` 确实是国际站时才采用
     —— 有些安装方式会把国际账号写进那个文件，这样既不会误用国内账号，也不会因为文件名不一致就直接失效。

一个都没命中时，报错里会列出找过哪些位置。

卡片上能看到登录账号、令牌有效期、剩余积分，以及当前有优惠的模型。

## 让两个分组名字更清楚

官方插件的 provider 显示名默认是 `WorkBuddy`。如果你希望它显示成「WorkBuddy 国内版」以便和本插件区分，可以运行：

```bash
node tools/label-upstream-as-cn.mjs
```

它会把官方插件构建产物里的显示名改掉（幂等，改前自动备份）。**官方插件升级后需要重跑**，因为升级会覆盖 `node_modules` 里的文件。

## 已知限制

- 依赖 WorkBuddy 客户端的接口（**非官方开放 API**），WorkBuddy 更新后可能需要跟着调整。
- 需要 DSH 核心 `0.1.5-rc.1` 及以上（与官方插件 0.4.0 同一档）。
- 设置卡片读的 `/plugins/dsh-workbuddy-global/status` 走 DSH 本体的 web 服务，该路由自带
  `Host` / `Origin` 回环校验，但没有额外的鉴权。接口只读，不返回令牌；同机其它进程能读到账号名与积分，
  信任边界与凭据文件本身同级。
- 运行期依赖全部由 DSH 本体提供（见 `peerDependencies`），本插件自身**没有构建步骤**，`lib/` 里的就是源码。

## 开发

不需要安装任何依赖就能跑测试：

```bash
node --test tests/
```

`lib/pure.js` 里是与运行环境无关的纯函数（凭据解析、凭据文件选取、目录筛选、请求体归一化、
上游返回解析、错误分类），刻意不 import 任何 `@deepseek-ai/*`，所以能在没有 DSH 的环境里直接测。
文件系统访问一律由调用方注入（例如 `pickDesktopAuthPath` 的 `isFile` / `readText`），
因此路径探测逻辑也能用假文件系统覆盖。

`lib/index.js`（宿主半边）与 `lib/client.js`（浏览器半边）需要 DSH 才能加载。要手工验证，把本目录放进某个 profile 的 `node_modules` 后启动该 profile 即可：

```bash
dsh plugin --profile web add file:<本目录绝对路径>
```

## 致谢

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）—— 本项目的上游。凭据库、回环 shim、上游线路处理均移植自它。
- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）—— WorkBuddy 上游协议的参照实现。
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect)（Apache-2.0）—— DSH 插件结构与 provider 注册的参照。

## 免责声明

- **仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用，禁止商业用途。
- 使用者需遵守 WorkBuddy 服务条款，后果自负（包括账号受限、额度清空、服务中断等）。
- 作者不对任何直接或间接损失负责。
- 与腾讯、WorkBuddy、DeepSeek **均无关联**，未获授权或认可。
