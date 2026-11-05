/**
 * dsh-plugin-xefg-think — host half.
 *
 * Opt-in. While disabled this plugin contributes NO prompt text and NO tools,
 * so it costs exactly zero tokens; it only keeps two HTTP routes alive for the
 * toggle. Enabling it (from the chat header pill, or POST /xefg-think/state)
 * installs two tools and one system-prompt section, both derived from
 * extrapolation-based frame generation math (see lib/engine.js).
 *
 * Deliberately dependency-free: no schemastery, no cordis imports. Config is a
 * plain object validated here, because a hand-installed plugin should not be
 * able to break host boot over a missing import.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, ENGINE_VERSION, analyseChain, renderFrameReport, renderVerifyReport, verifyExpansion } from './engine.js'

export const name = 'xefg-think'
export const inject = ['webServer']

const VERSION = '0.1.6'
const NS = 'xefg-think'

const TUNABLE = ['tauFlow', 'tauRoundTrip', 'tauSupport', 'beta', 'holeMax', 'tauRedundant', 'redundantMax', 'maxRefDepth', 'sectionOrder']
const TUNABLE_INT = ['maxRefDepth', 'sectionOrder']
const TUNABLE_BOOL = ['weakAsHole']
const EVIDENCE_GATES = ['hole', 'warn', 'off']

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

function homeDir() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  return join(homedir(), '.dsh')
}

// ---------------------------------------------------------------------------
// State: one JSON file, atomic replace, best-effort (never fatal).
// ---------------------------------------------------------------------------
class StateStore {
  constructor() {
    this.dir = join(homeDir(), NS)
    this.file = join(this.dir, 'state.json')
    this.listeners = new Set()
    this.state = this.#load()
  }

  #defaults() {
    return {
      enabled: false,
      // Hot-swappable protocol text. The section provider is evaluated at every
      // prompt assembly, so replacing this rewrites behaviour on the next model
      // request with no reload — which is what makes wording experiments cheap.
      protocol: '',
      params: {
        tauFlow: DEFAULTS.tauFlow,
        tauRoundTrip: DEFAULTS.tauRoundTrip,
        tauSupport: DEFAULTS.tauSupport,
        beta: DEFAULTS.beta,
        holeMax: DEFAULTS.holeMax,
        tauRedundant: DEFAULTS.tauRedundant,
        redundantMax: DEFAULTS.redundantMax,
        weakAsHole: DEFAULTS.weakAsHole,
        evidenceGate: DEFAULTS.evidenceGate,
        maxRefDepth: DEFAULTS.maxRefDepth,
        sectionOrder: DEFAULTS.sectionOrder,
      },
      stats: {
        calls: 0,
        frames: 0,
        units: 0,
        holes: 0,
        dropped: 0,
        expand: 0,
        violations: 0,
        assumed: 0,
        tokensSaved: 0,
        lastAt: null,
      },
    }
  }

  #load() {
    const base = this.#defaults()
    try {
      if (!existsSync(this.file)) return base
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      return {
        // Activation is session-scoped on purpose: a plugin that silently comes
        // back on after a restart spends tokens the user never agreed to spend
        // this time. `enabled` is still written to disk, but it is never
        // *restored* — every launch starts off, and turning it on is one click.
        enabled: false,
        protocol: typeof raw.protocol === 'string' ? capProtocol(raw.protocol) : '',
        params: { ...base.params, ...sanitizeParams(raw.params) },
        stats: { ...base.stats, ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) },
      }
    } catch {
      return base
    }
  }

  #persist() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      /* a read-only home is not a reason to break the session */
    }
  }

  get() {
    return this.state
  }

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  update(patch = {}) {
    const prev = this.state
    const next = { ...this.state, params: { ...this.state.params }, stats: { ...this.state.stats } }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    // '' clears the override and falls back to the built-in protocol.
    if (typeof patch.protocol === 'string') next.protocol = capProtocol(patch.protocol)
    if (patch.params && typeof patch.params === 'object') Object.assign(next.params, sanitizeParams(patch.params))
    if (patch.resetStats === true) Object.assign(next.stats, this.#defaults().stats)
    this.state = next
    this.#persist()
    for (const fn of this.listeners) {
      try {
        fn(next, prev)
      } catch {
        /* listener isolation */
      }
    }
    return next
  }

  record(result) {
    const s = { ...this.state.stats }
    s.calls += 1
    s.lastAt = new Date().toISOString()
    if (result && result.summary) {
      const m = result.summary
      s.frames += m.frames || 0
      s.units += m.units || 0
      s.holes += m.holes || 0
      s.dropped += m.dropped || 0
      s.expand += m.expand || 0
      s.violations += m.violations || 0
      s.assumed += m.assumed || 0
      s.tokensSaved += m.estimated_tokens_saved || 0
    }
    this.state = { ...this.state, stats: s }
    this.#persist()
  }
}

