/**
 * dsh-workbuddy-global — WorkBuddy 国际版（www.workbuddy.ai）模型接入 DeepSeek Harness。
 *
 * 与官方插件 dsh-workbuddy-connect（国内版，copilot.tencent.com / codebuddy.cn）
 * 并存：两者注册为不同的 provider（`workbuddy` 与 `workbuddy-global`），
 * 在 DSH 的模型选择器里各自成组，可以随时切换。
 *
 * 上游协议参照 corrinehu/dsh-workbuddy-connect（MIT）与 Sliverkiss/workbuddy2api（MIT）。
 * 国际版与国内版的差异（均经实测确认）：
 *
 *   能力        国内版                                   国际版
 *   ---------   -------------------------------------    ---------------------------------------------
 *   对话        copilot.tencent.com/v2/chat/completions   www.workbuddy.ai/v2/chat/completions
 *   模型列表    copilot.tencent.com/console/enterprises/  www.workbuddy.ai/v3/config
 *               personal/models                          （须带桌面 App 的 UA，见 APP_UA）
 *   积分        codebuddy.cn/v2/billing/meter/            www.workbuddy.ai/billing/meter/
 *               get-user-resource                        get-user-resource-summary
 *   续期        /v2/plugin/auth/token/refresh             /v2/auth/token/refresh
 *   凭据文件    workbuddy-desktop.info                    workbuddy-desktop-ai.info
 *
 * @module dsh-workbuddy-global
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import z from '@deepseek-ai/schemastery'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

import {
  classifyUpstreamError,
  normalizeCredits,
  optionalString,
  parseGlobalCreditPackages,
  parseWorkBuddyAuth,
  pickDesktopAuthPath,
  prepareChatBody,
  resolveUpstreamBilling,
  resolveUpstreamReasoning,
  selectChatModels,
} from './pure.js'

export {
  classifyUpstreamError,
  isGlobalDomain,
  normalizeCredits,
  parseGlobalCreditPackages,
  parseWorkBuddyAuth,
  pickDesktopAuthPath,
  prepareChatBody,
  selectChatModels,
} from './pure.js'

//#region 常量

/** 本插件独占的 provider 路由。 */
export const WORKBUDDY_GLOBAL_PROVIDER = 'workbuddy-global'

/** 设置页里的显示名。 */
export const WORKBUDDY_GLOBAL_DISPLAY_NAME = 'WorkBuddy 国际版'

/** 设置命名空间，同时也是设置卡片的归属。 */
export const WORKBUDDY_GLOBAL_SETTINGS_NS = 'workbuddy-global'

/** 浏览器半边读取状态文档的路径。 */
export const WORKBUDDY_GLOBAL_STATUS_PATH = '/plugins/dsh-workbuddy-global/status'

/** 国际版上游根地址（对话、模型、积分同源）。 */
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/** 上游各能力的具体路径。 */
const CHAT_PATH = '/v2/chat/completions'
const REFRESH_PATH = '/v2/auth/token/refresh'

/**
 * 产品目录路径。桌面 App 用的是这个，它给出的才是 App 里看到的那份模型清单。
 * `/v2/enterprises/personal/models` 是另一份、更新的频率更低（见 `fetchModels`）。
 */
const CONFIG_PATH = '/v3/config'

/** 账号级模型目录路径，仅作为 `/v3/config` 不可用时的退路。 */
const MODELS_PATH = '/v2/enterprises/personal/models'
const BILLING_PATH = '/billing/meter/get-user-resource-summary'

/** 官方 CLI 的 User-Agent，对话/积分等请求用它。 */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/**
 * 桌面 App 的 User-Agent。**上游按 UA 分流产品目录**：
 * 同一个 `/v3/config`，带 App 的 UA 才返回桌面端那份清单（含 `gpt-6-astra`、
 * `deepseek-v4.1-flash`、`hy4-preview-f`）；用 CLI 的 UA 请求它只会拿到更旧的
 * 基础目录，而 `/v2/enterprises/personal/models` 干脆少了这三个模型。
 */
const APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'WorkBuddyAI/5.5.2 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36'

/** 单次 JSON 请求的超时。 */
const JSON_TIMEOUT_MS = 30_000

/** 错误响应体最多回显多少字节。 */
const ERROR_BODY_LIMIT = 4096

/** 流式读取的空闲上限。 */
export const WORKBUDDY_GLOBAL_STREAM_IDLE_TIMEOUT_MS = 300_000

