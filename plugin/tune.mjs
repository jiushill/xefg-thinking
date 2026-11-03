/**
 * Tuning sweep. Labelled chains -> precision/recall of the hole flag, cost proxy
 * (frames forced to EXPAND), and redundancy behaviour, across the knobs that
 * actually change decisions.
 *
 *   node tune.mjs
 *
 * Labels are per unit: 'derived' (legitimately inferable) or 'fabricated'
 * (unsupported — the thing we want λ=1 on). Root frames are excluded: they are
 * premises, not inferences.
 */
import { analyseChain } from './lib/engine.js'

const A = (text) => ({ text })

const CHAINS = [
  {
    id: 'A-en-refs',
    restatements: ['F3.0'],
    anchors: [A('the cache key is built from the raw request path')],
    frames: [
      { id: 'F0', units: [A('the cache key is built from the raw request path')] },
      {
        id: 'F1',
        units: [
          { ...A('the cache key ignores the query string'), ref: 'F0.0' },
          { ...A('two different queries therefore share one cache entry'), ref: 'F0.0' },
        ],
      },
      {
        id: 'F2',
        units: [
          { ...A('the cached response for /items is served to /items?page=2'), ref: 'F1.1' },
          A('the TTL was raised to thirty minutes last Tuesday'),
        ],
      },
      { id: 'F3', units: [{ ...A('the cache key ignores the query string'), ref: 'F1.0' }] },
    ],
    labels: { 'F1.0': 'derived', 'F1.1': 'derived', 'F2.0': 'derived', 'F2.1': 'fabricated', 'F3.0': 'derived' },
  },
  {
    id: 'B-zh-refs',
    restatements: [],
    anchors: [A('写路径在整个请求期间持有行锁')],
    frames: [
      { id: 'F0', units: [A('写路径在整个请求期间持有行锁')] },
      { id: 'F1', units: [{ ...A('行锁覆盖整个请求周期，写请求只能排队'), ref: 'F0.0' }] },
      {
        id: 'F2',
        units: [
          { ...A('热点租户的写请求全部串行化'), ref: 'F1.0' },
          A('值班工程师关闭了队列深度告警'),
          A('连接池在14:01被改成了20个连接'),
        ],
      },
    ],
    labels: { 'F1.0': 'derived', 'F2.0': 'derived', 'F2.1': 'fabricated', 'F2.2': 'fabricated' },
  },
  {
    id: 'C-en-autof low',
    restatements: [],
    anchors: [A('p99 rose from 40ms to 900ms at 14:02')],
    frames: [
      { id: 'F0', units: [A('p99 rose from 40ms to 900ms at 14:02')] },
      { id: 'F1', units: [A('p99 rose from 40ms to 900ms at 14:02')] },
      { id: 'F2', units: [A('the deploy at 14:00 rewrote the write path')] },
      { id: 'F3', units: [A('the DBA flapped the primary at 14:05')] },
    ],
    labels: { 'F1.0': 'derived', 'F2.0': 'fabricated', 'F3.0': 'fabricated' },
  },
  {
    id: 'D-zh-auto',
    restatements: [],
    anchors: [A('服务端在14:02返回500的比例升到40%')],
    frames: [
      { id: 'F0', units: [A('服务端在14:02返回500的比例升到40%')] },
      { id: 'F1', units: [A('服务端在14:02返回500的比例升到40%')] },
      { id: 'F2', units: [A('网关重试时把请求打到了已经下线的节点')] },
      { id: 'F3', units: [A('发布流程里缺少健康检查等待步骤')] },
    ],
    labels: { 'F1.0': 'derived', 'F2.0': 'fabricated', 'F3.0': 'fabricated' },
  },
  {
    id: 'E-en-adversarial',
    restatements: [],
    anchors: [A('the lock is held per transaction')],
    frames: [
      { id: 'F0', units: [A('the lock is held per transaction')] },
      { id: 'F1', units: [{ ...A('writers queue behind the lock'), ref: 'F0.0' }] },
      { id: 'F2', units: [{ ...A('the deadlock detector was disabled in 2023'), ref: 'F1.0' }] },
    ],
    labels: { 'F1.0': 'derived', 'F2.0': 'fabricated' },
  },
  {
    id: 'F-en-paraphrase',
    restatements: ['F2.0'],
    anchors: [A('sockets are never released on error')],
    frames: [
      { id: 'F0', units: [A('sockets are never released on error')] },
      { id: 'F1', units: [{ ...A('a failing request leaks one connection every time'), ref: 'F0.0' }] },
      { id: 'F2', units: [{ ...A('every failing request leaks one connection'), ref: 'F1.0' }] },
    ],
    labels: { 'F1.0': 'derived', 'F2.0': 'derived' },
  },
  {
    id: 'G-zh-holechain',
    restatements: [],
    anchors: [A('发布在14:00完成')],
    frames: [
      { id: 'F0', units: [A('发布在14:00完成')] },
      { id: 'F1', units: [A('这次迁移重写了分片映射表')] },
      { id: 'F2', units: [{ ...A('分片映射表重写把热点租户搬到了新节点'), ref: 'F1.0' }] },
    ],
    labels: { 'F1.0': 'fabricated', 'F2.0': 'fabricated' },
  },
]

