import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyseChain as analyseChainRaw,
  verifyExpansion,
  hashEmbed,
  cosine,
  unitize,
  renderFrameReport,
} from '../lib/engine.js'

// Geometry tests below predate the evidence gate and describe the warp/blend
// half only, so they run with the gate off. Gate behaviour has its own tests.
const analyseChain = (input, over) => analyseChainRaw(input, { evidenceGate: 'off', ...(over || {}) })

test('embeddings: identical text is 1, unrelated text is small', () => {
  const a = hashEmbed('the cache key collides under concurrent writes')
  const b = hashEmbed('the cache key collides under concurrent writes')
  const c = hashEmbed('banana smoothie recipes for summer')
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-9, 'identical must be 1')
  assert.ok(Math.abs(cosine(a, c)) < 0.25, 'unrelated must be near 0, got ' + cosine(a, c))
})

test('embeddings: paraphrase beats unrelated', () => {
  const a = hashEmbed('the connection pool is exhausted under load')
  const p = hashEmbed('under load the connection pool exhausts')
  const z = hashEmbed('the printer is out of cyan toner')
  assert.ok(cosine(a, p) > cosine(a, z), 'paraphrase should score higher than noise')
})

test('unitize splits CJK and latin without breaking decimals', () => {
  const u = unitize('服务端返回500。网关超时了；重试 2.5 秒后仍然失败\n最后放弃')
  assert.equal(u.length, 4)
  assert.ok(u[2].text.includes('2.5'), 'decimal must survive the split')
})

test('unitize passes through pre-split units and keeps refs', () => {
  const u = unitize([{ text: 'a', ref: 'F0.0' }, { text: 'b' }, { text: '   ' }])
  assert.equal(u.length, 2)
  assert.equal(u[0].ref, 'F0.0')
})

// A chain built to hit every branch:
//   F0 root anchors
//   F1 honest continuation (reuses F0)          -> covered by round trip
//   F2 borrowed conclusion, no support anywhere -> disoccluded hole
//   F3 restates F1                              -> zero information gain -> DROP
const chain = {
  anchors: [
    { text: 'the write path holds a row lock for the entire request' },
    { text: 'p99 latency rose from 40ms to 900ms at 14:02' },
  ],
  frames: [
    { id: 'F0', units: [{ text: 'the write path holds a row lock for the entire request' }, { text: 'p99 latency rose from 40ms to 900ms at 14:02' }] },
    { id: 'F1', units: [{ text: 'the row lock is held for the whole request so writers queue', ref: 'F0.0' }, { text: 'p99 latency rose sharply at 14:02', ref: 'F0.1' }] },
    { id: 'F2', units: [{ text: 'the queue depth alarm was silenced by the on-call engineer' }] },
    { id: 'F3', units: [{ text: 'writers queue because the row lock spans the request' }] },
  ],
}

test('analyseChain: an explicit ref is a trusted motion vector', () => {
  const r = analyseChain(chain)
  assert.equal(r.ok, true)
  const f1 = r.frames.find((f) => f.id === 'F1')
  assert.equal(f1.holes, 0, 'F1 declares its source, so it has no holes')
  // The engine-supplied MV is authoritative (as in frame generation); a link
  // whose surface barely resembles its source is flagged weak, not made a hole.
  assert.equal(f1.units[0].why, 'mv')
  assert.equal(f1.units[0].lambda, 0)
})

test('analyseChain: estimated flow is validated by round trip', () => {
  const r = analyseChain({
    frames: [
      { id: 'A', units: [{ text: 'the retry budget is three attempts' }] },
      { id: 'B', units: [{ text: 'the retry budget is three attempts' }] },
    ],
  })
  const b = r.frames.find((f) => f.id === 'B')
  assert.equal(b.units[0].flow, 'auto', 'no ref means estimated flow')
  assert.equal(b.units[0].lambda, 0)
  assert.equal(b.units[0].why, 'round-trip')
})

test('analyseChain: unsupported claim becomes a hole and forces EXPAND', () => {
  const r = analyseChain(chain)
  const f2 = r.frames.find((f) => f.id === 'F2')
  assert.equal(f2.holes, 1, 'F2 unit has no consistent source and no anchor')
  assert.equal(f2.units[0].lambda, 1)
  // Greedy matching always proposes a correspondence; the disocclusion test is
  // precisely "the forced correspondence is bad", so low-flow is the honest code.
  assert.ok(['no-flow', 'low-flow'].includes(f2.units[0].why), 'got ' + f2.units[0].why)
  assert.equal(f2.verdict, 'EXPAND')
  assert.ok(r.directives.some((d) => d.startsWith('EXPAND F2')))
})

test('analyseChain: a literal restatement is dropped as zero-gain', () => {
  const r = analyseChain({
    frames: [
      { id: 'F0', units: [{ text: 'the row lock is held for the whole request so writers queue' }] },
      { id: 'F1', units: [{ text: 'the row lock is held for the whole request so writers queue' }] },
    ],
  })
  const f1 = r.frames.find((f) => f.id === 'F1')
  assert.equal(f1.verdict, 'DROP', 'an exact restatement must not earn tokens')
  assert.equal(f1.redundant, 1)
  assert.ok(r.summary.estimated_tokens_saved > 0)
})

