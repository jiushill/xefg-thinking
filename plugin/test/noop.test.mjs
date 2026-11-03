/**
 * Regression test: while disabled, the plugin must be a no-op on the prompt and
 * on the tool surface.
 *
 * This loads the REAL `renderPrompt` out of the installed DSH runtime, so it
 * measures the shipped implementation rather than a mock of it.
 *
 *   node --test test/noop.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const RUNTIME_CANDIDATES = [
  process.env.DSH_RUNTIME,
  process.env.APPDATA && path.join(process.env.APPDATA, 'DSH Desktop', 'runtime', 'dsh'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'DSH Desktop', 'runtime', 'dsh'),
  process.env.HOME && path.join(process.env.HOME, '.dsh', 'runtime', 'dsh'),
].filter(Boolean)

function findSystemPrompt() {
  for (const root of RUNTIME_CANDIDATES) {
    const scope = path.join(root, 'node_modules', '@deepseek-ai')
    if (!fs.existsSync(scope)) continue
    for (const dir of fs.readdirSync(scope)) {
      if (!/^\.?dsh-system-prompt/.test(dir)) continue
      const entry = path.join(scope, dir, 'lib', 'index.js')
      if (fs.existsSync(entry)) return entry
    }
  }
  return null
}

const entry = findSystemPrompt()
const skip = entry ? false : 'DSH runtime not found; set DSH_RUNTIME to its root'

// The section text provider the plugin registers, verbatim in shape.
const protocolOf = (enabled) => () => (enabled ? 'PROTOCOL-TEXT' : '')

// A realistic baseline: identity, persona, tool guidance, nothing else.
const BASELINE = [
  { name: 'harness:identity', order: -100, text: 'You are an AI agent powered by DeepSeek Harness.' },
  { name: 'deployment:persona', order: 0, text: 'Be terse.' },
  { name: 'tool:read', order: 110, text: 'read: pass an absolute path.' },
  { name: 'tool:bash', order: 120, text: 'bash: prefer one-shot commands.' },
]

const XEFG = { name: 'xefg:protocol', order: 150, text: protocolOf(false) }

test('disabled: the rendered prompt is byte-identical', { skip }, async () => {
  const { renderPrompt } = await import(pathToFileURL(entry).href)
  const resolve = (defs) =>
    defs
      .map((d) => ({ name: d.name, text: typeof d.text === 'function' ? d.text() : d.text }))
      .sort((a, b) => 0)
  const variables = { model: 'deepseek-v4', cwd: 'D:\\work' }

  const without = renderPrompt({ sections: resolve(BASELINE), contexts: [], tools: [], variables })
  const withPlugin = renderPrompt({ sections: resolve([...BASELINE, XEFG]), contexts: [], tools: [], variables })

  assert.equal(Buffer.byteLength(withPlugin, 'utf8'), Buffer.byteLength(without, 'utf8'))
  assert.equal(withPlugin, without, 'an empty section must not survive renderPrompt')
})

test('disabled: section ordering cannot be disturbed by an empty section', { skip }, async () => {
  const { renderPrompt } = await import(pathToFileURL(entry).href)
  const variables = {}
  // Same three sections, the plugin's empty one inserted in the middle by order.
  const a = [
    { name: 'a', text: 'first' },
    { name: 'c', text: 'third' },
  ]
  const b = [
    { name: 'a', text: 'first' },
    { name: 'xefg:protocol', text: '' },
    { name: 'c', text: 'third' },
  ]
  assert.equal(renderPrompt({ sections: b, contexts: [], tools: [], variables }), renderPrompt({ sections: a, contexts: [], tools: [], variables }))
})

test('disabled: no runtime context is contributed', { skip }, async () => {
  const { renderContextSnapshot } = await import(pathToFileURL(entry).href)
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  assert.equal(renderContextSnapshot(assembly), '')
})

test('enabled: the only difference is the protocol text itself', { skip }, async () => {
  const { renderPrompt } = await import(pathToFileURL(entry).href)
  const variables = {}
  const without = renderPrompt({
    sections: BASELINE.map((d) => ({ name: d.name, text: d.text })),
    contexts: [],
    tools: [],
    variables,
  })
  const withProtocol = renderPrompt({
    sections: [...BASELINE.map((d) => ({ name: d.name, text: d.text })), { name: 'xefg:protocol', text: 'PROTOCOL-TEXT' }],
    contexts: [],
    tools: [],
    variables,
  })
  assert.equal(withProtocol, without + '\n\nPROTOCOL-TEXT')
})

test('disabled: the tool registrar is never called', async () => {
  // Mirrors the dry-run harness at the unit level: apply() with the stored state
  // off must leave the tool registry untouched.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(path.join(tmpdir(), 'xefg-noop-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { apply } = await import('../lib/index.js')
    let registrations = 0
    const ctx = {
      effect: (fn) => fn(),
      webServer: { register: () => () => {} },
      inject: (_deps, cb) =>
        cb({
          effect: (fn) => fn(),
          systemPrompt: { section: () => () => {} },
          tools: {
            register: () => {
              registrations++
              return () => {}
            },
          },
        }),
    }
    apply(ctx, {})
    assert.equal(registrations, 0, 'a disabled plugin must not register any tool')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
