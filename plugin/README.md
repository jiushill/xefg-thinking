# dsh-plugin-xefg-think

Frame-generation math transplanted into reasoning. Opt-in, zero cost while off.

The premise: video frame generation and chain-of-thought are the same operation
described in two coordinate systems — *synthesise the missing intermediate
structure under a learned prior, constrained by the anchors you were given*.
If that is true, the machinery built for pixels should port, and so should the
lessons the graphics field paid for in blood (occlusion masks, one-to-many
ambiguity, and the metric mismatch between "looks right" and "is right").

This plugin is the port. It is an experiment harness, not a magic trick.

---

## 1. Install

```powershell
& .\install.ps1                 # bundle mode (default): manageable from Settings > Plugins
& .\install.ps1 -LegacyInsert   # fallback: plain patch insert, still loads, not listed in Settings
& .\install.ps1 -Uninstall      # remove every hook; files stay on disk
```

It installs into `%APPDATA%\DSH Desktop\profiles\web` (falling back to
`~/.dsh/profiles/web`). **A newly installed profile needs one DSH Desktop
restart to compose.**

Two loading mechanisms exist and exactly one is active at a time, because both
would insert the same `id: xefg-think` and collide:

- **bundle mode** registers the package in the profile manifest
  (`dsh.profile.bundles` + a `file:./vendor/…` dependency) and lets its own
  `cordis.patch.yml` insert the entry. This is what makes it appear under
  *Settings → Plugins → installed bundles* with a working switch.
- **legacy mode** appends the insert to the profile's `cordis.patch.yml`
  directly. It loads identically but the plugin manager cannot see it, because
  that page enumerates bundles rather than arbitrary patch inserts.

Where the toggle lives: `conversation.input.right` — the composer row. That
slot renders on the landing page *and* inside a session, unlike
`conversation.session.header.actions`, which does not exist until a session
does (so a header pill is invisible on the empty "探索未至之境" screen).

The pill is **off by default**. While off, the plugin contributes no prompt text
and registers no tools — the only thing alive is `GET/POST /xefg-think/state`.
Token cost of a disabled plugin is exactly zero.

State lives in `%APPDATA%\DSH Desktop\xefg-think\state.json` (or `$DSH_HOME`),
so it survives restarts.

**Where the section sits.** `dsh-system-prompt` sorts sections ascending, and its
own bands end at `DEPLOYMENT_PERSONA_SUFFIX = 10200`:

```
HARNESS_IDENTITY            -1000
DEPLOYMENT_PERSONA_PREFIX       0   <- an agent preset's persona lands here
PLAN_POLICY / TEAM / PTC    500-800
WEB_SURFACE                 10100
DEPLOYMENT_PERSONA_SUFFIX   10200   <- the last thing a preset authored
```

This plugin's section defaults to **10300**, i.e. *after* every built-in band, so
it reads as a trailing appendix instead of landing in the middle of a preset's
own prompt. A section's order is fixed at registration time, so it is a state
field (`params.sectionOrder`, 200–20000) and changing it disposes and
re-registers the section — no restart:

```
POST /xefg-think/state  {"params": {"sectionOrder": 150}}
```

Below 10200 the block is interleaved with persona/tool guidance, which is what
made a custom ops preset ("Hermes Ops / V2Board Campaign") stop behaving: a
2596-character block opening with *"this is a precondition, not advice"* sitting
right after the persona reads as an amendment to the identity. Two mitigations
ship with it — the order above, and `vm/protocol-short.txt`, a ~500-character
version that carries only the instruction and none of the argument.

---

## 2. The mapping

Intel's XeSS-FG descends from *ExtraSS*, which chose **extrapolation** over
interpolation: generate `t+1` from frames `≤ t`. Interpolation needs the future
frame, which costs latency; extrapolation is causal. A language model is
causally constrained in exactly the same way, so the same choice is forced here
— a unit may never `ref` a later frame, and doing so is reported as a
`FORWARD_REF` violation.

| Graphics pipeline | Here |
|---|---|
| frame `I_t` | one reasoning step = 1–5 **units** (claims) |
| pixel | one unit |
| motion vectors **from the engine** | `ref: "F1.0"` — the reasoner's own provenance link |
| estimated flow (no MV available) | hashed n-gram embedding + greedy max-cosine matching |
| warp `I_{t-1}` by `F_t` | `𝒲(units_{t-1}, flow)` → predicted frame `t` |
| occlusion / disocclusion mask `λ` | units with no forward-backward-consistent source |
| softmax blend of warped references | weighted average over the previous `maxRefDepth` frames |
| temporal stability | *hole chaining*: a hole reused as a premise |
| frame dropping | redundancy gate |
| joint spatial super-sampling | elaboration whose degradation must reproduce the terse claim |