/** 本插件自己保存续期结果的文件（不写桌面 App 的文件）。 */
const OWN_AUTH_FILENAME = '.workbuddy-global-auth.json'

/** 桌面 App 的凭据文件基名。 */
const DESKTOP_AUTH_BASENAME = 'workbuddy-desktop-ai.info'

/** 国内版凭据文件基名，仅用于「内容其实是国际账号」的兜底探测。 */
const DESKTOP_AUTH_FALLBACK_BASENAME = 'workbuddy-desktop.info'

/** 宿主心跳文件基名（与国内版插件分开，互不覆盖）。 */
const HEARTBEAT_FILENAME = '.workbuddy-global-host-heartbeat.json'

/** 凭据文件在 CodeBuddyExtension 数据目录下的相对路径。 */
const DESKTOP_AUTH_RELATIVE_PATH = ['CodeBuddyExtension', 'Data', 'Public', 'auth']

/**
 * 模型目录里代表「非对话用途」的标签，带这些标签的模型不应作为对话模型列出。
 * 与国际版桌面 App 的 `listAvailableModels()` 用的是同一套判断。
 */
const NON_CHAT_TAGS = new Set(['text-to-image'])

//#endregion

//#region 路径解析

/** 某个 AppData 根下的凭据文件路径。 */
function authPathIn(root, basename) {
  return join(root, ...DESKTOP_AUTH_RELATIVE_PATH, basename)
}

/** 按平台给出国际版凭据文件的候选路径。 */
export function desktopAuthCandidates() {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [authPathIn(join(home, 'Library', 'Application Support'), DESKTOP_AUTH_BASENAME)]
  }
  if (process.platform === 'win32') {
    return [
      authPathIn(join(home, 'AppData', 'Local'), DESKTOP_AUTH_BASENAME),
      authPathIn(join(home, 'AppData', 'Roaming'), DESKTOP_AUTH_BASENAME),
    ]
  }
  return [authPathIn(join(home, '.config'), DESKTOP_AUTH_BASENAME)]
}

/** 国内版文件名的候选路径，仅用于兜底探测。 */
function fallbackAuthCandidates() {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [authPathIn(join(home, 'Library', 'Application Support'), DESKTOP_AUTH_FALLBACK_BASENAME)]
  }
  if (process.platform === 'win32') {
    return [
      authPathIn(join(home, 'AppData', 'Local'), DESKTOP_AUTH_FALLBACK_BASENAME),
      authPathIn(join(home, 'AppData', 'Roaming'), DESKTOP_AUTH_FALLBACK_BASENAME),
    ]
  }
  return [authPathIn(join(home, '.config'), DESKTOP_AUTH_FALLBACK_BASENAME)]
}

/** 插件自有凭据副本的路径。 */
export function globalOwnAuthPath() {
  return join(resolveDshHome(), OWN_AUTH_FILENAME)
}

/** 宿主心跳文件路径。 */
export function globalHeartbeatPath() {
  return join(resolveDshHome(), HEARTBEAT_FILENAME)
}

/**
 * 挑出真正属于国际版的凭据文件。
 *
 * 首选 `workbuddy-desktop-ai.info`；若它不存在，再检查国内版文件名
 * `workbuddy-desktop.info` —— 有些安装方式会把国际账号写进那个文件，
 * 只有当它解析出来的 domain 确实是国际站时才采用。这样既不会误用国内账号，
 * 也不会在文件名不一致时直接失效。
 *
 * 判断逻辑在 `pickDesktopAuthPath`（pure.js）里，这里只负责把真实的文件系统
 * 操作注进去；凭据库读取桌面凭据时走的就是这个函数。
 */
export async function resolveDesktopAuthPath() {
  const { path } = await pickDesktopAuthPath({
    candidates: desktopAuthCandidates(),
    fallbackCandidates: fallbackAuthCandidates(),
    isFile: async candidate => (await stat(candidate)).isFile(),
    readText: candidate => readFile(candidate, 'utf8'),
  })
  return path
}

//#endregion

//#region 凭据解析

