# XeFG Thinking

Frame-generation math, transplanted into LLM reasoning — and an attempt to measure
whether it helps.

The premise is that video frame generation and chain-of-thought are the same
operation in two coordinate systems: **synthesise the missing intermediate
structure under a learned prior, constrained by the anchors you were given.**
If that is true, the machinery built for pixels should port — and so should the
lessons the graphics field paid for (occlusion masks, one-to-many ambiguity, and
the metric mismatch between "looks right" and "is right").

This repo is that port, plus four rounds of controlled experiments on a pwn range.
It ships a **DSH plugin**, a **purpose-built multi-stage target**, and the raw
numbers.

Headline: the math ports cleanly and the mechanism works, **but only when the
work is forced to be externalised.** Left alone, nobody calls it. That finding is
the most useful thing here, and it is a negative result.

---

## What it does

Reasoning is rendered as a sequence of *frames*; a frame is 1–5 *units* (claims).
The graphics pipeline maps onto it one-to-one:

| XeSS-FG / ExtraSS | Here |
|---|---|
| frame `I_t` | one reasoning step |
| pixel | one unit (a claim) |
| motion vectors from the engine | the provenance `ref` the reasoner declares |
| estimated flow (no MV available) | hashed n-gram embedding + greedy cosine matching |
| warp `I_{t-1}` by `F_t` | predict frame `t` from `t-1` |
| occlusion / disocclusion mask `λ` | units with no forward-backward-consistent source |
| softmax blend of warped references | weighted average over the last N frames |
| temporal stability | *hole chaining*: a hole reused as a premise |
| frame dropping | redundancy gate |
| joint spatial super-sampling | elaboration whose degradation must reproduce the claim |

Two decisions matter more than the rest:

**Extrapolation, not interpolation.** ExtraSS generates `t+1` from frames `≤ t`
because interpolation needs the future frame and that costs latency. A language
model is causally constrained the same way, so a unit may never `ref` a later
frame. Violations are reported as `FORWARD_REF`.

**The motion vector is engine-supplied.** In a game the renderer provides motion
vectors and depth; the frame-generation network only warps, blends and
hallucinates. Here the *reasoner* supplies `ref`, and the tool only warps, blends
and flags. Where `ref` is absent it falls back to a lexical flow estimate — a
deliberate downgrade, documented below.

## The evidence gate (the part that actually worked)

The geometric half can only judge *structure*: does this unit warp from a covered
source? It cannot tell whether the source was ever checked. That gap produced the
worst failure observed: an agent concluded `system("/bin/sh")` never yields a
shell in the container (false), built a fragile syscall-only ROP chain on top of
it, and the result worked **12 times out of 19**. Internally consistent the whole
way; standing on nothing.

So every unit carries `verified: binary | service | assumed`, and
**missing, unknown, or `assumed` all resolve to `assumed` → hole** (unless it
literally restates an anchor). Silence costs exactly what admission costs:

```
[F1] EXPAND  holes 1/2  assumed 1
  - F1.1 [A] HOLE(unverified) cos=0.097 rt=0 anchor=0.245
  * GROUND F1.1: marked as an assumption (or left unlabelled) — verify it
    against the binary, the service, or a document before anything is built on it.
  * EXPAND F2, violations=1        <- the taint propagated downstream
```

## Results

Four rounds, all on the same pwn range (`chain` + eight CTF binaries). Every
reported flag was re-verified against a local ledger; every submitted exploit was
re-run to measure reproducibility.

| round | question | result |
|---|---|---|
| 1 | does it help on ordinary tasks? | **no.** 12 solves, 0 tool calls, `a1`/`b2` went 18s → 40s. Pure prompt overhead. |
| 2 | long reasoning chain? | attempts 1.67 vs 2.33, but wall clock *worse* (171s vs 81s) and one solution was only **63% reproducible**. |
| 3 | add default-deny + force the call | attempts **2.33 → 1.33**, wall clock **233s → 75s** (non-overlapping ranges, permutation p=0.05), all six solutions 100% reproducible. |
| 4 | can wording alone drive adoption? | **no.** Old vs hardened protocol, unforced: **0 calls in both**, 1.67 vs 2.0 attempts (noise). |

Tuning sweep (16-point grid over the thresholds): precision stayed at 100% and
recall at 90% at *every* setting — the decision that matters is whether a unit
declares a source at all, not how similar the source is. So the sliders are
nearly inert and the defaults are set for cheapness.

Strict mode (`weakAsHole`) measured as a bad trade: precision 100% → **59%**,
F1 0.95 → 0.74, escalations 7/24 → 13/24. Don't use it for agent work.

## The conclusion

**Its value is forcing externalisation, not automatic self-checking.**

- It cannot self-trigger. Unforced, it is called zero times; rewriting the
  protocol into imperative "this is a precondition, an un-called chain is
  unfinished work" changed nothing (round 4). Reading the agents' own notes
  explains why: they grounded every constant from disassembly *before* writing
  the payload, so they had no ungrounded claim to submit. The rule was never
  violated — it was never *reached*.
