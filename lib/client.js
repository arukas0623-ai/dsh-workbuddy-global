/**
 * dsh-workbuddy-global 的浏览器半边：在「设置 → 插件」里挂一张
 * WorkBuddy 国际版账号卡片（登录状态、令牌有效期、剩余积分、模型优惠）。
 *
 * 这个文件是手写的 DSH 客户端 bundle：外层包成 __ModuleLoader__ 的
 * factory 形式，内部只用 require('react')，不经过任何构建步骤。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-global',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 状态文档路径，必须与宿主半边保持一致。 */
    const STATUS_PATH = '/plugins/dsh-workbuddy-global/status'

    /** 卡片文案。 */
    const zh = {
      title: 'WorkBuddy 国际版',
      intro: '在 DSH 中直接使用 WorkBuddy 国际版（workbuddy.ai）的模型，与国内版并存，可随时切换。',
      expand: '展开',
      collapse: '收起',
      loading: '正在读取账号…',
      signedOut: '未登录',
      signedOutHint: '在 WorkBuddy 国际版桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。',
      signedInAs: '已登录：{nickname}',
      accessTokenExpires: '访问令牌 {time} 过期（自动续期）',
      creditsHeading: '剩余积分',
      creditsTotal: '合计：{total}',
      percentRemaining: '剩余 {percent}%',
      exactRemaining: '剩余 {remain} / {size}',
      creditPackageUnknownSize: '剩余 {remain}',
      creditsError: '积分查询失败：{message}',
      refresh: '刷新',
      refreshing: '正在刷新…',
      requestFailed: '请求失败',
      accountHeading: '账号',
      modelsHeading: '模型优惠',
      freeModel: '免费',
      rate: '{rate} 积分/次',
    }

    const en = {
      title: 'WorkBuddy Global',
      intro: 'Use the models in the WorkBuddy global desktop app (workbuddy.ai) directly in DSH — side by side with the domestic route.',
      expand: 'Expand',
      collapse: 'Collapse',
      loading: 'Loading account…',
      signedOut: 'Not signed in',
      signedOutHint: 'Sign in once in the WorkBuddy global desktop app; this plugin follows that sign-in automatically.',
      signedInAs: 'Signed in as {nickname}',
      accessTokenExpires: 'Access token expires {time} (refresh is automatic)',
      creditsHeading: 'Remaining credit',
      creditsTotal: 'Total: {total}',
      percentRemaining: '{percent}% remaining',
      exactRemaining: '{remain} / {size} remaining',
      creditPackageUnknownSize: '{remain} remaining',
      creditsError: 'Credit unavailable: {message}',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      requestFailed: 'Request failed',
      accountHeading: 'Account',
      modelsHeading: 'Model offers',
      freeModel: 'Free',
      rate: '{rate} credits per message',
    }

    const POLL_INTERVAL_MS = 60_000

    const cardStyle = {
      overflow: 'hidden',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-module-platform)',
    }
    const headerStyle = {
      boxSizing: 'border-box',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      border: 0,
      padding: '13px 14px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer',
    }
    const headTextStyle = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 3 }
    const nameStyle = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
    const descriptionStyle = { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
    const chevronStyle = { flex: '0 0 auto', fontSize: 18, lineHeight: 1, transition: 'transform 120ms ease' }
    const cardBodyStyle = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '16px 14px 18px' }
    const bodyStyle = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
    const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
    const statusStyle = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
    const buttonStyle = {
      boxSizing: 'border-box',
      minHeight: 34,
      padding: '6px 14px',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 18,
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 14,
      cursor: 'pointer',
    }
    const errorStyle = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
    const quotaListStyle = { display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 2 }
    const quotaGroupStyle = { display: 'flex', flexDirection: 'column', gap: 10 }
    const quotaTitleStyle = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
    const quotaLabelStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
    const modelOfferStyle = { display: 'flex', flexDirection: 'column', gap: 2 }
    const modelRateStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
    const progressTrackStyle = { height: 8, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }

    function progressFillStyle(percent) {
      return {
        width: `${Math.max(0, Math.min(100, percent))}%`,
        height: '100%',
        borderRadius: 'inherit',
        background: 'var(--dsw-alias-brand-primary, #1677ff)',
      }
    }

    function dotStyle(status) {
      const color = status === 'signed-in'
        ? 'var(--dsw-alias-state-success-primary, #22a06b)'
        : status === 'error'
          ? 'var(--dsw-alias-state-error-primary, #d92d20)'
          : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
      return { width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto', background: color }
    }

    function formatNumber(value) {
      return new Intl.NumberFormat(undefined).format(value)
    }

    function formatTime(ms) {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
    }

    /** 一条套餐余量进度条。 */
    function CreditBar(props) {
      const t = props.t
      const detail = props.size > 0
        ? t('exactRemaining', { remain: formatNumber(props.remain), size: formatNumber(props.size) })
        : t('creditPackageUnknownSize', { remain: formatNumber(props.remain) })
      const percent = props.size > 0 ? (props.remain / props.size) * 100 : 100
      const display = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percent)
      return h('div', { style: quotaGroupStyle },
        h('div', { style: quotaLabelStyle },
          h('span', null, props.label),
          h('span', null, t('percentRemaining', { percent: display }))),
        h('div', {
          style: progressTrackStyle,
          role: 'progressbar',
          'aria-label': props.label,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': percent,
        }, h('div', { style: progressFillStyle(percent) })),
        h('p', { style: bodyStyle }, detail))
    }

    /** 一条模型优惠行。 */
    function ModelOfferRow(props) {
      const t = props.t
      const model = props.model
      return h('div', { style: modelOfferStyle },
        h('div', { style: quotaLabelStyle },
          h('span', null, model.name),
          h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            ...(model.badges ?? []).map(badge => h('span', {
              key: badge,
              style: {
                padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
                background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
                color: 'var(--dsw-alias-state-success-primary, #22a06b)',
              },
            }, badge)),
            model.free === true ? h('span', {
              key: 'free',
              style: {
                padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
                background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
                color: 'var(--dsw-alias-state-success-primary, #22a06b)',
              },
            }, t('freeModel')) : null)),
        model.credits === undefined ? null : h('span', { style: modelRateStyle }, t('rate', { rate: model.credits })))
    }

    /** 展开式卡片本体。 */
    function WorkBuddyGlobalCard(props) {
      const t = props.t
      if (t === undefined) throw new Error('WorkBuddy 国际版卡片缺少翻译函数')
      const [open, setOpen] = React.useState(false)
      const [status, setStatus] = React.useState({ status: 'signed-out' })
      const [busy, setBusy] = React.useState(false)
      const mounted = React.useRef(true)

      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      const refresh = React.useCallback(async (signal) => {
        try {
          const response = await fetch(STATUS_PATH, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            ...signal === undefined ? {} : { signal },
          })
          const value = await response.json().catch(() => undefined)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          if (mounted.current && signal?.aborted !== true) setStatus(value)
        } catch (error) {
          if (mounted.current && signal?.aborted !== true) {
            setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
          }
        }
      }, [t])

      React.useEffect(() => {
        if (!open) return undefined
        const controller = new AbortController()
        void refresh(controller.signal)
        return () => { controller.abort() }
      }, [open, refresh])

      React.useEffect(() => {
        if (!open || status.status !== 'signed-in') return undefined
        const controller = new AbortController()
        const timer = window.setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS)
        return () => {
          window.clearInterval(timer)
          controller.abort()
        }
      }, [open, refresh, status.status])

      const manualRefresh = async () => {
        setBusy(true)
        try {
          await refresh()
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      const title = t('title')
      const label = status.status === 'signed-in'
        ? status.nickname === undefined
          ? t('signedInAs', { nickname: '' }).replace(/[:：]\s*$/, '')
          : t('signedInAs', { nickname: status.nickname })
        : status.status === 'error'
          ? t('requestFailed')
          : t('signedOut')

      return h('li', { style: cardStyle },
        h('button', {
          type: 'button',
          style: headerStyle,
          'aria-expanded': open,
          'aria-label': `${t(open ? 'collapse' : 'expand')}: ${title}`,
          onClick: () => { setOpen(!open) },
        },
        h('span', { style: headTextStyle },
          h('span', { style: nameStyle }, title),
          h('span', { style: descriptionStyle }, t('intro'))),
        h('span', { 'aria-hidden': 'true', style: { ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' } }, '⌄')),
        open
          ? h('div', { style: cardBodyStyle },
            h('h3', { style: quotaTitleStyle }, t('accountHeading')),
            h('div', { style: rowStyle },
              h('div', { style: statusStyle, role: 'status' },
                h('span', { 'aria-hidden': 'true', style: dotStyle(status.status) }),
                h('span', null, label)),
              h('button', { type: 'button', style: buttonStyle, disabled: busy, onClick: () => { void manualRefresh() } },
                busy ? t('refreshing') : t('refresh'))),
            status.status === 'signed-in'
              ? h(React.Fragment, null,
                status.expiresAt === undefined
                  ? null
                  : h('p', { style: bodyStyle }, t('accessTokenExpires', { time: formatTime(status.expiresAt) })),
                status.credits === undefined
                  ? null
                  : h('div', { style: quotaListStyle },
                    h('div', { style: rowStyle },
                      h('h3', { style: quotaTitleStyle }, t('creditsHeading')),
                      h('span', { style: bodyStyle }, t('creditsTotal', { total: formatNumber(status.credits.total) }))),
                    ...status.credits.accounts
                      .filter(account => account.remain > 0)
                      .map((account, index) => h(CreditBar, {
                        key: `${account.packageName}-${String(index)}`,
                        label: account.packageName,
                        remain: account.remain,
                        size: account.size,
                        t,
                      }))),
                status.creditsError === undefined
                  ? null
                  : h('p', { style: errorStyle }, t('creditsError', { message: status.creditsError })),
                status.models === undefined || status.models.length === 0
                  ? null
                  : h('div', { style: quotaListStyle },
                    h('h3', { style: quotaTitleStyle }, t('modelsHeading')),
                    ...status.models.map(model => h(ModelOfferRow, { key: model.id, model, t }))))
              : null,
            status.status === 'signed-out' ? h('p', { style: bodyStyle }, t('signedOutHint')) : null,
            status.status === 'error' ? h('p', { style: errorStyle }, status.message) : null)
          : null)
    }

    const name = 'dsh-workbuddy-global-client'
    const inject = ['slots', 'locale']

    /**
     * 注册文案与卡片。整体包 try/catch：万一 DSH 的插槽 API 变了，
     * 只降级成一条 console.error，不会把加载器整个带崩——宿主 provider 不受影响。
     */
    function apply(ctx) {
      try {
        const namespace = 'settings.workbuddy-global'
        ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-global: settings copy')
        const t = ctx.locale.bind(namespace)
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
          name: 'settings.plugin.item',
          key: 'workbuddy-global',
          priority: 31,
          inject: () => ({ t }),
        }, WorkBuddyGlobalCard))
      } catch (error) {
        console.error('[dsh-workbuddy-global] 设置卡片加载失败（宿主 provider 不受影响）：', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
