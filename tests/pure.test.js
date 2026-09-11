/**
 * 纯函数的单元测试。不依赖 DSH 安装，直接 `node --test` 即可运行。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  classifyUpstreamError,
  isGlobalDomain,
  normalizeCredits,
  parseGlobalCreditPackages,
  parseWorkBuddyAuth,
  pickDesktopAuthPath,
  prepareChatBody,
  resolveUpstreamBilling,
  resolveUpstreamReasoning,
  selectChatModels,
} from '../lib/pure.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 造一份内容为国际站账号的凭据文档。 */
function globalCredentialText(domain = 'www.workbuddy.ai') {
  return JSON.stringify({ auth: { accessToken: 'token', domain } })
}

describe('isGlobalDomain', () => {
  it('认国际站域名', () => {
    assert.equal(isGlobalDomain('www.workbuddy.ai'), true)
    assert.equal(isGlobalDomain('workbuddy.ai'), true)
    assert.equal(isGlobalDomain('WORKBUDDY.AI'), true)
    assert.equal(isGlobalDomain('  www.workbuddy.ai  '), true)
  })

  it('国内站与空值都不算国际站', () => {
    assert.equal(isGlobalDomain('copilot.tencent.com'), false)
    assert.equal(isGlobalDomain('www.codebuddy.cn'), false)
    assert.equal(isGlobalDomain(''), false)
    assert.equal(isGlobalDomain(undefined), false)
    // 形近域名不能被误判
    assert.equal(isGlobalDomain('notworkbuddy.ai'), false)
    assert.equal(isGlobalDomain('workbuddy.ai.evil.com'), false)
  })
})

describe('parseWorkBuddyAuth', () => {
  it('解析 {auth, account} 嵌套形态', () => {
    const credential = parseWorkBuddyAuth(JSON.stringify({
      auth: { accessToken: 'tok', refreshToken: 'ref', expiresAt: 1_800_000_000_000, domain: 'www.workbuddy.ai' },
      account: { uid: 'u-1', nickname: 'someone', enterpriseId: 'ent-1' },
    }))
    assert.equal(credential.accessToken, 'tok')
    assert.equal(credential.refreshToken, 'ref')
    assert.equal(credential.expiresAtMs, 1_800_000_000_000)
    assert.equal(credential.domain, 'www.workbuddy.ai')
    assert.equal(credential.uid, 'u-1')
    assert.equal(credential.nickname, 'someone')
    assert.equal(credential.enterpriseId, 'ent-1')
    assert.equal(credential.source, 'desktop')
  })

  it('秒级过期时间换算成毫秒', () => {
    const credential = parseWorkBuddyAuth(JSON.stringify({ accessToken: 't', expiresAt: 1_800_000_000 }))
    assert.equal(credential.expiresAtMs, 1_800_000_000_000)
  })

  it('解析扁平形态', () => {
    const credential = parseWorkBuddyAuth(JSON.stringify({
      accessToken: 'tok',
      domain: 'copilot.tencent.com',
      uid: 'u-2',
    }))
    assert.equal(credential.accessToken, 'tok')
    assert.equal(credential.domain, 'copilot.tencent.com')
    assert.equal(credential.uid, 'u-2')
  })

  it('没有 accessToken 或不是合法 JSON 时返回 undefined', () => {
    assert.equal(parseWorkBuddyAuth('not json'), undefined)
    assert.equal(parseWorkBuddyAuth('[]'), undefined)
    assert.equal(parseWorkBuddyAuth('{"auth":{"refreshToken":"x"}}'), undefined)
    assert.equal(parseWorkBuddyAuth('{"auth":{"accessToken":""}}'), undefined)
  })
})

describe('prepareChatBody', () => {
  it('强制 stream 并改写 developer 角色', () => {
    const out = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'hy3',
      stream: false,
      messages: [
        { role: 'developer', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
    })))
    assert.equal(out.stream, true)
    assert.equal(out.messages[0].role, 'system')
    assert.equal(out.messages[1].role, 'user')
  })

  it('tool_choice 压成字符串形式', () => {
    const asFunction = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    })))
    assert.equal(asFunction.tool_choice, 'read_file')

    const asAuto = JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'auto' } })))
    assert.equal(asAuto.tool_choice, 'auto')

    const asRequired = JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'required' } })))
    assert.equal(asRequired.tool_choice, 'required')
  })

  it('tool_choice 为 none 时连带清掉 tools / functions', () => {
    const out = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: 'none',
      tools: [{ type: 'function' }],
      functions: [{ name: 'x' }],
    })))
    assert.equal('tool_choice' in out, false)
    assert.equal('tools' in out, false)
    assert.equal('functions' in out, false)
  })

  it('非法 JSON 原样返回，不做破坏', () => {
    assert.equal(prepareChatBody('{oops'), '{oops')
  })
})