/** Cap the hot-swappable protocol text: an override is config, not a payload. */
function capProtocol(text) {
  const t = String(text ?? '')
  if (!t.trim()) return ''
  return t.replace(/\r\n/g, '\n').slice(0, 8000)
}

function sanitizeParams(input) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  const bounds = {
    tauFlow: [0, 0.99],
    tauRoundTrip: [0, 0.99],
    tauSupport: [0, 0.99],
    beta: [0.1, 40],
    holeMax: [0.01, 1],
    tauRedundant: [0.3, 0.99],
    redundantMax: [0.01, 1],
    maxRefDepth: [1, 8],
    sectionOrder: [200, 20000],
  }
  for (const k of TUNABLE) {
    const v = input[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const [lo, hi] = bounds[k]
    out[k] = TUNABLE_INT.includes(k) ? Math.round(clamp(v, lo, hi)) : clamp(v, lo, hi)
  }
  for (const k of TUNABLE_BOOL) {
    if (typeof input[k] === 'boolean') out[k] = input[k]
  }
  // The evidence policy is host config, never model input: 'hole' is default-deny.
  if (EVIDENCE_GATES.includes(input.evidenceGate)) out.evidenceGate = input.evidenceGate
  return out
}

// ---------------------------------------------------------------------------
// The model-facing protocol. This is the entire behavioural change.
// ---------------------------------------------------------------------------
const PROTOCOL = `## XeFG Thinking (evidence-gated reasoning)

This section is a precondition, not advice.

Before you write any payload, exploit, script, patch, or file that depends on a
value, address, offset, or behaviour you have not personally observed, call
\`xefg_frame\`. Skipping it means you are asserting things you never checked, and
nothing downstream of you can tell. An un-called chain is unfinished work.

Reasoning is rendered as frames: a frame is 1-5 units, a unit is one claim or one
step, and a frame may depend only on frames before it. Extrapolation, never
interpolation: you cannot cite a step you have not taken.

  xefg_frame({
    anchors: [{text}],                                // what you verified
    frames: [{id, units: [{text, ref?, verified}]}]   // one frame per step
  })

Every unit MUST carry \`verified\`:
  binary  - read it out of the artifact: disassembly, symbols, section headers
  service - you saw it happen: a banner, a leak, a crash you caused, strace
  assumed - inference, memory, or "it usually works". Say it.

Assumed or unlabelled both score as HOLE. Silence and admission cost the same,
so there is never a reason to stay silent. A unit that literally restates an
anchor is grounded without a label.

Holes are disocclusions: content the previous frames cannot warp into. They are
the only place you are allowed to be wrong, so resolve them before building on
them - retrieve, run a tool, or say plainly that it is unverified.

Act only on what the verdict allows:
  - every GROUND line names a unit you have not verified. Go check it: read the
    bytes, run the thing, measure the offset. Then extend the chain.
  - EXPAND means that frame stands on holes. Do not write code past it.
  - DROP means it restates what is already established. Delete it - redundant
    frames cost tokens and buy nothing.

When a claim of yours expands into detail, call \`xefg_verify({summary,
expansion})\`. It runs the round-trip test: degrading the expansion must reproduce
the summary. \`OVERDETAIL\` means the expansion invented support the summary does
not carry - cut it back to what the anchor actually says.

Priority order:
1. Grounded beats fluent. A hole you admit costs one clause; a hole you paper
   over costs the whole chain.
2. Spend tokens on holes, not on units the frame generator already covered.
3. A unit that flips meaning between frames is flicker, not thinking. Fix it by
   anchoring, not by re-wording.

The expensive mistake is not "I do not know". It is "I am sure" - a premise you
never noticed assuming. Nothing downstream catches it, including you.`

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

