/**
 * dsh-plugin-xefg-think — browser half.
 *
 * One pill in the session header's action row: the on/off switch for the whole
 * experiment, plus a popover with the three thresholds that actually change
 * behaviour and the live counters the host accumulates. Nothing here touches
 * the model; it only flips state through POST /xefg-think/state.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-xefg-think',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'xefgThink'
    const STATE_URL = '/xefg-think/state'
    const STYLE_TAG = 'dsh-plugin-xefg-think/pill.css'

    const CSS = `
.xfg-root{position:relative;display:inline-flex;align-items:center}
.xfg-trigger{min-height:28px;display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.xfg-trigger:hover,.xfg-trigger:focus-visible{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.xfg-trigger[data-on="1"]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.xfg-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.xfg-trigger[data-on="1"] .xfg-dot{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 22%,transparent)}
.xfg-mono{font-family:var(--dsw-font-mono);font-size:11px;letter-spacing:.02em}
.xfg-pop{z-index:120;position:absolute;bottom:calc(100% + 6px);right:0;width:284px;max-height:min(70vh,520px);overflow:auto;box-sizing:border-box;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:linear-gradient(0deg,var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05)),var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))),#1c1c20;box-shadow:var(--dsw-shadow-lv3);display:flex;flex-direction:column;gap:9px}
.xfg-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.xfg-title{font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);font-weight:600}
.xfg-ver{font-family:var(--dsw-font-mono);font-size:10px;color:var(--dsw-alias-label-tertiary)}
.xfg-switch{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover);font-size:12px;color:var(--dsw-alias-label-primary)}
.xfg-switch input{accent-color:var(--dsw-alias-state-success-primary);margin:0}
.xfg-row{display:flex;flex-direction:column;gap:3px}
.xfg-row-top{display:flex;justify-content:space-between;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.xfg-row-top b{font-family:var(--dsw-font-mono);font-weight:500;color:var(--dsw-alias-label-primary)}
.xfg-row input[type=range]{width:100%;accent-color:var(--dsw-alias-label-secondary);margin:0}
.xfg-select{width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:#1c1c20;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:16px}
.xfg-hint{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.xfg-stats{display:grid;grid-template-columns:1fr 1fr;gap:5px 8px;padding:7px 8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1)}
.xfg-stat{display:flex;justify-content:space-between;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.xfg-stat b{font-family:var(--dsw-font-mono);font-weight:500;color:var(--dsw-alias-label-primary)}
.xfg-foot{display:flex;justify-content:space-between;align-items:center;gap:8px}
.xfg-link{border:0;background:0 0;padding:0;font:inherit;font-size:11px;color:var(--dsw-alias-label-tertiary);cursor:pointer;text-decoration:underline}
.xfg-link:hover{color:var(--dsw-alias-label-primary)}
.xfg-err{font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary)}
`

    const zh = {
      'pill.label': 'XeFG',
      'pill.aria': 'XeFG 思考帧生成：开 / 关',
      'panel.title': 'XeFG Thinking',
      'panel.toggle': '启用帧生成式思考协议',
      'panel.strict': '严格模式：可疑 ref 也算空洞',
      'panel.gate': '证据门',
      'panel.gateHole': '没标 = 空洞（默认拒绝）',
      'panel.gateWarn': '只警告不阻断',
      'panel.gateOff': '关闭（忽略该字段）',
      'panel.gateHint': '每个单元必须标 binary/service；没标或标 assumed 视为未落地。',
      'panel.holeMax': '空洞阈值',
      'panel.holeMaxHint': '帧内空洞占比超过此值时判为 EXPAND（必须先去落地）',
      'panel.tauFlow': '光流匹配阈值',
      'panel.tauFlowHint': '相邻帧单元的最小余弦相似度，低于此值判为遮挡',
      'panel.beta': '融合锐度 β',
      'panel.betaHint': '多项 warp 融合 softmax 的锐度，越大越偏向最近一帧',
      'panel.stats': '本次累计',
      'panel.calls': '调用',
      'panel.holes': '空洞',
      'panel.dropped': '丢弃帧',
      'panel.saved': '省下 token',
      'panel.reset': '清零计数',
      'panel.off': '关闭时不注入任何提示词和工具，token 成本为零。',
      'panel.on': '已启用：系统提示注入协议，并挂载 xefg_frame / xefg_verify。',
      'panel.error': '无法连接宿主插件（{msg}）',
    }

    const en = {
      'pill.label': 'XeFG',
      'pill.aria': 'XeFG frame-generated thinking: on / off',
      'panel.title': 'XeFG Thinking',
      'panel.toggle': 'Enable the frame-extrapolation protocol',
      'panel.strict': 'Strict: a suspect ref counts as a hole',
      'panel.gate': 'Evidence gate',
      'panel.gateHole': 'Unlabelled = hole (default-deny)',
      'panel.gateWarn': 'Warn only',
      'panel.gateOff': 'Off (ignore the field)',
      'panel.gateHint': 'Every unit must claim binary/service; unlabelled or assumed counts as ungrounded.',
      'panel.holeMax': 'Hole threshold',
      'panel.holeMaxHint': 'Hole ratio above which a frame is EXPAND (go ground it first)',
      'panel.tauFlow': 'Flow match threshold',
      'panel.tauFlowHint': 'Minimum cosine for a warp to count; below this the unit is occluded',
      'panel.beta': 'Blend sharpness β',
      'panel.betaHint': 'Softmax sharpness over warped references; higher favours the nearest frame',
      'panel.stats': 'Session totals',
      'panel.calls': 'calls',
      'panel.holes': 'holes',
      'panel.dropped': 'dropped',
      'panel.saved': 'tokens saved',
      'panel.reset': 'reset counters',
      'panel.off': 'While off, no prompt text and no tools are contributed — zero token cost.',
      'panel.on': 'On: protocol injected into the system prompt, xefg_frame / xefg_verify mounted.',
      'panel.error': 'Cannot reach the host plugin ({msg})',
    }

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-xefg-think'
      tag.dataset.pluginCss = STYLE_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    async function request(method, body) {
      const res = await fetch(STATE_URL, {
        method,
        headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || 'HTTP ' + res.status)
      return data
    }

    function Row(props) {
      const { label, hint, value, min, max, step, onInput, format } = props
      return h(
        'div',
        { className: 'xfg-row' },
        h(
          'div',
          { className: 'xfg-row-top' },
          h('span', null, label),
          h('b', null, format ? format(value) : String(value))
        ),
        h('input', {
          type: 'range',
          min,
          max,
          step,
          value,
          onChange: (e) => onInput(Number(e.target.value)),
          'aria-label': label,
        }),
        hint ? h('div', { className: 'xfg-hint' }, hint) : null
      )
    }

    function Pill(props) {
      // The composer slot passes `zone`; other slots pass `sessionId`. Neither is
      // needed, but `t` must never be assumed — a throwing slot can blank the
      // whole composer, and a settings toggle is not worth that risk.
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        request('GET')
          .then((data) => {
            if (alive) setState(data)
          })
          .catch((e) => {
            if (alive) setError(e instanceof Error ? e.message : String(e))
          })
        return () => {
          alive = false
        }
      }, [])

      React.useEffect(() => {
        if (!open) return
        const onDown = (e) => {
          if (e.target instanceof Node && !rootRef.current?.contains(e.target)) setOpen(false)
        }
        const onKey = (e) => {
          if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const push = (patch) => {
        setBusy(true)
        setError(null)
        request('POST', patch)
          .then((data) => setState(data))
          .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false))
      }

      const enabled = state?.enabled === true
      const params = state?.params || {}
      const stats = state?.stats || {}

      const label = error ? t('pill.label') : enabled ? t('pill.label') + ' on' : t('pill.label')

      return h(
        'div',
        { className: 'xfg-root', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: 'xfg-trigger',
            'data-on': enabled ? '1' : '0',
            'aria-label': t('pill.aria'),
            'aria-expanded': open,
            disabled: busy,
            title: error ? t('panel.error', { msg: error }) : enabled ? t('panel.on') : t('panel.off'),
            onClick: () => setOpen((v) => !v),
          },
          h('span', { className: 'xfg-dot' }),
          h('span', { className: 'xfg-mono' }, label)
        ),
        open && state
          ? h(
              'div',
              { className: 'xfg-pop', role: 'dialog', 'aria-label': t('panel.title') },
              h(
                'div',
                { className: 'xfg-head' },
                h('span', { className: 'xfg-title' }, t('panel.title')),
                h('span', { className: 'xfg-ver' }, 'v' + (state.version || '?') + ' · e' + (state.engine || '?'))
              ),
              h(
                'label',
                { className: 'xfg-switch' },
                h('input', {
                  type: 'checkbox',
                  checked: enabled,
                  onChange: (e) => push({ enabled: e.target.checked }),
                }),
                h('span', null, t('panel.toggle'))
              ),
              h(Row, {
                label: t('panel.holeMax'),
                hint: t('panel.holeMaxHint'),
                value: params.holeMax ?? 0.34,
                min: 0.05,
                max: 1,
                step: 0.01,
                format: (v) => v.toFixed(2),
                onInput: (v) => push({ params: { holeMax: v } }),
              }),
              h(Row, {
                label: t('panel.tauFlow'),
                hint: t('panel.tauFlowHint'),
                value: params.tauFlow ?? 0.45,
                min: 0.05,
                max: 0.95,
                step: 0.01,
                format: (v) => v.toFixed(2),
                onInput: (v) => push({ params: { tauFlow: v } }),
              }),
              h(Row, {
                label: t('panel.beta'),
                hint: t('panel.betaHint'),
                value: params.beta ?? 6,
                min: 0.5,
                max: 20,
                step: 0.5,
                format: (v) => String(v),
                onInput: (v) => push({ params: { beta: v } }),
              }),
              h(
                'label',
                { className: 'xfg-switch' },
                h('input', {
                  type: 'checkbox',
                  checked: params.weakAsHole === true,
                  onChange: (e) => push({ params: { weakAsHole: e.target.checked } }),
                }),
                h('span', null, t('panel.strict'))
              ),
              h(
                'div',
                { className: 'xfg-row' },
                h(
                  'div',
                  { className: 'xfg-row-top' },
                  h('span', null, t('panel.gate')),
                  h('b', null, params.evidenceGate || 'hole')
                ),
                h(
                  'select',
                  {
                    className: 'xfg-select',
                    value: params.evidenceGate || 'hole',
                    onChange: (e) => push({ params: { evidenceGate: e.target.value } }),
                    'aria-label': t('panel.gate'),
                  },
                  h('option', { value: 'hole' }, t('panel.gateHole')),
                  h('option', { value: 'warn' }, t('panel.gateWarn')),
                  h('option', { value: 'off' }, t('panel.gateOff'))
                ),
                h('div', { className: 'xfg-hint' }, t('panel.gateHint'))
              ),
              h(
                'div',
                { className: 'xfg-stats' },
                h('div', { className: 'xfg-stat' }, h('span', null, t('panel.calls')), h('b', null, String(stats.calls ?? 0))),
                h('div', { className: 'xfg-stat' }, h('span', null, t('panel.holes')), h('b', null, String(stats.holes ?? 0))),
                h('div', { className: 'xfg-stat' }, h('span', null, t('panel.dropped')), h('b', null, String(stats.dropped ?? 0))),
                h('div', { className: 'xfg-stat' }, h('span', null, t('panel.saved')), h('b', null, String(stats.tokensSaved ?? 0)))
              ),
              h(
                'div',
                { className: 'xfg-foot' },
                h('span', { className: 'xfg-hint' }, enabled ? t('panel.on') : t('panel.off')),
                h(
                  'button',
                  { type: 'button', className: 'xfg-link', onClick: () => push({ resetStats: true }) },
                  t('panel.reset')
                )
              ),
              error ? h('div', { className: 'xfg-err' }, t('panel.error', { msg: error })) : null
            )
          : null
      )
    }

    const inject = ['slots', 'locale']

    // One surface, in the composer row: it renders on the landing page AND in a
    // live session, unlike conversation.session.header.actions which only exists
    // once a session does.
    const SLOT = 'conversation.input.right'

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xefg-think: dictionaries')
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: 'xefg-think',
            order: 30,
            locale: NS,
          },
          Pill
        )
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'xefg-think'
    return module.exports
  },
})