describe('normalizeCredits', () => {
  it('去掉尾部的单位词', () => {
    assert.equal(normalizeCredits('x0.79 credits'), 'x0.79')
    assert.equal(normalizeCredits('x0.79 credit'), 'x0.79')
    assert.equal(normalizeCredits('x0.79'), 'x0.79')
    assert.equal(normalizeCredits('  x0.00  '), 'x0.00')
  })

  it('只有单位词或空值时返回 undefined', () => {
    assert.equal(normalizeCredits('credits'), undefined)
    assert.equal(normalizeCredits(''), undefined)
    assert.equal(normalizeCredits('   '), undefined)
    assert.equal(normalizeCredits(undefined), undefined)
  })
})

describe('classifyUpstreamError', () => {
  it('按状态码分类', () => {
    assert.equal(classifyUpstreamError(402, ''), 'hard_credit')
    assert.equal(classifyUpstreamError(429, ''), 'soft_rate')
    assert.equal(classifyUpstreamError(404, ''), 'not_found')
    assert.equal(classifyUpstreamError(500, ''), 'server')
    assert.equal(classifyUpstreamError(400, ''), 'client')
  })

  it('按响应体里的积分/会话标记分类', () => {
    assert.equal(classifyUpstreamError(400, 'insufficient credit'), 'hard_credit')
    assert.equal(classifyUpstreamError(400, '积分不足'), 'hard_credit')
    assert.equal(classifyUpstreamError(400, 'Offline user session not found'), 'session_dead')
    assert.equal(classifyUpstreamError(400, '{"code":12153}'), 'session_dead')
  })
})

describe('resolveUpstreamReasoning', () => {
  it('保留上游声明的档位集合', () => {
    const { reasoning } = resolveUpstreamReasoning({
      supportsReasoning: true,
      onlyReasoning: true,
      reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true },
    })
    assert.equal(reasoning.supports, true)
    assert.deepEqual(reasoning.supportedEfforts, ['low', 'high', 'max'])
    assert.equal(reasoning.defaultEffort, 'high')
    assert.equal(reasoning.canDisableThinking, true)
  })

  it('过滤掉上游不认识档位值，全被过滤时视为没有声明', () => {
    const { reasoning } = resolveUpstreamReasoning({
      supportsReasoning: true,
      reasoning: { supportedEfforts: ['low', 'bogus'] },
    })
    assert.deepEqual(reasoning.supportedEfforts, ['low'])

    const none = resolveUpstreamReasoning({ supportsReasoning: true, reasoning: { supportedEfforts: ['bogus'] } })
    assert.equal(none.reasoning.supportedEfforts, undefined)
  })

  it('canDisableThinking 只有显式 true 才算真', () => {
    const { reasoning } = resolveUpstreamReasoning({ supportsReasoning: true, reasoning: {} })
    assert.equal(reasoning.canDisableThinking, false)
  })

  it('旧形态的 effort 字段也能当默认档位', () => {
    const { reasoning } = resolveUpstreamReasoning({
      supportsReasoning: true,
      reasoning: { effort: 'medium', summary: 'auto' },
    })
    assert.equal(reasoning.defaultEffort, 'medium')
    assert.equal(reasoning.supportedEfforts, undefined)
  })
})

describe('resolveUpstreamBilling', () => {
  it('x0.00 视为免费', () => {
    assert.equal(resolveUpstreamBilling({ credits: 'x0.00' }).billing.free, true)
    assert.equal(resolveUpstreamBilling({ credits: 'x0.79' }).billing.free, false)
    assert.equal(resolveUpstreamBilling({}).billing.free, false)
  })

  it('从 badge: 前缀的 tag 里取促销标签', () => {
    const { billing } = resolveUpstreamBilling({ tags: ['badge:限时免费:#FF0000', 'craft', 'badge:夜间折扣:#1E90FF'] })
    assert.deepEqual(billing.badges, ['限时免费', '夜间折扣'])
  })
})