function frameTool(store) {
  return {
    name: 'xefg_frame',
    description:
      'Score a reasoning chain with frame-generation math: estimate the flow between consecutive frames, warp, detect disocclusions (holes), blend references, and return KEEP/EXPAND/DROP per frame. Every unit carries a `verified` label (binary | service | assumed); an unlabelled or assumed unit is scored as a hole, so silence is not cheaper than admitting an assumption. Pass the chain as frames of units; pass grounded facts as anchors.',
    parameters: {
      type: 'object',
      properties: {
        anchors: {
          type: 'array',
          description: 'Grounded facts the chain may legally reuse (given data, file contents, tool output).',
          items: {
            type: 'object',
            properties: { text: { type: 'string' }, source: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
        frames: {
          type: 'array',
          description: 'Reasoning steps in order. Each frame is 1-5 units.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short id, e.g. F0. Defaults to the index.' },
              units: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                    ref: { type: 'string', description: 'Earlier unit this continues, as <frameId>.<index>.' },
                    verified: {
                      type: 'string',
                      enum: ['binary', 'service', 'assumed'],
                      description:
                        'How you know this. Omitted or assumed counts as ungrounded and is scored as a hole.',
                    },
                  },
                  required: ['text'],
                  additionalProperties: false,
                },
              },
            },
            required: ['units'],
            additionalProperties: false,
          },
        },
      },
      required: ['frames'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderFrameReport(value) }],
    },
    async execute(args) {
      const result = analyseChain(args, store.get().params)
      if (result.ok) store.record(result)
      return result
    },
  }
}