/** 解析插件自有副本；版本或形状不符一律拒绝。 */
function parseOwnDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  if (parsed.version !== 1) return undefined
  const stored = parsed.credential
  if (typeof stored !== 'object' || stored === null) return undefined
  const accessToken = typeof stored.accessToken === 'string' ? stored.accessToken : ''
  if (accessToken === '') return undefined
  const enterpriseId = optionalString(stored.enterpriseId)
  const nickname = optionalString(stored.nickname)
  return {
    accessToken,
    refreshToken: typeof stored.refreshToken === 'string' ? stored.refreshToken : '',
    expiresAtMs: typeof stored.expiresAtMs === 'number' ? stored.expiresAtMs : 0,
    ...typeof stored.refreshExpiresAtMs === 'number' ? { refreshExpiresAtMs: stored.refreshExpiresAtMs } : {},
    domain: optionalString(stored.domain) ?? '',
    uid: optionalString(stored.uid) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'dsh',
  }
}

function isENOENT(error) {
  return error?.code === 'ENOENT'
}

/**
 * 只读凭据库 + 按需续期。
 *
 * 桌面 App 的文件永远只读；续期结果写进插件自己的副本，两者取过期时间
 * 更晚的那个生效，因此任何一边刷新都能被用上。续期失败但当前令牌还没
 * 过期时照常返回，不会把一次网络抖动变成不可用。
 */
export class WorkBuddyGlobalCredentialStore {
  #refresh
  #refreshMarginMs
  #ownPath
  #desktopPathOverride
  #resolvedDesktopPath
  #inflight

  constructor(options) {
    this.#refresh = options.refresh
    this.#refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.#ownPath = options.ownPath ?? globalOwnAuthPath()
    this.#desktopPathOverride = options.desktopPath
  }

  /** 显式指定的凭据文件（设置里的 `authFile` 或环境变量）；没指定则为 undefined。 */
  #explicitDesktopPath() {
    if (this.#desktopPathOverride !== undefined) return this.#desktopPathOverride
    const fromEnv = process.env.WORKBUDDY_GLOBAL_AUTH_FILE
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
    return undefined
  }