describe('parseGlobalCreditPackages', () => {
  it('解析字符串容量的套餐数组，并收掉包码的随机后缀', () => {
    const credits = parseGlobalCreditPackages([
      { PackageCode: 'TCACA_code_006_AbCdEfGh', CycleTotalCapacity: '250', CycleRemainCapacity: '250' },
      { PackageCode: 'TCACA_code_035_XyZ12345', CycleTotalCapacity: '100', CycleRemainCapacity: '100' },
    ])
    assert.equal(credits.total, 350)
    assert.equal(credits.accounts.length, 2)
    assert.deepEqual(credits.accounts[0], { packageName: 'TCACA_code_006', remain: 250, size: 250 })
  })

  it('也接受数字形态，并容错缺字段与负数', () => {
    const credits = parseGlobalCreditPackages([
      { PackageCode: 'a', CycleTotalCapacity: 10, CycleRemainCapacity: 4 },
      { PackageCode: '', CycleTotalCapacity: 'oops', CycleRemainCapacity: '-5' },
      null,
      'junk',
    ])
    assert.equal(credits.total, 4)
    assert.deepEqual(credits.accounts[0], { packageName: 'a', remain: 4, size: 10 })
    assert.deepEqual(credits.accounts[1], { packageName: '(unnamed)', remain: 0, size: 0 })
  })

  it('非数组输入返回空结果', () => {
    assert.deepEqual(parseGlobalCreditPackages(undefined), { total: 0, accounts: [] })
  })
})

describe('pickDesktopAuthPath', () => {
  /** 一个假文件系统：只有列出的路径存在。 */
  function fakeFs(files) {
    return {
      isFile: async candidate => Object.hasOwn(files, candidate),
      readText: async candidate => {
        if (!Object.hasOwn(files, candidate)) {
          const error = new Error(`ENOENT: ${candidate}`)
          error.code = 'ENOENT'
          throw error
        }
        return files[candidate]
      },
    }
  }

  const preferred = ['/auth/workbuddy-desktop-ai.info', '/roaming/workbuddy-desktop-ai.info']
  const fallback = ['/auth/workbuddy-desktop.info']

  it('首选文件存在时直接命中，不碰兜底', async () => {
    const picked = await pickDesktopAuthPath({
      candidates: preferred,
      fallbackCandidates: fallback,
      ...fakeFs({
        [preferred[0]]: globalCredentialText(),
        [fallback[0]]: globalCredentialText('copilot.tencent.com'),
      }),
    })
    assert.deepEqual(picked, { path: preferred[0], source: 'default' })
  })

  it('首选不存在时按候选顺序继续找', async () => {
    const picked = await pickDesktopAuthPath({
      candidates: preferred,
      fallbackCandidates: fallback,
      ...fakeFs({ [preferred[1]]: globalCredentialText() }),
    })
    assert.deepEqual(picked, { path: preferred[1], source: 'default' })
  })

  it('首选都不存在、兜底文件里确实是国际账号时采用兜底', async () => {
    const picked = await pickDesktopAuthPath({
      candidates: preferred,
      fallbackCandidates: fallback,
      ...fakeFs({ [fallback[0]]: globalCredentialText() }),
    })
    assert.deepEqual(picked, { path: fallback[0], source: 'fallback' })
  })

  it('兜底文件其实是国内账号时不采用，只报首选路径', async () => {
    const picked = await pickDesktopAuthPath({
      candidates: preferred,
      fallbackCandidates: fallback,
      ...fakeFs({ [fallback[0]]: globalCredentialText('copilot.tencent.com') }),
    })
    assert.deepEqual(picked, { path: preferred[0], source: 'missing' })
  })

  it('兜底文件存在但解析不出令牌时也不采用', async () => {
    const picked = await pickDesktopAuthPath({
      candidates: preferred,
      fallbackCandidates: fallback,
      ...fakeFs({ [fallback[0]]: '{"auth":{"refreshToken":"only"}}' }),
    })
    assert.deepEqual(picked, { path: preferred[0], source: 'missing' })
  })

  it('文件系统报错（例如权限）时当作不存在，不抛出去', async () => {
    const picked = await pickDesktopAuthPath({
      candidates: preferred,
      fallbackCandidates: fallback,
      isFile: async () => { throw new Error('EACCES') },
      readText: async () => { throw new Error('EACCES') },
    })
    assert.deepEqual(picked, { path: preferred[0], source: 'missing' })
  })
})