function verifyTool(store) {
  return {
    name: 'xefg_verify',
    description:
      'Round-trip test for an elaboration (the super-resolution half): checks that degrading the expansion reproduces the original terse claim, and flags detail that outruns its support. Returns verdict FAITHFUL / OVERDETAIL / DRIFTED.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'The terse claim being expanded.' },
        expansion: { type: 'string', description: 'The elaborated version.' },
        degraded: { type: 'string', description: 'Optional: your own compression of the expansion. Overrides the built-in one.' },
        anchors: {
          type: 'array',
          items: {
            type: 'object',
            properties: { text: { type: 'string' }, source: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      },
      required: ['summary', 'expansion'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderVerifyReport(value) }],
    },
    async execute(args) {
      return verifyExpansion(args, store.get().params)
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP: JSON helpers, loopback only
// ---------------------------------------------------------------------------
function isLoopbackOrigin(origin) {
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

function send(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

async function readJson(req, limit = 64 * 1024) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > limit) return null
  }
  if (!body) return {}
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export function apply(ctx, config = {}) {
  const store = new StateStore()
  if (config && typeof config === 'object') {
    const seed = {}
    if (typeof config.enabled === 'boolean') seed.enabled = config.enabled
    if (config.params) seed.params = config.params
    if (Object.keys(seed).length) store.update(seed)
  }

  const runtime = { frame: null, verify: null, sync: null }

  // --- routes (always on; this is the only thing that exists while disabled)
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/xefg-think/state',
        handler: async (req, res) => {
          try {
            const origin = req.headers.origin
            if (typeof origin === 'string' && origin !== '' && !isLoopbackOrigin(origin)) {
              return send(res, 403, { ok: false, error: 'forbidden origin' })
            }
            if (req.method === 'GET' || req.method === 'HEAD') {
              const s = store.get()
              return send(res, 200, {
                ok: true,
                version: VERSION,
                engine: ENGINE_VERSION,
                enabled: s.enabled,
                params: s.params,
                stats: s.stats,
                // The protocol body itself is not shipped over the wire; just
                // enough to tell whether an override is live, and how big it is.
                protocolCustom: Boolean(s.protocol),
                protocolChars: (s.protocol || PROTOCOL).length,
                protocolBuiltinChars: PROTOCOL.length,
                tools: ['xefg_frame', 'xefg_verify'],
              })
            }
            if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
            const payload = await readJson(req)
            if (payload === null) return send(res, 400, { ok: false, error: 'invalid JSON body' })
            const next = store.update({
              enabled: typeof payload.enabled === 'boolean' ? payload.enabled : undefined,
              params: payload.params,
              protocol: typeof payload.protocol === 'string' ? payload.protocol : undefined,
              resetStats: payload.resetStats === true,
            })
            return send(res, 200, {
              ok: true,
              enabled: next.enabled,
              params: next.params,
              stats: next.stats,
              protocolCustom: Boolean(next.protocol),
              protocolChars: (next.protocol || PROTOCOL).length,
            })
          } catch (error) {
            return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'xefg-think: state route'
  )

  // --- prompt section: dynamic, empty unless enabled
  //
  // Order matters more than it looks. dsh-system-prompt sorts sections
  // ascending and its own bands end at DEPLOYMENT_PERSONA_SUFFIX = 10200, so
  // anything below that lands *inside* the prompt a preset authored and reads
  // as an amendment to its persona. Sitting above 10200 makes this block a
  // trailing appendix instead: the persona stays the identity, and this is a
  // methodology note after it. The order is state-tunable so placement can be
  // changed with a POST rather than a restart — a section's order is fixed at
  // registration, so moving it means dispose + re-register.
  ctx.inject(['systemPrompt'], (c) => {
    let dispose = null
    const register = () => {
      dispose = c.systemPrompt.section({
        name: 'xefg:protocol',
        order: store.get().params.sectionOrder,
        text: () => {
          const s = store.get()
          if (!s.enabled) return ''
          return s.protocol || PROTOCOL
        },
      })
    }
    register()
    c.effect(
      () =>
        store.onChange((next, prev) => {
          if (!prev || !next) return
          if (next.params.sectionOrder === prev.params.sectionOrder) return
          const old = dispose
          dispose = null
          if (typeof old === 'function') {
            try {
              old()
            } catch {
              /* already disposed by a reload */
            }
          }
          register()
        }),
      'xefg-think: protocol section order follows the setting'
    )
  })

  // --- tools: installed and removed with the toggle
  ctx.inject(['tools'], (c) => {
    const dispose = (d) => {
      if (typeof d !== 'function') return
      try {
        d()
      } catch {
        /* already gone */
      }
    }
    const sync = () => {
      try {
        const want = store.get().enabled
        if (want) {
          if (!runtime.frame) runtime.frame = c.tools.register(frameTool(store))
          if (!runtime.verify) runtime.verify = c.tools.register(verifyTool(store))
        } else {
          dispose(runtime.frame)
          dispose(runtime.verify)
          runtime.frame = null
          runtime.verify = null
        }
      } catch (error) {
        // A duplicate registration or a host that refuses the schema must never
        // take the session down; disable instead and remember why.
        dispose(runtime.frame)
        dispose(runtime.verify)
        runtime.frame = null
        runtime.verify = null
        runtime.lastError = error instanceof Error ? error.message : String(error)
      }
    }
    runtime.sync = sync
    sync()
    c.effect(() => store.onChange(sync), 'xefg-think: tool visibility follows the toggle')
  })

  return { store }
}