  /**
   * 真正要读的桌面凭据文件。
   *
   * 显式路径逐字优先；没指定时才走 {@link resolveDesktopAuthPath} 的候选探测
   * （含「国内版文件名 + domain 确实是国际站」的兜底）。探测结果按 store 实例
   * 记忆，免得每次取令牌都去摸盘。
   */
  async #desktopPath() {
    const explicit = this.#explicitDesktopPath()
    if (explicit !== undefined) return explicit
    this.#resolvedDesktopPath ??= resolveDesktopAuthPath()
    return this.#resolvedDesktopPath
  }

  /** 认不出账号时，把「找过哪里」写进报错，省得用户猜。 */
  #expectedDesktopPaths() {
    const explicit = this.#explicitDesktopPath()
    if (explicit !== undefined) return explicit
    return `${desktopAuthCandidates()[0]} 或 ${fallbackAuthCandidates()[0]}`
  }

  /** 改指桌面凭据文件；下次读取即生效（并丢弃上一次的自动探测结果）。 */
  setDesktopPath(path) {
    this.#desktopPathOverride = path
    this.#resolvedDesktopPath = undefined
  }

  /** 当前解析到的桌面凭据文件路径，供诊断用。 */
  async desktopAuthPath() {
    return this.#desktopPath()
  }

  /** 插件自有副本路径，供诊断用。 */
  ownAuthPath() {
    return this.#ownPath
  }

  /** 读取最新鲜的凭据，不触发续期。 */
  async current() {
    const [desktop, own] = await Promise.all([this.#readDesktop(), this.#readOwn()])
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  /** 真正发往上游的凭据：必要时先续期，并发请求共享同一次续期。 */
  async resolve() {
    const credential = await this.current()
    if (credential === undefined) {
      throw new Error(
        'workbuddy-global: 没找到已登录的 WorkBuddy 国际版账号；'
        + `请先在 WorkBuddy 桌面 App 登录一次（预期文件 ${this.#expectedDesktopPaths()}，`
        + '也可在插件设置里指定 authFile 或用环境变量 WORKBUDDY_GLOBAL_AUTH_FILE 覆盖）',
      )
    }
    if (!this.#needsRefresh(credential)) return credential
    this.#inflight ??= this.#refreshNow(credential).finally(() => {
      this.#inflight = undefined
    })
    return this.#inflight
  }

  /** 只读登录摘要，永不续期、永不抛错。 */
  async status() {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        source: credential.source,
      }
    } catch {
      return { state: 'signed-out' }
    }
  }

  /** 删掉插件自有副本；桌面 App 的文件不动。 */
  async logout() {
    await rm(this.#ownPath, { force: true })
    await rm(`${this.#ownPath}.lock`, { force: true })
  }

  #needsRefresh(credential) {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.#refreshMarginMs >= credential.expiresAtMs
  }

  async #refreshNow(credential) {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('workbuddy-global: 访问令牌已过期且没有 refresh token；请在 WorkBuddy 桌面 App 重新登录')
    }
    try {
      const outcome = await this.#refresh(credential)
      const refreshed = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
        source: 'dsh',
      }
      await this.#saveOwn(refreshed)
      return refreshed
    } catch (error) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddy-global: 续期失败且访问令牌已过期（${String(error)}）；请打开 WorkBuddy 桌面 App 重新登录`,
      )
    }
  }

  async #saveOwn(credential) {
    await withFileLock(this.#ownPath, async () => {
      await writeFileAtomic(this.#ownPath, `${JSON.stringify({ version: 1, credential }, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  async #readDesktop() {
    try {
      return parseWorkBuddyAuth(await readFile(await this.#desktopPath(), 'utf8'))
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  async #readOwn() {
    try {
      return parseOwnDocument(await readFile(this.#ownPath, 'utf8'))
    } catch {
      return undefined
    }
  }
}

//#endregion

//#region 上游客户端

/** 解析上游的 `{code,msg,data}` 信封。 */
async function readEnvelope(response) {
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy-global 上游返回了非 JSON（http ${response.status}）：${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy-global 上游返回了意料之外的文档（http ${response.status}）`)
  }
  return {
    code: typeof parsed.code === 'number' ? parsed.code : 0,
    msg: typeof parsed.msg === 'string' ? parsed.msg : '',
    data: 'data' in parsed ? parsed.data : undefined,
  }
}

function envelopeError(status, envelope) {
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy-global 上游 ${kind}（http ${status}）：${envelope.msg.slice(0, 160)}`)
}

/** 上游通用请求头。 */
function commonHeaders(credential) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': GLOBAL_BASE,
    'Referer': `${GLOBAL_BASE}/`,
    'User-Agent': CLIENT_UA,
  }
}

/** 对话请求头：身份三件套按有无分别走 X-* 或 X-No-*。 */
function identityHeaders(credential) {
  return {
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
  }
}

/** 国际版上游客户端。 */
export class WorkBuddyGlobalUpstreamClient {
  #logger

  /** `options.logger` 可选，用于记录目录降级等事件。 */
  constructor(options = {}) {
    this.#logger = options.logger
  }

  /** POST 对话接口；成功时返回原始 SSE 响应。 */
  async chatStream(credential, bodyJson, signal) {
    let response
    try {
      response = await fetch(`${GLOBAL_BASE}${CHAT_PATH}`, {
        method: 'POST',
        headers: {
          ...commonHeaders(credential),
          'Content-Type': 'application/json',
          ...identityHeaders(credential),
          'X-Product': 'SaaS',
          'Authorization': `Bearer ${credential.accessToken}`,
        },
        body: bodyJson,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return { ok: false, status: response.status, kind: classifyUpstreamError(response.status, text), message: text }
  }

  /** POST 续期接口；调用方负责合并结果。 */
  async refreshToken(credential) {
    const headers = {
      ...commonHeaders(credential),
      'X-Refresh-Token': credential.refreshToken,
      'X-Auth-Refresh-Source': 'workbuddy',
    }
    if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      headers['X-Enterprise-Id'] = credential.enterpriseId
    }
    const response = await fetch(`${GLOBAL_BASE}${REFRESH_PATH}`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken : ''
    if (accessToken === '') {
      throw new Error('workbuddy-global 续期没有返回 accessToken；请在 WorkBuddy 桌面 App 重新登录')
    }
    const outcome = { accessToken }
    if (typeof data.refreshToken === 'string' && data.refreshToken !== '') outcome.refreshToken = data.refreshToken
    if (typeof data.expiresIn === 'number' && data.expiresIn > 0) outcome.expiresInSec = data.expiresIn
    if (typeof data.domain === 'string' && data.domain !== '') outcome.domain = data.domain
    return outcome
  }

  /**
   * GET 模型目录。
   *
   * 优先走桌面 App 用的 `/v3/config`，**必须带 App 的 User-Agent**：服务端按 UA 返回不同的目录，
   * 同一个地址用 CLI 的 UA 只会拿到一份更旧的基础目录。`/v2/enterprises/personal/models`
   * 那份账号目录更新更慢，缺 `gpt-6-astra`、`deepseek-v4.1-flash`、`hy4-preview-f`。
   *
   * `/v3/config` 拿不到时才退回 `/v2` 那份，并留一条 warn。
   */
  async fetchModels(credential) {
    const fromConfig = await this.#fetchCatalog(credential, CONFIG_PATH, APP_UA)
    if (fromConfig.ok) return fromConfig.models
    this.#logger?.warn(
      'dsh-workbuddy-global: /v3/config 目录不可用，退回 /v2 账号目录（模型可能变少）',
      fromConfig.error,
    )
    const legacy = await this.#fetchCatalog(credential, MODELS_PATH, CLIENT_UA)
    if (legacy.ok) return legacy.models
    throw legacy.error
  }

  /**
   * 取一次目录并解析成模型列表。
   *
   * 两个接口的响应形状不同：`/v3/config` 把产品配置直接放在顶层，`/v2/...`
   * 包了一层 `{code,msg,data}`，所以按有无 `data` 判断。
   */
  async #fetchCatalog(credential, path, userAgent) {
    try {
      const response = await fetch(`${GLOBAL_BASE}${path}`, {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Origin': GLOBAL_BASE,
          'Referer': `${GLOBAL_BASE}/`,
          'User-Agent': userAgent,
          ...identityHeaders(credential),
        },
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      })
      const text = await response.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(`workbuddy-global 上游返回了非 JSON（${path} http ${response.status}）：${text.slice(0, 160)}`)
      }
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(`workbuddy-global 上游返回了意料之外的文档（${path} http ${response.status}）`)
      }
      if (!response.ok || (typeof parsed.code === 'number' && parsed.code !== 0)) {
        throw envelopeError(response.status, {
          msg: typeof parsed.msg === 'string' ? parsed.msg : text.slice(0, 160),
        })
      }
      const container = typeof parsed.data === 'object' && parsed.data !== null ? parsed.data : parsed
      // 与桌面 App 的 listAvailableModels() 一致：取 models 全量，只排除标记为
      // 非对话用途的那些（如 text-to-image），不做额外裁剪。
      const models = selectChatModels(container.models, NON_CHAT_TAGS)
      if (models.length === 0) throw new Error(`workbuddy-global 模型目录为空（${path}）`)
      return { ok: true, models }
    } catch (error) {
      return { ok: false, error }
    }
  }

  /**
   * POST 积分接口。国际版走 `get-user-resource-summary`，返回
   * `data.Packages[]`，容量字段是字符串。
   */
  async fetchCredits(credential) {
    const response = await fetch(`${GLOBAL_BASE}${BILLING_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
        ...credential.enterpriseId === undefined || credential.enterpriseId === ''
          ? {}
          : { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId },
        ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
      },
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
    return parseGlobalCreditPackages(data.Packages)
  }
}

//#endregion

//#region 模型目录

/**
 * 国际版 cli agent 的静态兜底模型表（2026-09-11 从线上目录抓取）。
 * 启动时一旦拿到线上目录就会被替换；它存在的意义是首帧就有可用的模型列表。
 */
export const FALLBACK_WORKBUDDY_GLOBAL_MODELS = [
  { id: 'default-model', name: 'Auto', contextWindow: 176_000, maxTokens: 24_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, canDisableThinking: false }, billing: { credits: 'x0.79 credits', free: false } },
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.34 credits', free: false } },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.59 credits', free: false } },
  { id: 'primary-model', name: 'Primary', contextWindow: 272_000, maxTokens: 72_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x3.31 credits', free: false } },
  { id: 'deep-model', name: 'Deep', contextWindow: 176_000, maxTokens: 24_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, canDisableThinking: false }, billing: { credits: 'x3.33 credits', free: false } },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.00', free: true } },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.00', free: true } },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: false, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x3.47', free: false } },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: false, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x1.39', free: false } },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: false, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.14', free: false } },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x3.31', free: false } },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, maxTokens: 72_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x1.65', free: false } },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272_000, maxTokens: 72_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x1.25', free: false } },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1_000_000, maxTokens: 65_536, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.99', free: false } },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.79', free: false } },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: false, supportedEfforts: ['high', 'xhigh'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.79', free: false } },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x1.62', free: false } },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.52', free: false } },
  // 下面三个只有 `/v3/config`（带 App UA）那份目录才有，`/v2` 的账号目录里没有。
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.00', free: true } },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x6.67', free: false } },
  { id: 'hy4-preview-f', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.00', free: true } },
]

/** shim 的 /v1/models 与适配器共用的可变模型目录。 */
export class WorkBuddyGlobalCatalog {
  #models = FALLBACK_WORKBUDDY_GLOBAL_MODELS

  current() {
    return this.#models
  }

  set(models) {
    this.#models = [...models]
  }
}

//#endregion

//#region 回环 shim

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

const KIND_STATUS = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res, status, kind, message) {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

function isJsonContentType(req) {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

/** Host 头必须指向回环地址，浏览器发来的 Origin 也必须是回环。 */
function hostIsLoopback(host) {
  if (typeof host !== 'string') return false
  const value = host.trim().toLowerCase()
  return value === '127.0.0.1'
    || value.startsWith('127.0.0.1:')
    || value === 'localhost'
    || value.startsWith('localhost:')
    || value === '[::1]'
    || value.startsWith('[::1]:')
}

function originIsLoopback(origin) {
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  const value = origin.trim().toLowerCase()
  if (value === 'null') return true
  try {
    const url = new URL(value)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * 启动回环 OpenAI 兼容端点。pi-ai 的 provider 指向这里，由 shim 负责
 * 国际版上游的线路怪癖（强制流式、字符串 tool_choice、CLI 请求头），
 * 再转发给真正的上游。只监听 127.0.0.1。
 */
export function createWorkBuddyGlobalShim(options) {
  const { store, client, catalog } = options
  const logger = options.logger

  // 每进程随机共享密钥，只存在内存里。适配器把它当 OpenAI apiKey，
  // pi-ai 会以 Authorization: Bearer 发出来；真实令牌始终由 shim 自己解析。
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  function bearerOk(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const a = Buffer.from(match[1])
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready = new Promise((resolve, reject) => {
    server.once('listening', () => { resolve() })
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = () => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('workbuddy-global shim 没有监听地址')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req, res) {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host 头必须指向回环地址')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin 必须是回环来源')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', '缺少或错误的 Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: WORKBUDDY_GLOBAL_PROVIDER,
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
      } else {
        res.end()
      }
    }
  }

  async function chatCompletions(req, res) {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type 必须是 application/json')
      return
    }
    let credential
    try {
      credential = await store.resolve()
    } catch (error) {
      writeOpenAIError(res, 401, 'not_signed_in', String(error))
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const prepared = prepareChatBody(raw)

    const controller = new AbortController()
    req.on('close', () => { controller.abort() })
    const result = await client.chatStream(credential, prepared, controller.signal)

    if (!result.ok) {
      writeOpenAIError(
        res,
        KIND_STATUS[result.kind],
        result.kind,
        `workbuddy-global 上游 ${result.kind}（http ${result.status}）：${result.message.slice(0, 400)}`,
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let sawDone = false
    const body = Readable.fromWeb(result.response.body)
    body.on('data', chunk => {
      if (chunk.includes('[DONE]')) sawDone = true
    })
    body.on('error', error => {
      logger?.warn('dsh-workbuddy-global: 上游流中途失败', error)
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
    })
    body.pipe(res)
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise((resolve, reject) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}

//#endregion

//#region 适配器

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

/** 惰性认证平面：本路由只靠 shim 共享密钥认证，pi-ai 自身不产出凭据。 */
const INERT_AUTH = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-workbuddy-global: 本路由没有 pi-ai 凭据生命周期')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const RATE_SEPARATOR = ' · '

function displaySuffix(info) {
  const parts = [
    normalizeCredits(info.billing?.credits),
    ...(info.billing?.badges ?? []),
  ].filter(part => part !== undefined && part !== '')
  return parts.length === 0 ? undefined : parts.join(RATE_SEPARATOR)
}

function withCatalogDisplay(name, info) {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${RATE_SEPARATOR}${suffix}`
}

/**
 * 把模型的推理能力映射成 pi-ai 的 thinkingLevelMap。
 * 只认上游明确声明的档位集合：声明了才给控件，给的就是声明的那几个值。
 */
function reasoningFields(info) {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) return { reasoning: false }
  const efforts = reasoning.supportedEfforts
  if (efforts === undefined || efforts.length === 0) return { reasoning: false }
  return {
    reasoning: true,
    thinkingLevelMap: {
      off: reasoning.canDisableThinking === true ? 'off' : null,
      minimal: null,
      low: efforts.includes('low') ? 'low' : null,
      medium: efforts.includes('medium') ? 'medium' : null,
      high: efforts.includes('high') ? 'high' : null,
      xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
      max: efforts.includes('max') ? 'max' : null,
    },
  }
}

function toPiModel(info, baseUrl) {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: WORKBUDDY_GLOBAL_PROVIDER,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoningFields(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  }
}

/** 组装 pi-ai provider 与 profile，全部指向回环 shim。 */
export function createWorkBuddyGlobalAdapter(options) {
  const { shim, store, catalog, resolveAttachments } = options

  const buildModels = () => {
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl))
  }

  const provider = {
    ...createProvider({
      id: WORKBUDDY_GLOBAL_PROVIDER,
      name: WORKBUDDY_GLOBAL_DISPLAY_NAME,
      auth: {
        apiKey: {
          name: 'WorkBuddy 国际版 OAuth bearer token',
          async resolve({ credential }) {
            const apiKey = credential?.key
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: WORKBUDDY_GLOBAL_DISPLAY_NAME }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  }

  const profile = {
    provider: WORKBUDDY_GLOBAL_PROVIDER,
    displayName: WORKBUDDY_GLOBAL_DISPLAY_NAME,
    streamIdleTimeoutMs: WORKBUDDY_GLOBAL_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-workbuddy-global retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map([[WORKBUDDY_GLOBAL_PROVIDER, profile]])

  const adapter = new WorkBuddyGlobalPiAiAdapter(catalog, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.token(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map([[WORKBUDDY_GLOBAL_PROVIDER, profile]])
    },
  }
}

/** 把计费倍率折进返回给模型选择器的显示名里。 */
class WorkBuddyGlobalPiAiAdapter extends PiAiAdapter {
  constructor(catalog, options) {
    super(options)
    this.catalog = catalog
  }

  infoFor(model) {
    return this.catalog.current().find(entry => entry.id === model)
  }

  async listModels(provider) {
    const models = await super.listModels(provider)
    return models.map(model => {
      const info = this.infoFor(model.id)
      if (info === undefined) return model
      return { ...model, name: withCatalogDisplay(model.name, info) }
    })
  }

  async resolveModel(provider, model, signal) {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    return { ...resolved, name: withCatalogDisplay(resolved.name, info) }
  }
}

//#endregion

//#region 心跳与状态路由

/** 写宿主心跳，供 CLI 在不依赖浏览器的情况下判断宿主是否起来。 */
export async function writeGlobalHostHeartbeat() {
  const document = {
    version: 1,
    package: 'dsh-workbuddy-global',
    pluginVersion: PLUGIN_VERSION,
    registeredAt: Date.now(),
    pid: process.pid,
  }
  try {
    await writeFileAtomic(globalHeartbeatPath(), JSON.stringify(document), { mode: 0o600, dirMode: 0o700 })
  } catch {
    // 非致命：CLI 只会报「心跳缺失」
  }
}

/** 插件卸载时清掉心跳，避免留下过期文件。 */
export async function clearGlobalHostHeartbeat() {
  try {
    await rm(globalHeartbeatPath(), { force: true })
  } catch {
    // 尽力而为
  }
}

const PLUGIN_VERSION = '0.1.2'

/** 把可能含令牌的文本脱敏后再发给浏览器。 */
function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

/** 组装设置卡片要的状态文档。 */
export async function workBuddyGlobalWebStatus(deps) {
  const authStatus = await deps.store.status()
  if (authStatus.state !== 'signed-in') return { status: 'signed-out' }
  const status = {
    status: 'signed-in',
    ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
    ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
    ...authStatus.source === undefined ? {} : { source: authStatus.source },
    ...authStatus.expiresAtMs === undefined ? {} : { expiresAt: authStatus.expiresAtMs },
  }
  const models = deps.models()
  const modelsField = models
    .filter(model => model.billing?.free === true || (model.billing?.badges?.length ?? 0) > 0)
    .map(model => {
      const rate = normalizeCredits(model.billing?.credits)
      return {
        id: model.id,
        name: model.name,
        ...model.billing?.free === true ? { free: true } : {},
        ...model.billing?.badges !== undefined && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
        ...rate === undefined ? {} : { credits: rate },
      }
    })
  const statusWithModels = modelsField.length > 0 ? { ...status, models: modelsField } : status
  try {
    const credential = await deps.store.current()
    if (credential !== undefined) {
      const credits = await deps.client.fetchCredits(credential)
      return { ...statusWithModels, credits }
    }
  } catch (error) {
    return { ...statusWithModels, creditsError: safeMessage(error) }
  }
  return statusWithModels
}

/** 把状态路由挂到可选的 webServer 上。 */
export function registerWorkBuddyGlobalStatusRoute(ctx, deps) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_GLOBAL_STATUS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
          writeJson(res, 403, { error: 'request-not-trusted' })
          return
        }
        try {
          writeJson(res, 200, await workBuddyGlobalWebStatus(deps))
        } catch (error) {
          writeJson(res, 500, { error: safeMessage(error) })
        }
      },
    })
    return () => { dispose() }
  }, 'dsh-workbuddy-global: Web status route')
}

