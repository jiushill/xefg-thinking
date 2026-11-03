// POST the protocol body straight from Node, bypassing PowerShell's JSON
// serialiser (5.1 turns a long string into {value,Count} and the server
// rightly rejects it as an invalid body).
//
//   node setproto.mjs <file>     set an override from a text file
//   node setproto.mjs --clear    drop the override, back to the built-in text
//   node setproto.mjs --show     just report the current state
import fs from 'node:fs'

const URL = 'http://127.0.0.1:3080/xefg-think/state'
const arg = process.argv[2]

if (!arg) {
  console.error('usage: node setproto.mjs <file> | --clear | --show')
  process.exit(2)
}

if (arg === '--show') {
  const j = await (await fetch(URL)).json()
  console.log(JSON.stringify({ custom: j.protocolCustom, chars: j.protocolChars, builtin: j.protocolBuiltinChars }))
  process.exit(0)
}

const body = arg === '--clear' ? { protocol: '' } : { protocol: fs.readFileSync(arg, 'utf8') }

const res = await fetch(URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const j = await res.json().catch(() => null)
if (!res.ok || !j || j.ok !== true) {
  console.error('FAILED', res.status, JSON.stringify(j))
  process.exit(1)
}
console.log(
  JSON.stringify({
    ok: true,
    custom: j.protocolCustom,
    chars: j.protocolChars,
    source: arg === '--clear' ? '(built-in)' : arg,
  })
)