function score(params) {
  let tp = 0
  let fp = 0
  let fn = 0
  let weakHit = 0
  let weakMiss = 0
  let expand = 0
  let frames = 0
  let dropHit = 0
  let dropTotal = 0
  let dropFalse = 0
  let chains = 0

  for (const chain of CHAINS) {
    // The geometric half is what these sweeps measure, so the evidence gate is
    // off here; the gate has its own section at the end.
    const r = analyseChain({ anchors: chain.anchors, frames: chain.frames }, { evidenceGate: 'off', ...params })
    if (!r.ok) continue
    chains++
    frames += r.frames.length
    expand += r.frames.filter((f) => f.verdict === 'EXPAND').length
    for (const f of r.frames) {
      if (f.verdict === 'DROP' && !chain.restatements.includes(f.units[0].key)) dropFalse++
    }
    // Taint: a unit whose source was itself a hole. Detection = λ ∨ taint.
    const tainted = new Set()
    for (const v of r.violations) if (v.code === 'HOLE_CHAIN') tainted.add(v.unit)
    for (const f of r.frames) {
      for (const u of f.units) {
        const label = chain.labels[u.key]
        if (!label || f.index === 0) continue
        const flagged = u.lambda === 1 || tainted.has(u.key)
        if (label === 'fabricated') {
          if (flagged) tp++
          else {
            fn++
            // the soft channel: a ref that barely resembles its source
            if (u.weak) weakHit++
            else weakMiss++
          }
        } else if (flagged) fp++
      }
    }
    for (const key of chain.restatements) {
      dropTotal++
      const f = r.frames.find((fr) => fr.units.some((u) => u.key === key))
      if (f && f.verdict === 'DROP') dropHit++
    }
  }

  const precision = tp + fp ? tp / (tp + fp) : 0
  const recall = tp + fn ? tp / (tp + fn) : 0
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  return { tp, fp, fn, precision, recall, f1, weakHit, weakMiss, expand, frames, dropHit, dropTotal, dropFalse, chains }
}

const pct = (x) => (100 * x).toFixed(0).padStart(3) + '%'

console.log('=== 1. tauSupport x tauFlow  (detection = hole ∨ hole-chain taint) ===')
console.log('    tauSup tauFlow |   P    R   F1 | TP FP FN | missed-but-SUSPECT | EXPAND')
for (const tauSupport of [0.15, 0.25, 0.35, 0.4]) {
  for (const tauFlow of [0.25, 0.35, 0.45, 0.55]) {
    const s = score({ tauSupport, tauFlow })
    console.log(
      `    ${tauSupport.toFixed(2)}   ${tauFlow.toFixed(2)}   | ${pct(s.precision)} ${pct(s.recall)} ${s.f1.toFixed(2)} |  ${s.tp} ${s.fp} ${s.fn} |      ${s.weakHit}/${s.weakHit + s.weakMiss}          |  ${s.expand}/${s.frames}`
    )
  }
}