- It cannot self-verify. A model that writes `verified: "binary"` about
  something it never checked defeats it completely. Catching that needs sampled
  auditing, which is the evaluator's job, not a prompt's.
- What it *can* do: once a model is made to write the chain down with evidence
  labels, the tool names the empty link precisely. That is round 3's −68%.

So: use it as a **checkpoint the orchestrator imposes**, not as default
equipment. Enabling it without also asking for the call buys nothing and costs
~360 tokens per request.

## Layout

```
plugin/          the DSH plugin (host half, browser half, engine, tests)
range/           a purpose-built 4-stage pwn target + the socat/docker harness
tools/           SSH driver, gear/toggle helpers, protocol hot-swap, staging
experiment/      REPORT.md (all four rounds in detail), protocol variants,
                 and every submitted exploit as reproducibility evidence
```

## Install

Requirements: **DSH Desktop** (the harness this plugin plugs into) on Windows, and
PowerShell. No npm registry entry — it is hand-installed by a script.

```powershell
git clone https://github.com/jiushill/xefg-thinking.git
cd xefg-thinking\plugin

# copy the package into the live DSH web profile, register it as a bundle,
# and remove any stale patch insert (the two mechanisms would collide)
.\install.ps1

# restart DSH Desktop once, then check the host half is live:
Show-Xefg     # this helper lives in ..\tools\toggle.ps1, dot-source it first
```

`install.ps1` auto-detects the profile at `%APPDATA%\DSH Desktop\profiles\web`
(falling back to `~\.dsh\profiles\web`), or takes an explicit `-ProfileDir`.
It is idempotent, and `-Uninstall` removes every hook.

Verify after restart — the local route should answer and report the build:

```powershell
Invoke-RestMethod http://127.0.0.1:3080/xefg-think/state |
  Format-List enabled, version, engine, protocolChars
# enabled: False   version: 0.1.5   engine: 0.1.3   protocolChars: 2596
```

Drive it with the helpers in `tools/`:

```powershell
. .\tools\toggle.ps1
Show-Xefg                                        # state + counters
Set-Xefg -Enabled $true  -Gear default           # turn on (evidence gate: default-deny)
Set-Xefg -Enabled $true  -Gear gateoff           # ablation: geometry only
Set-Xefg -Enabled $false
Set-XefgProtocol -Path .\experiment\protocol-v1.txt   # hot-swap text, no restart
Clear-XefgProtocol
```

## Troubleshooting

| symptom | cause / fix |
|---|---|
| `GET /xefg-think/state` returns 404 | the profile has not been composed yet — restart DSH Desktop |
| pill missing | it lives in the **composer row** (it shows on the landing page too), not the session header |
| pill present but the panel is see-through | pre-0.1.5 CSS used a theme token that is not defined at that DOM position; 0.1.5 paints an opaque base |
| plugin listed with a bad badge under *Settings → Plugins* | bundle composition failed; fall back with `.\install.ps1 -LegacyInsert` |
| the model never calls the tools | expected — see the conclusion above; you have to ask for it |

## Using the plugin

It installs into a DSH web profile as a bundle and shows up under
*Settings → Plugins*, with a toggle pill in the composer row. Off by default, and
**activation never survives a restart** — `enabled` is written to disk for the UI
to remember, but it is not restored.

Recommended settings when you do turn it on:

| control | value |
|---|---|
| evidence gate | **unlabelled = hole (default-deny)** — the only knob that matters |
| hole threshold | 0.25 |
| flow match | 0.45 |
| blend sharpness β | 6 |
| strict mode | **off** |

And then actually ask for it: *"before writing anything that depends on a value
you have not observed, run the chain through `xefg_frame` and label each unit."*

The protocol text is hot-swappable over the local state route, so wording
experiments cost a POST instead of a restart:

```
POST /xefg-think/state  {"protocol": "<text>"}   # live on the next model request
POST /xefg-think/state  {"protocol": ""}         # back to the built-in text
```

## Honest limitations

- **The flow estimate is lexical.** Character-trigram hashing, not hidden states.
  Consequence, pinned by a test: a paraphrase is not recognised as redundant,
  only a literal restatement. Swapping in hidden states is the single
  highest-value change and the architecture already allows it.
- **No ground truth for intermediate frames.** Frame generation trains on real
  high-frame-rate video; reasoning has none. The criteria are reference-free
  (round-trip consistency plus anchor support), which can be satisfied by a
  coherent chain built from wrong anchors.
- **n=3 per cell.** Round 3's separation is clean but the permutation test only
  just clears p=0.05. Round 1's and 4's nulls are more robust than that.
- **The degradation operator `D` is a proxy** (centrality summariser) unless the
  caller passes its own compression.

## License

MIT.