The motion-vector row is the important one. In a game the renderer supplies
motion vectors and depth; the frame-generation network only warps, blends and
hallucinates. Here the *reasoner* supplies `ref`, and this plugin only warps,
blends, and flags. Where `ref` is absent it falls back to estimated flow — a
deliberate downgrade, documented in §6.

---

## 3. The math, exactly as implemented

Let `φ(u) ∈ ℝ^256` be the unit embedding (signed hashing of word unigrams and
character trigrams, L2-normalised — a cheap Johnson–Lindenstrauss projection, so
inner products estimate similarity without bias).

**Flow** between consecutive frames is a greedy max-weight bipartite matching:

```
M_t = greedy argmax  Σ  cos(φ_i^{t-1}, φ_j^{t})
```

**Disocclusion.** A unit `u` at frame `t` is a hole (`λ=1`) unless it has a
source. Which source, and how much it is trusted, depends on where it came from:

```
u declares ref → TRUSTED (λ=0)                ← engine-supplied motion vector,
                                               authoritative, cos only reported
                                               as `weak-mv` when < τ_flow
no ref, estimated flow:
      cos ≥ τ_flow ∧ RT ≥ τ_rt → λ=0          ← round-trip consistent
      anchor support ≥ τ_sup   → λ=0          ← borrowed from outside the chain
      otherwise                → λ=1          ← low-flow / inconsistent
no candidate at all            → λ=1          ← no-flow
```

The asymmetry is deliberate and is the one place this deviates from a naive
reading of ExtraSS. In a game the renderer's motion vectors are ground truth:
the frame-generation network warps by them and does not second-guess whether the
pixels "look related". Here the reasoner *is* the renderer, so a declared `ref`
is trusted the same way — but a link whose surface barely resembles its source
is surfaced as `SUSPECT … that link may be a rationalisation rather than a
derivation`, because a plausible-looking link is exactly how confabulation
launders itself. Estimated flow, which has no such authority, is held to the
strict round-trip standard.

**Blend.** For each unit, over the previous `maxRefDepth` frames:

```
w_k = exp(−β (1 − cos_k))
ŝ  = Σ_k w_k 𝒲(s_k, F_k) / Σ_k w_k
```

`β` is the sharpness knob exposed in the UI: low β averages distant history,
high β trusts only the nearest frame.

**Hole chaining** (the taint rule, and the reason this is worth doing at all):
if unit `u` warps from a source that was itself a hole, the chain is reported as
a violation —

```
λ(u)=0 ∧ λ(src(u))=1  ⇒  HOLE_CHAIN
```

An admitted hole costs one clause. A hole promoted to a premise costs the whole
chain. That asymmetry is the entire safety argument of the design.

**Verdicts.** Per frame:

```
EXPAND   if  hole_ratio > hole_max            (go ground it before extending)
DROP     if  redundancy  ≥ redundant_max      (restates what is already on the board)
KEEP     otherwise
```

**Super-resolution half.** Given a terse claim `s` and an expansion `G(s)`, with
a degradation operator `D`:

```
fidelity    = cos(φ(D(G(s))), φ(s))                     ← PSNR analogue
unsupported = { u ∈ G(s) : max cos(u, s ∪ anchors) < τ_sup }   ← LPIPS analogue, inverted
```

Verdict `FAITHFUL` / `OVERDETAIL` (detail outran its support) / `DRIFTED`
(degrading no longer reproduces the claim — the expansion changed the claim, not
its resolution). This is the one place where the graphics lesson is directly
actionable: *super-resolution cannot create information, only redistribute
prior*. Any accuracy gain from elaboration must come from better access to
latent knowledge, never from new information. So the expansion must be checked
against the constraint it came from.

---

## 3b. The evidence gate (default-deny)

The geometric half can only judge *structure*: does this unit warp from a covered
source? It cannot tell whether the source itself was ever checked. In round two
of the experiment that gap produced the most expensive failure: an agent
concluded "`system("/bin/sh")` never yields a shell in this container" (false),
built a fragile syscall-only ROP chain on top of it, and the result worked 12
times out of 19. The chain was internally consistent the whole way — it was just
standing on nothing.

So every unit now carries an evidence label, and silence is not free:

| `verified` | meaning |
|---|---|
| `binary` | read out of the binary: disassembly, symbols, section headers |
| `service` | observed live: a banner, a leak, a crash you caused |
| `assumed` | inference, prior experience, or simply unchecked |

