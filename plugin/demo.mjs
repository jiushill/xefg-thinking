/**
 * Demo: run the engine over a realistic chain and print what the model would see.
 *
 *   node demo.mjs
 */
import { analyseChain, verifyExpansion, renderFrameReport, renderVerifyReport } from './lib/engine.js'

const chain = {
  anchors: [
    { text: 'p99 latency rose from 40ms to 900ms starting at 14:02', source: 'grafana' },
    { text: 'the deploy at 14:00 flipped the write path to SERIALIZABLE', source: 'git log' },
  ],
  frames: [
    {
      id: 'F0',
      units: [
        { text: 'p99 latency rose from 40ms to 900ms starting at 14:02' },
        { text: 'the deploy at 14:00 flipped the write path to SERIALIZABLE' },
      ],
    },
    {
      id: 'F1',
      units: [
        { text: 'SERIALIZABLE holds a row lock until the transaction commits', ref: 'F0.1' },
        { text: 'the latency spike starts two minutes after the deploy', ref: 'F0.0' },
      ],
    },
    {
      id: 'F2',
      units: [
        { text: 'writers on the hot tenant serialise behind a single row lock', ref: 'F1.0' },
        { text: 'the queue depth alarm was silenced by the on-call engineer' },
        { text: 'the pooler was reconfigured to 20 connections at 14:01' },
      ],
    },
    {
      id: 'F3',
      units: [{ text: 'SERIALIZABLE holds a row lock until the transaction commits', ref: 'F1.0' }],
    },
  ],
}

const r = analyseChain(chain, { evidenceGate: 'off' })
console.log('='.repeat(78))
console.log('xefg_frame  (geometry half: evidence gate off, units unlabelled)')
console.log('='.repeat(78))
console.log(renderFrameReport(r))
console.log('')
console.log('summary:', JSON.stringify(r.summary))

// The evidence gate, same chain. One unit is honestly marked as an assumption;
// the rest claim to be grounded in the binary. Default-deny turns only the
// assumption into a hole — and says so instead of letting it slide.
const labelled = {
  ...chain,
  frames: chain.frames.map((f, fi) => ({
    ...f,
    units: f.units.map((u, ui) => ({
      ...u,
      verified: fi === 1 && ui === 0 ? 'assumed' : 'binary',
    })),
  })),
}
const g = analyseChain(labelled)
console.log('')
console.log('='.repeat(78))
console.log('xefg_frame  (evidence gate on, one unit declared assumed)')
console.log('='.repeat(78))
console.log(renderFrameReport(g))
console.log('')
console.log('summary:', JSON.stringify(g.summary))

const v = verifyExpansion({
  summary: 'SERIALIZABLE on the write path serialises writers behind one row lock',
  expansion:
    'SERIALIZABLE on the write path serialises writers behind one row lock. At 14:02 the p99 went to 900ms. Rolling back to READ COMMITTED at 14:31 dropped p99 to 41ms.',
  anchors: [{ text: 'the deploy at 14:00 flipped the write path to SERIALIZABLE' }],
})

console.log('')
console.log('='.repeat(78))
console.log('xefg_verify')
console.log('='.repeat(78))
console.log(renderVerifyReport(v))