test('known limitation: a paraphrase is NOT dropped (lexical proxy)', () => {
  // Documents the stated limitation: without hidden states, "same claim, new
  // wording" is indistinguishable from "new claim". The hidden-state version
  // would catch this; the toy embedding does not.
  const r = analyseChain({
    frames: [
      { id: 'F0', units: [{ text: 'the row lock is held for the whole request so writers queue' }] },
      { id: 'F1', units: [{ text: 'writers queue because the row lock spans the request' }] },
    ],
  })
  const f1 = r.frames.find((f) => f.id === 'F1')
  assert.equal(f1.verdict, 'KEEP')
  assert.ok(f1.redundant < 0.5)
})

test('analyseChain: strict mode promotes a suspect ref to a hole', () => {
  const fake = {
    anchors: [{ text: 'the lock is held per transaction' }],
    frames: [
      { id: 'F0', units: [{ text: 'the lock is held per transaction' }] },
      { id: 'F1', units: [{ text: 'writers queue behind the lock', ref: 'F0.0' }] },
      { id: 'F2', units: [{ text: 'the deadlock detector was disabled in 2023', ref: 'F1.0' }] },
    ],
  }
  const lax = analyseChain(fake)
  const laxUnit = lax.frames[2].units[0]
  assert.equal(laxUnit.lambda, 0, 'lax mode trusts the ref')
  assert.equal(laxUnit.weak, true, 'but still flags it as suspect')

  const strict = analyseChain(fake, { weakAsHole: true })
  const strictUnit = strict.frames[2].units[0]
  assert.equal(strictUnit.lambda, 1, 'strict mode refuses a link that does not hold up')
  assert.equal(strictUnit.why, 'weak-mv')
  assert.equal(strict.frames[2].verdict, 'EXPAND')
})

test('analyseChain: a hole promoted to a premise is a violation', () => {
  const r = analyseChain({
    anchors: [{ text: 'the deploy finished at 14:00' }],
    frames: [
      { id: 'A', units: [{ text: 'the deploy finished at 14:00' }] },
      { id: 'B', units: [{ text: 'an unrelated migration rewrote the shard map' }] },
      { id: 'C', units: [{ text: 'the shard map rewrite moved the hot tenant' }] },
    ],
  })
  const codes = r.violations.map((v) => v.code)
  assert.ok(codes.includes('HOLE_CHAIN'), 'expected HOLE_CHAIN, got ' + JSON.stringify(codes))
})

test('analyseChain: forward refs are rejected (extrapolation only)', () => {
  const r = analyseChain({
    frames: [
      { id: 'A', units: [{ text: 'first' }] },
      { id: 'B', units: [{ text: 'second', ref: 'C.0' }] },
      { id: 'C', units: [{ text: 'third' }] },
    ],
  })
  assert.ok(r.violations.some((v) => v.code === 'FORWARD_REF'))
})

test('analyseChain: blend weights favour the nearer reference', () => {
  const r = analyseChain({
    frames: [
      { id: 'A', units: [{ text: 'the retry budget is three attempts' }] },
      { id: 'B', units: [{ text: 'the retry budget is three attempts' }] },
      { id: 'C', units: [{ text: 'the retry budget stays at three attempts' }] },
    ],
  })
  const c = r.frames.find((f) => f.id === 'C').units[0]
  assert.ok(c.blend > 0.4, 'blend should be high for a near-duplicate, got ' + c.blend)
})

test('analyseChain tolerates empty input without throwing', () => {
  const r = analyseChain({ frames: [] })
  assert.equal(r.ok, false)
  assert.match(renderFrameReport(r), /no frames/)
})

test('verifyExpansion: faithful elaboration passes the round trip', () => {
  const r = verifyExpansion({
    summary: 'the connection pool is exhausted because sockets are never released on error',
    expansion: 'the connection pool is exhausted. sockets are never released when a request errors out. every failing request therefore leaks one connection.',
  })
  assert.equal(r.ok, true)
  assert.equal(r.verdict, 'FAITHFUL', JSON.stringify(r.units))
  assert.ok(r.fidelity > 0.45)
})

test('verifyExpansion: invented precision is OVERDETAIL', () => {
  const r = verifyExpansion({
    summary: 'the connection pool is exhausted',
    expansion: 'the connection pool is exhausted. thirty-one connections leaked per minute starting at 09:47. the fix landed in commit 4a91c2.',
  })
  assert.equal(r.verdict, 'OVERDETAIL', JSON.stringify(r.units))
  assert.ok(r.unsupported >= 1)
})