**Missing, unknown, or `assumed` all resolve to `assumed`, and an assumed unit
becomes a hole** (unless it literally restates an anchor, which is evidence by
definition). That is the whole point: *saying nothing must cost exactly as much
as admitting you assumed it*, or silence would be the cheapest way to pass.

The consequence is deliberate and visible — a declared assumption with a perfect
`ref` is still a hole, and everything downstream of it is reported as
`HOLE_CHAIN`:

```
[F1] EXPAND  holes 1/2  assumed 1
  * GROUND F1.0: marked as an assumption (or left unlabelled) — verify it
    against the binary, the service, or a document before anything is built on it.
  * EXPAND F1, EXPAND F2, violations=1        <- the taint propagated
```

Strictness is host config, never model input — `evidenceGate`:

| value | behaviour |
|---|---|
| `hole` (default) | unlabelled/assumed → hole, taints downstream |
| `warn` | counted and reported, but not escalated |
| `off` | pre-gate behaviour (the geometry-only ablation; §6 keeps using it) |

Measured on the labelled set (§6): an honest labeller pays **nothing** (8/24
holes at every setting — identical to `off`), while a model that labels nothing
goes from **8/24 to 17/24** holes. Default-deny therefore costs only the
uncooperative case, which is exactly the case worth costing.

**What this does not do.** It cannot stop a model from writing
`verified: "binary"` about something it never checked. The tool scores the labels
it is given; it reads no hidden state and cannot audit a claim. The gate closes
the *silence* path, not the *lying* path. Catching the latter needs sampled
auditing — pick some `binary` claims and re-check them against the artifact —
which is a job for the evaluator, not for a prompt.

---

## 4. Two tools

- `xefg_frame({anchors, frames:[{id, units:[{text, ref?, verified}]}]})` → per-frame hole
  ratio, blend weights, redundancy, gain, `KEEP/EXPAND/DROP`, and a directive
  list. ~40 lines of text back, not a JSON dump.
- `xefg_verify({summary, expansion, degraded?})` → round-trip fidelity,
  unsupported units, verdict.

Both are only mounted while the toggle is on, so a disabled plugin adds no
schema tokens either.

---

## 5. Running the experiment

The mechanical side is measured for you (the popover shows calls / holes /
dropped / tokens saved). The interesting side needs a task set.

Suggested design:

1. **Confabulation.** Take tasks whose correct answer requires one fact that is
   *not* derivable from the prompt. Off vs on: count chains that assert the
   missing fact without retrieving it. Prediction: `HOLE_CHAIN` violations are
   a leading indicator, not just a post-hoc label.
2. **Token efficiency at equal accuracy.** Same tasks, measure tokens and
   correctness. Prediction: dropping redundant frames buys 15–30% on verbose
   reasoning, and costs accuracy only where the drop threshold is too loose.
3. **Ablations** (all knobs are live in the UI):
   - `hole_max = 1.0` → disables EXPAND entirely; isolates the taint rule.
   - `redundant_max = 1.0` → disables dropping; isolates the token saving.
   - sweep `tau_flow` 0.3→0.8 and plot EXPAND rate against accuracy. If the
     curve has a knee, the flow estimate is doing real work; if it is flat, it
     is not.
4. **Overdetail.** Ask for an elaboration of a terse claim, then check every
   invented specific (numbers, names, commits) against the source. Expect
   `OVERDETAIL` to fire on exactly those.

---

## 6. Tuning, measured

`tune.mjs` scores seven labelled chains (10 fabricated units, 10 legitimate ones)
and sweeps the knobs. The result is not what I expected.

**The thresholds barely matter.** Across τ_support ∈ [0.15, 0.40] × τ_flow ∈
[0.25, 0.55], the detector scores **P=100%, R=90%, F1=0.95** at every single
setting. Only the escalation cost moves (6 or 7 of 24 frames forced to EXPAND).
There is no cliff to find, because the decision that matters is *whether a unit
declares a source at all*, not how similar that source is.

**So the defaults are set to the cheap end of a flat region**, and the budget
belongs to the protocol, not the numbers:

