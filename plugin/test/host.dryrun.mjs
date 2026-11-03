/**
 * Dry-run harness: exercises the host half against a mock Cordis context, with
 * no DSH process involved. Proves the three things that can silently break a
 * hand-installed plugin — section gating, tool lifecycle, and route plumbing.
 *
 *   node --test test/host.dryrun.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate the state file so the test never touches the real one.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'xefg-dry-'))

const { apply } = await import('../lib/index.js')

function mockCtx() {
  const routes = new Map()
  const sections = []
  const tools = new Map()
  const effects = []
  const ctx = {
    effect(fn, label) {
      const d = fn()
      effects.push({ label, d })
      return d
    },
    webServer: {
      register(spec) {
        routes.set(spec.path, spec)
        return () => routes.delete(spec.path)
      },
    },
    inject(_deps, cb) {
      cb({
        effect: ctx.effect,
        systemPrompt: {
          section(s) {
            sections.push(s)
            return () => {}
          },
        },
        tools: {
          register(def) {
            if (tools.has(def.name)) throw new Error('duplicate tool ' + def.name)
            tools.set(def.name, def)
            return () => tools.delete(def.name)
          },
        },
      })
    },
  }
  return { ctx, routes, sections, tools, effects }
}

function fakeReqRes(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    headers: { origin: 'http://127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
  const res = {
    status: 0,
    payload: null,
    writeHead(status) {
      this.status = status
    },
    end(data) {
      this.payload = JSON.parse(data)
    },
  }
  return { req, res }
}

test('disabled plugin contributes no prompt text and no tools', () => {
  const m = mockCtx()
  apply(m.ctx, {})
  assert.equal(m.tools.size, 0, 'nothing may be registered while disabled')
  assert.equal(m.sections.length, 1, 'the section is registered but renders empty')
  assert.equal(m.sections[0].text(), '')
  assert.equal(m.sections[0].order, 150)
  assert.ok(m.routes.has('/xefg-think/state'))
})

test('the state route enables the protocol and installs both tools', async () => {
  const m = mockCtx()
  apply(m.ctx, {})
  const handler = m.routes.get('/xefg-think/state').handler

  let { req, res } = fakeReqRes('POST', { enabled: true })
  await handler(req, res)
  assert.equal(res.status, 200)
  assert.equal(res.payload.enabled, true)

  assert.deepEqual([...m.tools.keys()].sort(), ['xefg_frame', 'xefg_verify'])
  assert.ok(m.sections[0].text().includes('XeFG Thinking'), 'protocol must render when enabled')

  // idempotent: enabling again must not double-register
  ;({ req, res } = fakeReqRes('POST', { enabled: true }))
  await handler(req, res)
  assert.equal(res.status, 200)
  assert.equal(m.tools.size, 2)

  ;({ req, res } = fakeReqRes('POST', { enabled: false }))
  await handler(req, res)
  assert.equal(m.tools.size, 0, 'disabling must remove the tools again')
  assert.equal(m.sections[0].text(), '')
})

test('xefg_frame executes and returns a lossless-JSON report', async () => {
  const m = mockCtx()
  apply(m.ctx, {})
  const handler = m.routes.get('/xefg-think/state').handler
  const { req, res } = fakeReqRes('POST', { enabled: true })
  await handler(req, res)

  const tool = m.tools.get('xefg_frame')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['frames'])
  assert.equal(tool.output.schema.type, 'object')

  const value = await tool.execute(
    {
      anchors: [{ text: 'the write path holds a row lock for the entire request' }],
      frames: [
        { id: 'F0', units: [{ text: 'the write path holds a row lock for the entire request' }] },
        { id: 'F1', units: [{ text: 'writers queue for the whole request', ref: 'F0.0' }] },
        { id: 'F2', units: [{ text: 'the on-call engineer silenced the queue alarm' }] },
      ],
    },
    { signal: new AbortController().signal }
  )

  assert.equal(value.ok, true)
  assert.equal(value.summary.frames, 3)
  assert.ok(value.frames.some((f) => f.verdict === 'EXPAND'), JSON.stringify(value.frames.map((f) => f.verdict)))

  // the canonical value must survive the JSON boundary the registry enforces
  const round = JSON.parse(JSON.stringify(value))
  assert.deepEqual(round.summary, value.summary)

  const blocks = tool.output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /EXPAND F2/)

  // the call is accounted for
  const s = m.routes.size // keep lint quiet
  const { req: r2, res: rs2 } = fakeReqRes('GET')
  await handler(r2, rs2)
  assert.equal(rs2.payload.stats.calls, 1)
  assert.ok(rs2.payload.stats.holes >= 1)
  assert.equal(s, 1)
})

test('xefg_verify executes and renders', async () => {
  const m = mockCtx()
  apply(m.ctx, {})
  const handler = m.routes.get('/xefg-think/state').handler
  const { req, res } = fakeReqRes('POST', { enabled: true })
  await handler(req, res)

  const tool = m.tools.get('xefg_verify')
  const value = await tool.execute(
    {
      summary: 'the connection pool is exhausted',
      expansion: 'the connection pool is exhausted. 31 connections leaked per minute starting at 09:47.',
    },
    { signal: new AbortController().signal }
  )
  assert.equal(value.ok, true)
  assert.equal(value.verdict, 'OVERDETAIL')
  assert.match(tool.output.render({}, value)[0].text, /OVERDETAIL/)
})

test('bad input is refused rather than thrown', async () => {
  const m = mockCtx()
  apply(m.ctx, {})
  const handler = m.routes.get('/xefg-think/state').handler
  const { req, res } = fakeReqRes('POST', { enabled: true })
  await handler(req, res)

  const r1 = await m.tools.get('xefg_frame').execute({ frames: [] }, { signal: new AbortController().signal })
  assert.equal(r1.ok, false)
  const r2 = await m.tools.get('xefg_verify').execute({ summary: '', expansion: '' }, { signal: new AbortController().signal })
  assert.equal(r2.ok, false)
})

test('origin check rejects a non-loopback caller', async () => {
  const m = mockCtx()
  apply(m.ctx, {})
  const handler = m.routes.get('/xefg-think/state').handler
  const before = m.tools.size // a prior test left the stored state enabled
  const { req, res } = fakeReqRes('POST', { enabled: true })
  req.headers.origin = 'https://evil.example'
  await handler(req, res)
  assert.equal(res.status, 403)
  assert.equal(m.tools.size, before, 'a rejected origin must not change state')
})

test('protocol override is hot-swappable and capped', async () => {
  const m = mockCtx()
  apply(m.ctx, {})
  const handler = m.routes.get('/xefg-think/state').handler

  let { req, res } = fakeReqRes('POST', { enabled: true })
  await handler(req, res)
  const builtin = m.sections[0].text()
  assert.ok(builtin.includes('XeFG'), 'built-in protocol renders when enabled')

  // The section provider is evaluated per assembly, so swapping the text must
  // take effect without re-registering anything: that is what makes a wording
  // experiment cost one POST instead of a restart.
  ;({ req, res } = fakeReqRes('POST', { protocol: '## CUSTOM PROTOCOL BODY' }))
  await handler(req, res)
  assert.equal(m.sections[0].text(), '## CUSTOM PROTOCOL BODY')

  ;({ req, res } = fakeReqRes('POST', { protocol: '' }))
  await handler(req, res)
  assert.equal(m.sections[0].text(), builtin, 'an empty override falls back to the built-in text')

  ;({ req, res } = fakeReqRes('POST', { protocol: 'x'.repeat(9000) }))
  await handler(req, res)
  assert.equal(m.sections[0].text().length, 8000, 'override is capped')

  ;({ req, res } = fakeReqRes('GET'))
  await handler(req, res)
  assert.equal(res.payload.protocolCustom, true)
  assert.equal(res.payload.protocolChars, 8000)
})

test('activation does not survive a restart', async () => {
  // A stored enabled:true must never come back on by itself: activation is
  // session-scoped, so a restart cannot silently resume spending tokens.
  const dir = join(process.env.DSH_HOME, 'xefg-think')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ enabled: true, params: {}, stats: {} }), 'utf8')

  const m = mockCtx()
  apply(m.ctx, {})
  const { req, res } = fakeReqRes('GET')
  await m.routes.get('/xefg-think/state').handler(req, res)
  assert.equal(res.payload.enabled, false, 'stored enabled:true must be ignored on load')
  assert.equal(m.tools.size, 0, 'and no tools may be installed')

  rmSync(dir, { recursive: true, force: true })
})

test('params are clamped and persisted across a reload', async () => {
  const m = mockCtx()
  apply(m.ctx, {})
  const handler = m.routes.get('/xefg-think/state').handler
  let { req, res } = fakeReqRes('POST', { enabled: true, params: { tauFlow: 99, beta: -5, maxRefDepth: 42, bogus: 1 } })
  await handler(req, res)
  assert.equal(res.payload.params.tauFlow, 0.99)
  assert.equal(res.payload.params.beta, 0.1)
  assert.equal(res.payload.params.maxRefDepth, 8)
  assert.equal(res.payload.params.bogus, undefined, 'unknown knobs are dropped')

  // a second process reading the same home sees the stored PARAMS, but never
  // the stored activation: config persists, switching on does not.
  const m2 = mockCtx()
  apply(m2.ctx, {})
  ;({ req, res } = fakeReqRes('GET'))
  await m2.routes.get('/xefg-think/state').handler(req, res)
  assert.equal(res.payload.enabled, false, 'activation is session-scoped')
  assert.equal(res.payload.params.tauFlow, 0.99, 'tuning persists')
  assert.equal(m2.tools.size, 0, 'no tools on a fresh context until it is switched on')
})
