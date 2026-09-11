/**
 * 与运行环境无关的纯函数：凭据解析、请求体归一化、上游返回解析、错误分类。
 *
 * 这里刻意不 import 任何 `@deepseek-ai/*` 或 `@earendil-works/*`，
 * 因此可以在没有 DSH 安装的环境里直接用 `node --test` 跑。
 *
 * @module dsh-workbuddy-global/pure
 */

/** 国际站域名判定。 */
export function isGlobalDomain(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase()
  return lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')
}

/** 把秒或毫秒的过期时间统一成毫秒。 */
export function expiryToMs(value) {
  if (typeof value !== 'number' || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

/** 取非空字符串，否则 undefined。 */
export function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 解析 WorkBuddy 桌面 App 的凭据文档。
 *
 * 兼容两种落盘形态：OAuth 的 `{auth, account}` 嵌套形态，以及账号面板的扁平形态。
 * 没有 accessToken 一律返回 undefined。
 */
export function parseWorkBuddyAuth(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  let auth
  let identity
  if (typeof parsed.auth === 'object' && parsed.auth !== null) {
    auth = parsed.auth
    identity = typeof parsed.account === 'object' && parsed.account !== null ? parsed.account : {}
  } else {
    auth = parsed
    identity = parsed
  }
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = typeof auth.refreshExpiresAt === 'number'
    ? expiryToMs(auth.refreshExpiresAt)
    : undefined
  const enterpriseId = optionalString(identity.enterpriseId)
  const nickname = optionalString(identity.nickname)
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: typeof auth.expiresAt === 'number' ? expiryToMs(auth.expiresAt) : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth.domain) ?? '',
    uid: optionalString(identity.uid) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'desktop',
  }
}

/**
 * 挑出真正属于国际版的桌面凭据文件路径。
 *
 * 先按 `candidates` 顺序取第一个存在的文件；都不存在时，再退一步检查国内版
 * 文件名（`fallbackCandidates`）——有些安装方式会把国际账号写进
 * `workbuddy-desktop.info`，这种情况下只有内容里的 `domain` 确实是国际站才采用，
 * 免得误用国内账号。
 *
 * 文件系统访问由调用方注入（`isFile` / `readText`），因此本函数不 import 任何
 * `node:fs`，可以直接用 `node --test` 覆盖。
 *
 * @returns {{ path: string, source: 'default' | 'fallback' | 'missing' }}
 *   `source` 说明这个路径是怎么来的：候选直接命中 / 兜底探测命中 / 一个都不存在。
 */
export async function pickDesktopAuthPath(options) {
  const { candidates, fallbackCandidates, isFile, readText } = options
  for (const candidate of candidates) {
    let exists = false
    try {
      exists = await isFile(candidate)
    } catch {
      exists = false
    }
    if (exists) return { path: candidate, source: 'default' }
  }
  for (const candidate of fallbackCandidates) {
    let text
    try {
      text = await readText(candidate)
    } catch {
      continue
    }
    const credential = parseWorkBuddyAuth(text)
    if (credential !== undefined && isGlobalDomain(credential.domain)) {
      return { path: candidate, source: 'fallback' }
    }
  }
  return { path: candidates[0], source: 'missing' }
}

/**
 * 从产品目录的 `models` 数组里挑出可以当对话模型列出的那批。
 *
 * 上游目录里混着图片/视频之类的非对话模型，桌面 App 的 `listAvailableModels()`
 * 是按 `text-to-image` 这类标签剔除的，这里保持一致；另外要求上下文窗口与最大
 * 输出都是正数，否则 pi-ai 那边用不了。
 *
 * @param {unknown} rawModels 目录里的原始数组
 * @param {Set<string>} nonChatTags 视为「非对话用途」的标签集合
 */
export function selectChatModels(rawModels, nonChatTags) {
  const models = []
  for (const model of Array.isArray(rawModels) ? rawModels : []) {
    if (typeof model !== 'object' || model === null) continue
    const id = typeof model.id === 'string' ? model.id : ''
    if (id === '' || model.disabled === true) continue
    const tags = Array.isArray(model.tags) ? model.tags.map(String) : []
    if (tags.some(tag => nonChatTags.has(tag))) continue
    const input = typeof model.maxInputTokens === 'number' ? model.maxInputTokens : 0
    const output = typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : 0
    if (input <= 0 || output <= 0) continue
    models.push({
      id,
      name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
      contextWindow: input,
      maxTokens: output,
      supportsImages: model.supportsImages === true && model.disabledMultimodal !== true,
      ...resolveUpstreamReasoning(model),
      ...resolveUpstreamBilling(model),
    })
  }
  return models
}

/** 上游失败分类，shim 会把它映射成不同的 HTTP 状态。 */
export function classifyUpstreamError(status, body) {
  if (status === 402) return 'hard_credit'
  const text = String(body ?? '')
  const lower = text.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || text.includes(marker)) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (text.includes(marker)) return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

/**
 * 把上游的 credits 文案收敛成语言无关的倍率显示形式。
 *
 * 上游同一字段有两种写法（`x0.79` 与 `x0.79 credits`），带单位词的那种会把
 * 界面语言钉死在英文，所以这里统一去掉尾部的单位词。
 */
export function normalizeCredits(credits) {
  if (credits === undefined) return undefined
  const trimmed = String(credits).trim()
  if (trimmed === '') return undefined
  if (/^credits?$/iu.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/iu, '').trim()
  return bare === '' ? undefined : bare
}