console.log('')
console.log('=== 2. holeMax at tauSupport=0.25 tauFlow=0.35 (cost vs escalation) ===')
console.log('    holeMax | frames forced to EXPAND | hole ratio observed')
for (const holeMax of [0.15, 0.2, 0.34, 0.5, 0.75, 1.0]) {
  const s = score({ tauSupport: 0.25, tauFlow: 0.35, holeMax })
  console.log(`    ${holeMax.toFixed(2)}    |  ${String(s.expand).padStart(2)} / ${s.frames} frames          | P=${pct(s.precision)} R=${pct(s.recall)}`)
}

console.log('')
console.log('=== 3. redundancy gate (tauRedundant / redundantMax) ===')
console.log('    tauRed  redMax | restatement caught | false drops')
for (const [tauRedundant, redundantMax] of [
  [0.8, 0.5],
  [0.8, 0.9],
  [0.7, 0.5],
  [0.9, 0.5],
  [0.6, 0.3],
]) {
  const s = score({ tauSupport: 0.25, tauFlow: 0.35, tauRedundant, redundantMax })
  console.log(`    ${tauRedundant.toFixed(2)}    ${redundantMax.toFixed(2)}   |      ${s.dropHit}/${s.dropTotal}           |     ${s.dropFalse}`)
}

console.log('')
console.log('=== 4. recommended preset vs strict mode ===')
const BEST = { tauSupport: 0.25, tauFlow: 0.45, tauRoundTrip: 0.35, beta: 6, holeMax: 0.25, tauRedundant: 0.8, redundantMax: 0.5, maxRefDepth: 3, evidenceGate: 'off' }
for (const [name, p] of [
  ['preset', BEST],
  ['preset+strict', { ...BEST, weakAsHole: true }],
]) {
  const s = score(p)
  console.log(
    `    ${name.padEnd(14)} P=${pct(s.precision)} R=${pct(s.recall)} F1=${s.f1.toFixed(2)}  TP=${s.tp} FP=${s.fp} FN=${s.fn}  EXPAND=${s.expand}/${s.frames}`
  )
}

console.log('')
console.log('=== 5. per-chain detail at the preset ===')
for (const chain of CHAINS) {
  const r = analyseChain({ anchors: chain.anchors, frames: chain.frames }, BEST)
  const cells = []
  for (const f of r.frames) {
    for (const u of f.units) {
      const label = chain.labels[u.key]
      if (!label) continue
      const ok = (label === 'fabricated') === (u.lambda === 1)
      cells.push(`${u.key}:${label === 'fabricated' ? 'F' : 'd'}${ok ? '' : '!'}`)
    }
  }
  const verdicts = r.frames.map((f) => `${f.id}=${f.verdict}`).join(' ')
  console.log(`    ${chain.id.padEnd(18)} ${cells.join(' ')}`)
  console.log(`    ${''.padEnd(18)} ${verdicts}  violations=${r.violations.length}`)
}

// ---------------------------------------------------------------------------
// 6. The evidence gate, measured from both sides.
//
//    Left column:  a model that labels nothing. Default-deny must make that
//                  expensive, otherwise silence is the cheap path.
//    Right column: a model that labels its units honestly. The gate must then
//                  cost nothing — it should only fire on the units it declares
//                  as assumptions.
// ---------------------------------------------------------------------------
console.log('')
console.log('=== 6. evidence gate ===')
console.log('    gate | unlabelled model: holes/frames | honest model: holes/frames')

const unlabelled = CHAINS.map((c) => ({ anchors: c.anchors, frames: c.frames }))
// An honest labeller tags every unit with what it actually checked. Under
// default-deny that must cost exactly nothing — the columns should match 'off'.
const honest = CHAINS.map((c) => ({
  anchors: c.anchors,
  frames: c.frames.map((f) => ({
    ...f,
    units: f.units.map((u) => ({ ...u, verified: 'binary' })),
  })),
}))

for (const gate of ['hole', 'warn', 'off']) {
  const tally = (chains) => {
    let holes = 0
    let frames = 0
    for (const c of chains) {
      const r = analyseChain(c, { evidenceGate: gate })
      if (!r.ok) continue
      holes += r.summary.holes
      frames += r.summary.frames
    }
    return `${holes}/${frames}`
  }
  console.log(`    ${gate.padEnd(4)} | ${tally(unlabelled).padEnd(24)} | ${tally(honest)}`)
}