test('verifyExpansion: caller-supplied degradation is used verbatim', () => {
  const r = verifyExpansion({
    summary: 'locking spans the request',
    expansion: 'locking spans the whole request',
    degraded: 'locking spans the request',
  })
  assert.equal(r.degraded, 'locking spans the request')
  assert.ok(r.fidelity > 0.9)
})

test('verifyExpansion: the support bar is monotonic and load-bearing', () => {
  // Pins the coupling that tuning must not break: the same tauSupport means
  // different things on the two halves, and only the verify half has teeth.
  const args = {
    summary: 'the connection pool is exhausted',
    expansion: 'the connection pool is exhausted. thirty-one connections leaked per minute starting at 09:47.',
  }
  const strict = verifyExpansion(args, { tauSupport: 0.4 })
  const loose = verifyExpansion(args, { tauSupport: 0.05 })
  assert.equal(strict.verdict, 'OVERDETAIL')
  assert.ok(strict.unsupported >= 1, 'invented detail must be caught at the default bar')
  assert.ok(loose.unsupported <= strict.unsupported, 'a lower bar can never flag more')
  assert.notEqual(loose.verdict, 'OVERDETAIL', 'with no support requirement nothing is unsupported')
})

// ---------------------------------------------------------------------------
// Evidence gate (default-deny). The whole point: saying nothing must cost the
// same as admitting you assumed it, so silence cannot be the cheap path.
// ---------------------------------------------------------------------------
const grounded = {
  anchors: [{ text: 'the binary is not PIE' }],
  frames: [
    { id: 'F0', units: [{ text: 'the binary is not PIE', verified: 'binary' }] },
    {
      id: 'F1',
      units: [
        { text: 'addresses in main are fixed at link time', ref: 'F0.0', verified: 'binary' },
        { text: 'the win function sits at 0x4019c5', ref: 'F0.0', verified: 'assumed' },
        { text: 'the stack buffer is 64 bytes', ref: 'F0.0' },
      ],
    },
  ],
}

test('evidence gate: an unlabelled unit is a hole by default', () => {
  const r = analyseChainRaw(grounded) // gate defaults to 'hole'
  const f1 = r.frames.find((f) => f.id === 'F1')
  const byKey = Object.fromEntries(f1.units.map((u) => [u.key, u]))

  assert.equal(byKey['F1.0'].evidence, 'binary')
  assert.equal(byKey['F1.0'].lambda, 0, 'a labelled unit is judged geometrically')

  assert.equal(byKey['F1.1'].evidence, 'assumed')
  assert.equal(byKey['F1.1'].lambda, 1, 'an admitted assumption is a hole even with a ref')
  assert.equal(byKey['F1.1'].why, 'unverified')

  assert.equal(byKey['F1.2'].evidence, 'assumed', 'missing field == assumed')
  assert.equal(byKey['F1.2'].lambda, 1, 'silence is not free')

  assert.equal(r.summary.assumed, 2)
  assert.ok(r.directives.some((d) => d.startsWith('GROUND F1.1')), JSON.stringify(r.directives))
})

test('evidence gate: strictness is host config, not model choice', () => {
  const warn = analyseChainRaw(grounded, { evidenceGate: 'warn' })
  const soft = analyseChainRaw(grounded, { evidenceGate: 'off' })

  const holed = (r) => r.frames.find((f) => f.id === 'F1').units.filter((u) => u.lambda === 1).length
  assert.equal(holed(warn), 0, 'warn reports without escalating')
  assert.equal(warn.summary.assumed, 2, 'but still counts the assumptions')
  assert.ok(warn.directives.some((d) => d.startsWith('GROUND')))
  assert.equal(holed(soft), 0, 'off restores pre-evidence behaviour')
  assert.ok(!soft.directives.some((d) => d.startsWith('GROUND')))
})

test('evidence gate: an anchor quote is grounded without a label', () => {
  // A unit that literally restates an anchor has evidence by definition, so the
  // gate must not force the model to label it.
  const r = analyseChainRaw({
    anchors: [{ text: 'the deploy finished at 14:00' }],
    frames: [
      { id: 'A', units: [{ text: 'something else entirely' }] },
      { id: 'B', units: [{ text: 'the deploy finished at 14:00' }] },
    ],
  })
  const b = r.frames.find((f) => f.id === 'B').units[0]
  assert.equal(b.why, 'anchor')
  assert.equal(b.lambda, 0)
})

test('evidence gate: unknown label values fall back to assumed', () => {
  const r = analyseChainRaw({
    frames: [
      { id: 'A', units: [{ text: 'base claim', verified: 'binary' }] },
      { id: 'B', units: [{ text: 'derived claim', ref: 'A.0', verified: 'probably-fine' }] },
    ],
  })
  const b = r.frames.find((f) => f.id === 'B').units[0]
  assert.equal(b.evidence, 'assumed')
  assert.equal(b.lambda, 1)
})

test('engine is deterministic', () => {
  const a = JSON.stringify(analyseChainRaw(chain))
  const b = JSON.stringify(analyseChainRaw(chain))
  assert.equal(a, b)
})