/**
 * 归一化 OpenAI 请求体，使其符合上游要求：
 *
 * - 强制 `stream: true`（上游不接受非流式）；
 * - `role: "developer"` 改写成 `"system"`（pi-ai 按 OpenAI 约定发 developer，
 *   而上游会以 HTTP 400 / code 11128 "Illegal API invocation from an unapproved
 *   channel" 拒绝它）；
 * - `tool_choice` 压成字符串（上游该字段只接受字符串，对象形式返回 400）。
 */
export function prepareChatBody(source) {
  let body
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  body.stream = true
  const messages = body.messages
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (typeof message === 'object' && message !== null && !Array.isArray(message) && message.role === 'developer') {
        message.role = 'system'
      }
    }
  }
  normalizeToolChoice(body)
  return JSON.stringify(body)
}

/** 把 `tool_choice` 的各种写法压成上游认识的字符串形式。 */
export function normalizeToolChoice(obj) {
  const suppress = () => {
    delete obj.tools
    delete obj.functions
  }
  if (!('tool_choice' in obj)) return
  const choice = obj.tool_choice
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj.tool_choice
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj.tool_choice
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj.tool_choice = type
    } else if (type === 'function') {
      const fn = typeof choice.function === 'object' && choice.function !== null ? choice.function : undefined
      let name = typeof fn?.name === 'string' ? fn.name : ''
      if (name === '' && typeof choice.name === 'string') name = choice.name
      name = name.trim()
      obj.tool_choice = name !== '' ? name : 'auto'
    } else {
      delete obj.tool_choice
    }
    return
  }
  delete obj.tool_choice
}

/** 解析上游 `reasoning` 对象。 */
export function resolveUpstreamReasoning(wrapped) {
  const supports = wrapped.supportsReasoning === true
  const onlyReasoning = wrapped.onlyReasoning === true
  const rawReasoning = wrapped.reasoning
  let supportedEfforts
  let defaultEffort
  let canDisableThinking = true
  if (typeof rawReasoning === 'object' && rawReasoning !== null && !Array.isArray(rawReasoning)) {
    const rawEfforts = rawReasoning.supportedEfforts
    if (Array.isArray(rawEfforts)) {
      const efforts = rawEfforts.filter(value => typeof value === 'string' && EFFORT_VALUES.includes(value))
      if (efforts.length > 0) supportedEfforts = efforts
    }
    if (typeof rawReasoning.defaultEffort === 'string' && EFFORT_VALUES.includes(rawReasoning.defaultEffort)) {
      defaultEffort = rawReasoning.defaultEffort
    } else if (typeof rawReasoning.effort === 'string' && EFFORT_VALUES.includes(rawReasoning.effort)) {
      defaultEffort = rawReasoning.effort
    }
    canDisableThinking = rawReasoning.canDisableThinking === true
  }
  return {
    reasoning: {
      supports,
      onlyReasoning,
      ...supportedEfforts === undefined ? {} : { supportedEfforts },
      ...defaultEffort === undefined ? {} : { defaultEffort },
      canDisableThinking,
    },
  }
}

/** 解析上游 `credits` / `tags` 里的计费信息。 */
export function resolveUpstreamBilling(wrapped) {
  const rawCredits = wrapped.credits
  const credits = typeof rawCredits === 'string' && rawCredits.trim() !== '' ? rawCredits.trim() : undefined
  const badges = []
  if (Array.isArray(wrapped.tags)) {
    for (const tag of wrapped.tags) {
      if (typeof tag !== 'string') continue
      if (!tag.toLowerCase().startsWith('badge:')) continue
      const label = tag.slice('badge:'.length).split(':')[0] ?? tag.slice('badge:'.length)
      if (label !== '') badges.push(label)
    }
  }
  const free = credits !== undefined && /^x?0\.0+$/u.test(credits)
  return {
    billing: {
      ...credits === undefined ? {} : { credits },
      ...badges.length === 0 ? {} : { badges },
      free,
    },
  }
}

/**
 * 把国际版积分接口返回的套餐数组解析成统一的账户列表。
 *
 * 该接口的容量字段是**字符串**（`"250"`），且没有友好名称，只有内部包码。
 */
export function parseGlobalCreditPackages(packages) {
  const accounts = []
  let total = 0
  for (const raw of Array.isArray(packages) ? packages : []) {
    if (typeof raw !== 'object' || raw === null) continue
    const toNumber = (key) => {
      const value = raw[key]
      if (typeof value === 'number') return value
      if (typeof value === 'string') {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : 0
      }
      return 0
    }
    const size = toNumber('CycleTotalCapacity')
    let remain = toNumber('CycleRemainCapacity')
    if (remain < 0) remain = 0
    total += remain
    accounts.push({
      packageName: prettyPackageCode(raw.PackageCode),
      remain,
      size: size > 0 ? size : 0,
    })
  }
  return { total, accounts }
}

/**
 * 把 `TCACA_code_006_DbXS0lrypC` 这类内部包码收拾得能看一点。
 *
 * 尾部那一段是随机后缀，去掉它不丢信息量。国内版接口给的是
 * `PackageName`（"CodeBuddy个人体验版"这种），不需要处理。
 */
export function prettyPackageCode(code) {
  if (typeof code !== 'string' || code.trim() === '') return '(unnamed)'
  const trimmed = code.trim()
  const stripped = trimmed.replace(/_[A-Za-z0-9]{8,}$/u, '')
  return stripped === '' ? trimmed : stripped
}

/** 上游推理档位的合法取值。 */
export const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max']

/** 积分不足的判定标记。 */
export const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** 会话失效的判定标记，含义是「去桌面 App 重新登录」。 */
export const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153']