//#endregion

//#region 插件入口

/** 稳定的 Cordis 插件名。 */
export const name = 'llm-workbuddy-global'

/** 注册 provider 之前必须先有模型注册表。 */
export const inject = ['llm']

/** 插件配置。 */
export const Config = z.object({
  authFile: z.string().description('WorkBuddy 国际版凭据文件（默认自动探测 workbuddy-desktop-ai.info）'),
})

/**
 * 起回环端点、注册 `workbuddy-global` provider，并在凭据允许时刷新模型目录。
 * 静态兜底目录从第一帧就在，所以上游不可达也不会让 provider 空着。
 */
export function apply(ctx, config) {
  const client = new WorkBuddyGlobalUpstreamClient({ logger: ctx.logger })
  const store = new WorkBuddyGlobalCredentialStore({
    ...config.authFile === undefined ? {} : { desktopPath: config.authFile },
    refresh: credential => client.refreshToken(credential),
  })
  const catalog = new WorkBuddyGlobalCatalog()
  const shim = createWorkBuddyGlobalShim({ store, client, catalog, logger: ctx.logger })

  // 同源状态路由，供设置卡片读取；headless profile 没有 webServer，跳过即可。
  ctx.inject(['webServer'], webCtx => registerWorkBuddyGlobalStatusRoute(webCtx, {
    store,
    client,
    models: () => catalog.current(),
  }))

  // 设置分区让 provider 出现在「模型」设置页，并让 authFile 改动即时生效。
  let current = () => config
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, WORKBUDDY_GLOBAL_SETTINGS_NS, Config, config, {
      setSource(source) { current = source },
      onChange() {
        store.setDesktopPath(current().authFile)
      },
    })
  })

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    void shim.close()
    void clearGlobalHostHeartbeat()
  })

  void shim.ready
    .then(() => {
      if (stopped) return

      let invalidate
      try {
        const workbuddy = createWorkBuddyGlobalAdapter({
          shim,
          store,
          catalog,
          resolveAttachments: () => ctx.get('attachments'),
        })
        invalidate = workbuddy.invalidate

        let releaseAdapter
        let releaseDirectory
        try {
          releaseAdapter = ctx.llm.registerAdapter([WORKBUDDY_GLOBAL_PROVIDER], workbuddy.adapter)
          releaseDirectory = ctx.llm.registerConfigurableProviders([{
            provider: WORKBUDDY_GLOBAL_PROVIDER,
            displayName: WORKBUDDY_GLOBAL_DISPLAY_NAME,
            settingsNs: WORKBUDDY_GLOBAL_SETTINGS_NS,
            settingsPath: [],
            declared: false,
          }])
        } finally {
          if (releaseAdapter === undefined || releaseDirectory === undefined) {
            releaseAdapter?.()
            releaseDirectory?.()
          }
        }
        try {
          ctx.effect(() => () => {
            releaseAdapter?.()
            releaseDirectory?.()
          })
        } catch {
          releaseAdapter?.()
          releaseDirectory?.()
        }

        void writeGlobalHostHeartbeat()
      } catch (error) {
        ctx.logger.error('dsh-workbuddy-global: provider 注册失败', error)
        return
      }

      void (async () => {
        try {
          const credential = await store.current()
          if (credential === undefined || stopped) return
          const models = await client.fetchModels(credential)
          if (stopped) return
          catalog.set([...models])
          invalidate?.()
        } catch (error) {
          ctx.logger.warn('dsh-workbuddy-global: 动态模型目录不可用，先服务静态兜底列表', error)
        }
      })()
    })
    .catch(error => {
      ctx.logger.error('dsh-workbuddy-global: 回环端点启动失败，provider 未注册', error)
    })
}

//#endregion