describe('selectChatModels', () => {
  const NON_CHAT = new Set(['text-to-image'])

  it('保留只出现在 /v3/config 目录里的那三个模型', () => {
    // 这三个 id 不在 `/v2/enterprises/personal/models` 的账号目录里，只在桌面 App
    // 用的 `/v3/config`（带 App UA）里。
    const models = selectChatModels([
      { id: 'gpt-6-astra', name: 'GPT-6-Astra', credits: 'x6.67', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: true, defaultEffort: 'high', supportedEfforts: ['low', 'high'] } },
      { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.00', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high' } },
      { id: 'hy4-preview-f', name: 'Hy4 preview', credits: 'x0.00', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { supportedEfforts: ['high'], defaultEffort: 'high' } },
    ], NON_CHAT)
    assert.deepEqual(models.map(m => m.id), ['gpt-6-astra', 'deepseek-v4.1-flash', 'hy4-preview-f'])
    assert.equal(models[0].contextWindow, 1_000_000)
    assert.equal(models[0].reasoning.supportedEfforts.join(','), 'low,high')
    assert.equal(models[1].billing.free, true)
    assert.equal(models[1].billing.credits, 'x0.00')
    assert.equal(models[2].billing.free, true)
  })

  it('剔除非对话标签的模型（与桌面 App 的 listAvailableModels 一致）', () => {
    const models = selectChatModels([
      { id: 'gemini-3.0-pro-image', maxInputTokens: 1_000_000, maxOutputTokens: 8_000, tags: ['text-to-image'] },
      { id: 'hunyuan-video-art', maxInputTokens: 1_000_000, maxOutputTokens: 8_000, tags: ['text-to-image', 'craft'] },
      { id: 'glm-5.3', maxInputTokens: 1_000_000, maxOutputTokens: 48_000, tags: ['craft'] },
    ], NON_CHAT)
    assert.deepEqual(models.map(m => m.id), ['glm-5.3'])
  })

  it('缺上下文窗口/输出上限、disabled、以及非对象条目一律跳过', () => {
    const models = selectChatModels([
      { id: 'no-limit' },
      { id: 'zero', maxInputTokens: 0, maxOutputTokens: 0 },
      { id: 'off', maxInputTokens: 100, maxOutputTokens: 100, disabled: true },
      { id: '', maxInputTokens: 100, maxOutputTokens: 100 },
      null,
      'junk',
      { id: 'ok', maxInputTokens: 100, maxOutputTokens: 100 },
    ], NON_CHAT)
    assert.deepEqual(models.map(m => m.id), ['ok'])
  })

  it('非数组输入返回空结果', () => {
    assert.deepEqual(selectChatModels(undefined, NON_CHAT), [])
    assert.deepEqual(selectChatModels({ models: [] }, NON_CHAT), [])
  })
})

describe('包元数据', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

  it('心跳里上报的版本号与 package.json 一致', () => {
    const index = readFileSync(join(REPO_ROOT, 'lib', 'index.js'), 'utf8')
    const declared = /const PLUGIN_VERSION = '([^']+)'/u.exec(index)?.[1]
    assert.equal(declared, pkg.version)
  })

  it('README 让用户跑的东西，都真的会被打包进去', () => {
    // `github:` 安装按 npm pack 语义走 `files`，README 里提到而 files 里没有的，
    // 用户装完根本找不到——这里用 README 的真实引用做守卫。
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')
    const referenced = new Set()
    for (const match of readme.matchAll(/(?:node|npx)\s+(tools\/[\w.-]+)/gu)) {
      referenced.add(match[1].split('/')[0])
    }
    if (/node --test\s+tests\//u.test(readme)) referenced.add('tests')
    assert.ok(referenced.size > 0, 'README 里没找到可执行引用，守卫失效')
    for (const entry of referenced) {
      assert.ok(pkg.files.includes(entry), `README 引用了 ${entry}/，但 package.json 的 files 里没有`)
    }
  })

  it('files 覆盖插件运行所需的一切', () => {
    for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
      assert.ok(pkg.files.includes(entry), `files 缺少 ${entry}`)
    }
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(pkg.main, 'lib/index.js')
  })

  it('兜底模型表包含只有 /v3/config 才有的那三个模型', () => {
    // 兜底表是首帧用的；它如果照 `/v2` 的账号目录重新生成，就会把这几个漏掉。
    // 这里做的是文本级断言（index.js 依赖 DSH，无法直接 import）。
    const index = readFileSync(join(REPO_ROOT, 'lib', 'index.js'), 'utf8')
    for (const id of ['gpt-6-astra', 'deepseek-v4.1-flash', 'hy4-preview-f']) {
      assert.ok(index.includes(`id: '${id}'`), `兜底模型表缺少 ${id}`)
    }
    // 目录接口必须是 App 用的那个，且带 App 的 UA
    assert.ok(index.includes("const CONFIG_PATH = '/v3/config'"), '缺少 /v3/config 目录路径')
    assert.ok(index.includes('WorkBuddyAI/5.5.2'), '缺少桌面 App 的 User-Agent')
  })
})