| knob | value | why |
|---|---|---|
| `holeMax` | **0.25** | The cost dial, not an accuracy dial. Read it as *holes tolerated per frame* = `holeMax × units_per_frame`. 0.25 × 4 units = one hole per frame. 1.00 turns the gate off entirely. |
| `tauFlow` | **0.45** | Barely touches `λ` (a declared ref is trusted), but it is the only thing that calibrates the `SUSPECT` soft alarm — i.e. the only handle on "the model fabricated a ref". |
| `tauSupport` | **0.40** | Load-bearing on the *verify* half only. Sensitivity is a step: ≤0.15 sees no invented detail at all, ≥0.20 catches it, 0.30–0.45 is the plateau. Set for the half with teeth, leave margin. |
| `tauRoundTrip` | 0.35 | Auto-flow only; unused when the model declares refs. |
| `tauRedundant` / `redundantMax` | 0.8 / 0.5 | 0.9 misses restatements; below 0.7 buys nothing. |
| `beta` | 6 | Cosmetic — it only shapes the `blend` column in the report. |
| `weakAsHole` | **false** | See below. |

**Strict mode is a bad trade.** Measuring it rather than assuming:

```
preset          P=100%  R= 90%  F1=0.95   EXPAND  7/24
preset+strict   P= 59%  R=100%  F1=0.74   EXPAND 13/24
```

It buys the last 10% of recall with seven false alarms and nearly double the
escalation, because with a lexical prior "legitimate derivation" and
"fabricated claim with a plausible ref" are the *same distance*. Only enable it
where a false alarm is free — an audit in which every claim gets verified anyway.

**Two honest caveats.** Seven chains and twenty judgeable units make a wide
confidence interval: treat the numbers as directions, not as a benchmark.
Replacing `CHAINS` in `tune.mjs` with labelled real traces is the only way to
get a real one.

### The three things that actually change the result

Ranked by measured effect, none of them a threshold:

1. **Make the protocol demand a `ref` on every derived unit.** `HOLE_CHAIN` is
   the only mechanism that catches a hole promoted to a premise (chain `G`: the
   tainted unit's own `λ` is 0, and the taint detector is what catches it). With
   refs omitted you lose the taint rule *and* drop from 90% to 70% recall.
2. **Read `λ ∨ HOLE_CHAIN`, not `λ`.** Counting only the hole flag understates
   recall by 10–20 points on this set. Taint is a detection channel.
3. **Give anchors generously.** Every grounded fact the chain may legally reuse.
   Under-supplying anchors makes `xefg_verify` report `OVERDETAIL` on detail that
   *is* supported — a false accusation that costs more trust than it saves.

### The ceiling

Chain `E` is fabricated but carries a plausible `ref`; its own `λ` is 0 and no
taint fires. Only the `SUSPECT` channel notices, and a warning is not a gate.
That is the limit of a lexical prior, and it is why swapping in hidden states is
the next order of magnitude rather than a tweak.

---

## 7. Known limitations, stated honestly

- **The flow estimate is lexical.** Real XeSS-FG gets motion vectors from the
  renderer; a real version of this would get them from the model's hidden
  states, per unit. `hashEmbed` is a stand-in that behaves like a very weak
  semantic encoder. Consequence, and there is a test pinning it: a *paraphrase*
  is not recognised as redundant, only a literal restatement. Swapping in hidden
  states is the single highest-value change and the architecture already
  supports it — `analyseChain` needs only `vec` per unit.
- **There is no ground-truth intermediate frame.** Frame generation is trained
  on real high-frame-rate video; reasoning has no such supervision. So the
  criteria are reference-free: round-trip consistency plus anchor support. That
  is weaker than a loss against truth, and it can be satisfied by a coherent
  wrong chain that is internally consistent from wrong anchors.
- **`D` is a proxy.** The degradation operator is a centrality-based
  summariser unless the caller passes `degraded` (i.e. asks the model to
  compress its own expansion). The proxy is deterministic and testable; the real
  one is the model's summary, and callers should use it.
- **The protocol is prompt-level.** It changes behaviour only as far as the
  model follows instructions. The tool is what makes it more than prompt
  engineering: it returns a *computed* signal the model can act on, not an
  assertion to be taken on faith.
- **`DEFAULTS` come from a small labelled set, not from production traces.**
  See §6 — the thresholds turned out to be nearly inert, so the risk here is
  lower than it looks, but the recall figure (90%) is only as good as the seven
  chains it was measured on.

---

## 8. Files

```
lib/engine.js      the math — pure, deterministic, dependency-free
lib/index.js       host half: state file, HTTP toggle, tools, gated prompt section
lib/client.js      browser half: header pill + threshold/stats popover
test/engine.test.mjs   19 assertions over the math
test/host.dryrun.mjs    7 assertions over registration/lifecycle against a mock ctx
tune.mjs           labelled chains + knob sweep (§6)
demo.mjs           one realistic chain, end to end
install.ps1        idempotent profile install
```

```powershell
node --test test/engine.test.mjs
node --test test/host.dryrun.mjs
```
