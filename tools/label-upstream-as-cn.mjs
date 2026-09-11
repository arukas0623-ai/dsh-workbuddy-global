/**
 * 给官方插件 dsh-workbuddy-connect（国内版）加上「国内版」标识，
 * 让它在模型选择器和设置卡片里与 dsh-workbuddy-global（国际版）一眼可分。
 *
 * 官方插件是 npm 包，升级会覆盖 node_modules 里的文件，所以每次升级后
 * 重新跑一遍即可。脚本幂等：已经打过就跳过，改前自动备份。
 *
 * 用法：
 *   node tools/label-upstream-as-cn.mjs                    # 默认 profile = web
 *   node tools/label-upstream-as-cn.mjs --profile desktop
 *   node tools/label-upstream-as-cn.mjs --dsh-home D:/my-dsh
 *   node tools/label-upstream-as-cn.mjs --restore          # 从备份还原
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 官方插件要改的片段：宿主半边的 provider 名与显示名。 */
const INDEX_EDITS = [
  ['name: "WorkBuddy",', 'name: "WorkBuddy 国内版",'],
  ['displayName: "WorkBuddy",', 'displayName: "WorkBuddy 国内版",'],
]

/** 客户端半边的卡片文案，按出现顺序：先 en，后 zh。 */
const CLIENT_EDITS = [
  ['title: "DSH WorkBuddy Connect",', 'title: "WorkBuddy China",'],
  [
    'intro: "Use the models in the WorkBuddy desktop app directly in DSH — zero configuration, ready out of the box.",',
    'intro: "Use the models in the WorkBuddy China desktop app (codebuddy.cn) directly in DSH — side by side with the global route.",',
  ],
  ['title: "DSH WorkBuddy Connect",', 'title: "WorkBuddy 国内版",'],
  [
    'intro: "在 DSH 中直接使用 WorkBuddy 桌面 App 包含的模型，开箱即用，无需额外配置。",',
    'intro: "在 DSH 中直接使用 WorkBuddy 国内版（codebuddy.cn）的模型，与 WorkBuddy 国际版并存，可随时切换。",',
  ],
]

/** 解析 `--flag value` 形式的参数。 */
function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 || process.argv[at + 1] === undefined ? fallback : process.argv[at + 1]
}

const profile = flag('profile', 'web')
const dshHome = flag('dsh-home', join(homedir(), '.dsh'))
const restore = process.argv.includes('--restore')

const LIB = join(dshHome, 'profiles', profile, 'node_modules', 'dsh-workbuddy-connect', 'lib')

/** 替换第一次出现的位置（用于区分 en / zh 两块同名文案）。 */
function replaceFirst(text, from, to) {
  const at = text.indexOf(from)
  if (at === -1) return { text, changed: false }
  return { text: text.slice(0, at) + to + text.slice(at + from.length), changed: true }
}

/** 替换全部出现的位置。 */
function replaceAll(text, from, to) {
  if (!text.includes(from)) return { text, changed: false }
  return { text: text.split(from).join(to), changed: true }
}

/** 找出同名备份里最新的一个。 */
function newestBackup(path) {
  const dir = join(path, '..')
  const base = `${path.split(/[/\\]/u).pop()}.bak-`
  const candidates = readdirSync(dir)
    .filter(name => name.startsWith(base))
    .sort()
  return candidates.length === 0 ? undefined : join(dir, candidates[candidates.length - 1])
}

async function patchFile(path, edits, label) {
  if (!existsSync(path)) {
    console.error(`跳过 ${label}：找不到 ${path}`)
    return false
  }
  let text = readFileSync(path, 'utf8')
  let changed = false
  for (const [from, to] of edits) {
    if (text.includes(to)) {
      console.log(`  ${label}: 已是目标状态，跳过 —— ${JSON.stringify(to)}`)
      continue
    }
    const all = from.startsWith('name:') || from.startsWith('displayName:')
    const result = all ? replaceAll(text, from, to) : replaceFirst(text, from, to)
    if (result.changed) {
      text = result.text
      changed = true
      console.log(`  ${label}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`)
    } else {
      console.log(`  ${label}: 没找到 ${JSON.stringify(from)}（上游可能改过版式，请人工确认）`)
    }
  }
  if (changed) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    copyFileSync(path, `${path}.bak-${stamp}`)
    writeFileSync(path, text, 'utf8')
  }
  return changed
}

async function restoreFile(path, label) {
  if (!existsSync(path)) {
    console.error(`跳过 ${label}：找不到 ${path}`)
    return false
  }
  const backup = newestBackup(path)
  if (backup === undefined) {
    console.log(`  ${label}: 没有备份可还原`)
    return false
  }
  copyFileSync(backup, path)
  console.log(`  ${label}: 已从 ${backup} 还原`)
  return true
}

console.log(`profile=${profile}  dshHome=${dshHome}`)
console.log(restore ? '从备份还原…' : '给官方插件加「国内版」标识…')

if (restore) {
  await restoreFile(join(LIB, 'index.js'), 'index.js')
  await restoreFile(join(LIB, 'client.js'), 'client.js')
  console.log('\n已还原。重启 DSH 后生效。')
} else {
  const a = await patchFile(join(LIB, 'index.js'), INDEX_EDITS, 'index.js')
  const b = await patchFile(join(LIB, 'client.js'), CLIENT_EDITS, 'client.js')
  console.log(a || b ? '\n已写入。重启 DSH 后生效。' : '\n无需改动。')
}
