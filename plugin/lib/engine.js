/**
 * XeFG-Thinking engine.
 *
 * Frame generation math transported from extrapolation-based frame generation
 * (Intel XeSS-FG / ExtraSS) into a reasoning chain. The correspondence with the
 * graphics pipeline is structural, not metaphorical:
 *
 *   frame I_t                      -> one reasoning step ("frame") = 1..n units
 *   motion vectors from the engine -> provenance `ref` supplied by the reasoner
 *   bilinear warp I_t by F_t       -> warp(units of t-1, flow) -> predicted t
 *   occlusion / disocclusion mask  -> lambda: a unit with no consistent source
 *   softmax blend of warped refs   -> weighted blend over the last `maxRefDepth`
 *   temporal stability check       -> hole-chaining: a hole reused as a premise
 *   frame dropping                 -> redundancy gate
 *   joint spatial super sampling   -> elaboration whose degradation must reproduce
 *                                     the terse thought it came from
 *
 * Two deliberate departures from the paper, both documented in README.md:
 *   1. The engine has no real motion vectors. Where the reasoner provides
 *      `ref`, that IS the motion vector (faithful: in games the renderer
 *      supplies them too). Where it does not, we estimate flow from a hashed
 *      n-gram embedding — a stand-in for hidden states, not the real thing.
 *   2. There is no ground-truth intermediate frame, so "correctness" is
 *      replaced by two reference-free criteria: round-trip consistency
 *      (forward-backward reprojection) and anchor support.
 *
 * Everything here is deterministic and dependency-free.
 */

export const ENGINE_VERSION = '0.1.3'

/** Default hyper-parameters — the measured preset from tune.mjs, not guesses. */
export const DEFAULTS = Object.freeze({
  dim: 256, // hashed embedding width
  tauFlow: 0.45, // min cosine for a warp to count as a real continuation
  tauRoundTrip: 0.35, // forward-backward reprojection consistency
  tauSupport: 0.4, // anchor support that overrides a failed round trip (chain side) AND
  //                 the support bar for elaboration detail (verify side). Measured
  //                 inert on the chain side across 0.15-0.40, load-bearing on the
  //                 verify side, so it is set for the half where it has teeth.
  beta: 6, // softmax sharpness of the warp blend
  holeMax: 0.25, // hole ratio above which a frame must be EXPANDed
  tauRedundant: 0.8, // a unit this close to an earlier one is a duplicate frame
  redundantMax: 0.5, // duplicate mass at which a frame is DROPPED
  weakAsHole: false, // strict: a ref that barely resembles its source is a hole, not a warning
  // Default-deny evidence gate: a unit whose `verified` is missing, unknown, or
  // 'assumed' is an ungrounded assertion and becomes a hole. 'warn' reports it
  // without escalating; 'off' restores the pre-evidence behaviour (ablation).
  evidenceGate: 'hole',
  // Prompt section order. dsh-system-prompt bands end at 10200
  // (DEPLOYMENT_PERSONA_SUFFIX); above that this block is a trailing appendix
  // rather than an amendment landing inside a preset's own prompt.
  sectionOrder: 10300,
  maxRefDepth: 3, // how many previous frames blend into one target frame
})

const SEP = '\u0001'

/**
 * Signed hashing of word unigrams + character trigrams into a fixed-width
 * vector, L2-normalised. Character trigrams make it language-agnostic (CJK has
 * no word boundaries worth trusting); signed hashing keeps inner products an
 * unbiased estimator, i.e. a cheap Johnson-Lindenstrauss projection.
 */
export function hashEmbed(text, dim = DEFAULTS.dim) {
  const v = new Float64Array(dim)
  const norm = String(text ?? '').toLowerCase()
  const words = norm.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
  const push = (tok, w) => {
    let h = 2166136261
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    h >>>= 0
    v[h % dim] += ((h >>> 16) & 1) === 1 ? -w : w
  }
  for (const w of words) push('w' + SEP + w, 1)
  const compact = norm.replace(/[^\p{L}\p{N}]+/gu, '')
  if (compact.length < 3) {
    if (compact) push('c' + SEP + compact, 0.45)
  } else {
    for (let i = 0; i + 3 <= compact.length; i++) push('c' + SEP + compact.slice(i, i + 3), 0.45)
  }
  let n = 0
  for (let i = 0; i < dim; i++) n += v[i] * v[i]
  n = Math.sqrt(n)
  if (n > 0) for (let i = 0; i < dim; i++) v[i] /= n
  return v
}

/** Cosine similarity of two already-normalised vectors. */
export function cosine(a, b) {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/**
 * Split arbitrary text into "units" — one claim or one step each. Units are the
 * pixels of this pipeline. Pre-split input passes through untouched.
 */
export function unitize(input, maxChars = 160) {
  const raw = Array.isArray(input) ? input : [input]
  const out = []
  for (const item of raw) {
    if (item && typeof item === 'object') {
      if (typeof item.text !== 'string') continue
      const text = item.text.trim()
      if (!text) continue
      out.push({
        text,
        ref: typeof item.ref === 'string' && item.ref.trim() ? item.ref.trim() : undefined,
        id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined,
        verified:
          typeof item.verified === 'string' && item.verified.trim() ? item.verified.trim().toLowerCase() : undefined,
      })
      continue
    }
    const text = String(item ?? '')
    for (const seg of text.split(/[。；;！!？?]+|\n+|(?<=[.])\s+/)) {
      const s = seg.trim()
      if (!s) continue
      if (s.length <= maxChars) {
        out.push({ text: s })
        continue
      }
      for (const part of s.split(/[，,、]+/)) {
        const p = part.trim()
        if (p) out.push({ text: p })
      }
    }
  }
  return out
}

function buildFrames(frames, dim) {
  const built = []
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi] ?? {}
    const id = typeof f.id === 'string' && f.id.trim() ? f.id.trim() : String(fi)
    const units = unitize(f.units ?? f.text ?? [])
    built.push({
      id,
      index: fi,
      units: units.map((u, ui) => ({
        key: u.id ?? id + '.' + ui,
        text: u.text,
        ref: u.ref,
        verified: u.verified,
        vec: hashEmbed(u.text, dim),
        chars: u.text.length,
      })),
    })
  }
  return built
}

function buildAnchors(anchors, dim) {
  const list = []
  for (const a of Array.isArray(anchors) ? anchors : []) {
    const text = typeof a === 'string' ? a : a && typeof a.text === 'string' ? a.text : ''
    if (!text.trim()) continue
    list.push({ text: text.trim(), source: (a && a.source) || undefined, vec: hashEmbed(text, dim) })
  }
  return list
}

/** Greedy max-weight bipartite matching over cosine similarity (the flow estimate). */
function greedyMatch(A, B) {
  const cand = []
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) cand.push([i, j, cosine(A[i].vec, B[j].vec)])
  }
  cand.sort((x, y) => y[2] - x[2])
  const usedA = new Uint8Array(A.length)
  const usedB = new Uint8Array(B.length)
  const pairs = []
  for (const [i, j, c] of cand) {
    if (c <= 0 || usedA[i] || usedB[j]) continue
    usedA[i] = 1
    usedB[j] = 1
    pairs.push([i, j, c])
  }
  return pairs
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const round = (x, d = 3) => {
  const p = Math.pow(10, d)
  return Math.round(x * p) / p
}

/**
 * The main pass: warp, disocclude, blend, gate.
 *
 * @param {{anchors?: unknown[], frames?: unknown[]}} input
 * @param {Partial<typeof DEFAULTS>} overrides
 */
export function analyseChain(input = {}, overrides = {}) {
  const P = { ...DEFAULTS, ...(input.params || {}), ...overrides }
  const frames = buildFrames(Array.isArray(input.frames) ? input.frames : [], P.dim)
  const anchors = buildAnchors(input.anchors, P.dim)
  const T = frames.length
  if (T === 0) return { ok: false, reason: 'no frames', engine: ENGINE_VERSION }

  // Global unit registry so `ref` can name any earlier unit.
  const registry = new Map()
  for (const f of frames) for (const u of f.units) registry.set(u.key, { t: f.index, key: u.key })

  // Adjacent-frame flow: forward link (t-1 -> t) and its backward map.
  const link = new Array(T).fill(null)
  for (let t = 1; t < T; t++) {
    const l = new Array(frames[t].units.length).fill(null)
    for (const [i, j, c] of greedyMatch(frames[t - 1].units, frames[t].units)) {
      l[j] = { i, cos: c }
    }
    link[t] = l
  }

  // Multi-reference blend: pairwise matches for every (s, t) with s < t.
  const pairMatch = new Map()
  const matchOf = (s, t) => {
    const k = s + '>' + t
    let m = pairMatch.get(k)
    if (!m) {
      m = greedyMatch(frames[s].units, frames[t].units)
      pairMatch.set(k, m)
    }
    return m
  }

  const anchorSupport = (vec) => {
    let best = 0
    let at = -1
    for (let k = 0; k < anchors.length; k++) {
      const c = cosine(vec, anchors[k].vec)
      if (c > best) {
        best = c
        at = k
      }
    }
    return { cos: best, index: at }
  }

  const report = {
    ok: true,
    engine: ENGINE_VERSION,
    params: {
      tauFlow: P.tauFlow,
      tauRoundTrip: P.tauRoundTrip,
      beta: P.beta,
      tauSupport: P.tauSupport,
      holeMax: P.holeMax,
      tauRedundant: P.tauRedundant,
      redundantMax: P.redundantMax,
      weakAsHole: P.weakAsHole,
      maxRefDepth: P.maxRefDepth,
    },
    anchors: anchors.length,
    frames: [],
    summary: {},
    directives: [],
    violations: [],
  }

  // ---- per-frame, per-unit pass -------------------------------------------
  const lambdaAt = [] // lambdaAt[t][j]
  for (let t = 0; t < T; t++) {
    const f = frames[t]
    lambdaAt[t] = new Uint8Array(f.units.length)
    const units = []
    let holes = 0
    let sumCos = 0
    let coveredCount = 0
    let noveltySum = 0
    let redundantCount = 0
    let weakCount = 0
    let assumedCount = 0

    for (let j = 0; j < f.units.length; j++) {
      const u = f.units[j]
      const a = anchorSupport(u.vec)

      // 1. source of this unit: model-supplied motion vector, else estimated flow
      let src = null
      let mode = 'none'
      let cos = 0
      if (u.ref && registry.has(u.ref)) {
        const r = registry.get(u.ref)
        if (r.t < t) {
          // extrapolation only: a future frame is not a legal source
          src = { t: r.t, key: r.key }
          const srcUnit = frames[r.t].units.find((x) => x.key === r.key)
          cos = srcUnit ? cosine(u.vec, srcUnit.vec) : 0
          mode = 'model'
        } else {
          report.violations.push({
            code: 'FORWARD_REF',
            unit: u.key,
            ref: u.ref,
            detail: 'ref points at the same or a later frame; extrapolation forbids it',
          })
        }
      }
      if (!src && t > 0 && link[t] && link[t][j]) {
        src = { t: t - 1, key: frames[t - 1].units[link[t][j].i].key }
        cos = link[t][j].cos
        mode = 'auto'
      }

      // 2. forward-backward reprojection consistency
      let rt = 0
      if (src) {
        let bestJ = -1
        let bestC = -1
        const srcUnit = frames[src.t].units.find((x) => x.key === src.key)
        if (srcUnit) {
          for (let k = 0; k < f.units.length; k++) {
            const c = cosine(srcUnit.vec, f.units[k].vec)
            if (c > bestC) {
              bestC = c
              bestJ = k
            }
          }
        }
        rt = bestJ === j ? bestC : 0
      }

      // 3. disocclusion test -> lambda
      //
      // The evidence gate runs FIRST, before any geometric test. An unlabelled
      // unit is by definition an ungrounded assertion, so the default-deny rule
      // makes "say nothing" exactly as expensive as "admit you assumed it" —
      // otherwise silence would be the cheapest way to pass.
      const evidence = u.verified === 'binary' || u.verified === 'service' ? u.verified : 'assumed'
      if (evidence === 'assumed') assumedCount++
      const evidenceHole = evidence === 'assumed' && P.evidenceGate === 'hole' && a.cos < P.tauSupport

      let lambda
      let why
      let weak = false
      if (t === 0) {
        lambda = 0
        why = 'root'
      } else if (evidenceHole) {
        // No ref, no anchor, no label — nothing here is checkable.
        lambda = 1
        why = 'unverified'
      } else if (!src) {
        lambda = 1
        why = 'no-flow'
      } else if (mode === 'model') {
        // An explicit `ref` is the engine-supplied motion vector: in frame
        // generation the renderer's MV is authoritative and the network does
        // not second-guess it. A link whose surface barely resembles its source
        // is reported as weak — or, in strict mode, promoted to a hole, because
        // a plausible-looking ref is exactly how confabulation launders itself.
        weak = cos < P.tauFlow
        if (weak && P.weakAsHole) {
          lambda = 1
          why = 'weak-mv'
        } else {
          lambda = 0
          why = weak ? 'mv-weak' : 'mv'
        }
        if (weak) weakCount++
      } else if (cos >= P.tauFlow && rt >= P.tauRoundTrip) {
        lambda = 0
        why = 'round-trip'
      } else if (a.cos >= P.tauSupport) {
        lambda = 0
        why = 'anchor'
      } else {
        lambda = 1
        why = cos < P.tauFlow ? 'low-flow' : 'inconsistent'
      }

      // 4. softmax blend over up to maxRefDepth previous frames
      let blendCos = 0
      if (t > 0) {
        const cands = []
        for (let d = 1; d <= P.maxRefDepth && t - d >= 0; d++) {
          const hit = matchOf(t - d, t).find((p) => p[1] === j)
          if (hit && hit[2] >= P.tauFlow) cands.push(hit[2])
        }
        if (cands.length) {
          let ws = 0
          let acc = 0
          for (const c of cands) {
            const w = Math.exp(-P.beta * (1 - c))
            ws += w
            acc += w * c
          }
          blendCos = acc / ws
        }
      }

      // 5. information gain: how much of this unit is not already on the board
      let novelty = 1
      if (t > 0) {
        let best = 0
        for (let s = 0; s < t; s++) {
          for (const pu of frames[s].units) {
            const c = cosine(u.vec, pu.vec)
            if (c > best) best = c
          }
        }
        novelty = 1 - clamp01(best)
      }
      if (t > 0 && novelty <= 1 - P.tauRedundant) redundantCount++

      lambdaAt[t][j] = lambda
      if (lambda) holes++
      else {
        coveredCount++
        sumCos += cos
      }
      noveltySum += novelty

      units.push({
        key: u.key,
        text: u.text,
        lambda,
        why,
        weak,
        evidence,
        from: src ? src.key : null,
        flow: mode,
        cos: round(cos),
        rt: round(rt),
        anchor: round(a.cos),
        blend: round(blendCos),
        gain: round(novelty),
      })
    }

    const n = f.units.length
    report.frames.push({
      id: f.id,
      index: t,
      units,
      units_count: n,
      holes,
      hole_ratio: n ? round(holes / n) : 0,
      mean_flow_cos: coveredCount ? round(sumCos / coveredCount) : 0,
      gain: n ? round(noveltySum / n) : 0,
      redundant: n ? round(redundantCount / n) : 0,
      weak: weakCount,
      assumed: assumedCount,
      chars: f.units.reduce((s, u) => s + u.chars, 0),
    })
  }

  // ---- hole chaining: a hole promoted to a premise -------------------------
  for (let t = 1; t < T; t++) {
    for (const u of report.frames[t].units) {
      if (u.lambda || !u.from) continue
      const [srcFrameKey] = u.from.split('.')
      const srcFrameIdx = frames.findIndex((f) => f.id === srcFrameKey || String(f.index) === srcFrameKey)
      if (srcFrameIdx < 0 || srcFrameIdx !== t - 1) continue
      const i = frames[t - 1].units.findIndex((x) => x.key === u.from)
      if (i >= 0 && lambdaAt[t - 1][i]) {
        report.violations.push({
          code: 'HOLE_CHAIN',
          unit: u.key,
          detail: 'warped from ' + u.from + ' which was itself a hole: an unverified claim became a premise',
        })
      }
    }
  }

  // ---- verdicts and stability --------------------------------------------
  let driftSum = 0
  let driftN = 0
  for (let t = 1; t < T; t++) {
    const fr = report.frames[t]
    driftSum += 1 - fr.mean_flow_cos
    driftN++
  }
  const drift = driftN ? driftSum / driftN : 0

  for (const fr of report.frames) {
    let verdict
    if (fr.hole_ratio > P.holeMax) verdict = 'EXPAND'
    else if (fr.redundant >= P.redundantMax) verdict = 'DROP'
    else verdict = 'KEEP'
    fr.verdict = verdict
  }

  const kept = report.frames.filter((f) => f.verdict !== 'DROP')
  const dropped = report.frames.filter((f) => f.verdict === 'DROP')
  const expand = report.frames.filter((f) => f.verdict === 'EXPAND')
  const totalHoles = report.frames.reduce((s, f) => s + f.holes, 0)
  const totalUnits = report.frames.reduce((s, f) => s + f.units_count, 0)
  const savedChars = dropped.reduce((s, f) => s + f.chars, 0)

  report.summary = {
    frames: T,
    units: totalUnits,
    holes: totalHoles,
    hole_ratio: totalUnits ? round(totalHoles / totalUnits) : 0,
    kept: kept.length,
    dropped: dropped.length,
    expand: expand.length,
    drift: round(drift),
    stability: round(clamp01(1 - drift)),
    estimated_tokens_saved: Math.round(savedChars / 4),
    weak_refs: report.frames.reduce((s, f) => s + f.weak, 0),
    assumed: report.frames.reduce((s, f) => s + f.assumed, 0),
    violations: report.violations.length,
  }

  // ---- actionable directives ---------------------------------------------
  for (const fr of expand) {
    report.directives.push(
      'EXPAND ' +
        fr.id +
        ': hole ratio ' +
        fr.hole_ratio +
        ' > ' +
        P.holeMax +
        ' — ground these units before extending the chain.'
    )
  }
  for (const fr of dropped) {
    report.directives.push(
      'DROP ' +
        fr.id +
        ': redundancy ' +
        fr.redundant +
        ' >= ' +
        P.redundantMax +
        ' — it restates frames already on the board; writing it buys nothing.'
    )
  }
  for (const v of report.violations) {
    if (v.code === 'HOLE_CHAIN') report.directives.push('FIX ' + v.unit + ': ' + v.detail + '.')
    else if (v.code === 'FORWARD_REF') report.directives.push('FIX ' + v.unit + ': ' + v.detail + '.')
  }
  for (const fr of report.frames) {
    for (const u of fr.units) {
      if (!u.weak) continue
      report.directives.push(
        'SUSPECT ' +
          u.key +
          ': the ref ' +
          u.from +
          ' barely resembles the claim (cos ' +
          u.cos +
          ') — that link may be a rationalisation rather than a derivation.'
      )
    }
  }
  if (P.evidenceGate !== 'off') {
    for (const fr of report.frames) {
      for (const u of fr.units) {
        if (u.evidence !== 'assumed' || fr.index === 0) continue
        report.directives.push(
          'GROUND ' +
            u.key +
            ': marked as an assumption (or left unlabelled) — verify it against the binary, the service, or a document before anything is built on it.'
        )
      }
    }
  }
  if (dropped.length === 0 && expand.length === 0 && report.violations.length === 0) {
    report.directives.push('Chain is consistent: every unit warps from a covered source or an anchor.')
  }

  return report
}

/**
 * Centrality-based stand-in for the abstractor `D`. A real deployment would call
 * the reasoner's own summarizer; the caller can override it with `degraded`.
 */
function degrade(units, dim) {
  if (units.length <= 2) return units.map((u) => u.text).join(' / ')
  const vecs = units.map((u) => hashEmbed(u.text, dim))
  const centrality = vecs.map((v, i) => {
    let s = 0
    for (let k = 0; k < vecs.length; k++) if (k !== i) s += cosine(v, vecs[k])
    return s / (vecs.length - 1)
  })
  const keep = Math.max(1, Math.ceil(units.length * 0.5))
  // A summary keeps the topic sentence and the most central remainder.
  const picked = new Set([0])
  const order = units
    .map((_, i) => i)
    .filter((i) => i !== 0)
    .sort((a, b) => centrality[b] - centrality[a])
  for (const i of order) {
    if (picked.size >= keep) break
    picked.add(i)
  }
  return [...picked]
    .sort((a, b) => a - b)
    .map((i) => units[i].text)
    .join(' / ')
}

/**
 * The super-resolution half: an elaboration is only admissible if degrading it
 * reproduces the terse thought it expanded from (round-trip / cycle
 * consistency), and if its detail does not outrun its support.
 */
export function verifyExpansion(input = {}, overrides = {}) {
  const P = { ...DEFAULTS, ...(input.params || {}), ...overrides }
  const summary = typeof input.summary === 'string' ? input.summary : ''
  const expansion = typeof input.expansion === 'string' ? input.expansion : ''
  if (!summary.trim() || !expansion.trim()) {
    return { ok: false, reason: 'summary and expansion are both required', engine: ENGINE_VERSION }
  }

  const low = unitize(summary)
  const hi = unitize(expansion)
  const anchors = buildAnchors(input.anchors, P.dim)
  const lowVecs = low.map((u) => hashEmbed(u.text, P.dim))
  const anchorVecs = anchors.map((a) => a.vec)

  const units = []
  let unsupported = 0
  let supportSum = 0
  for (const u of hi) {
    const v = hashEmbed(u.text, P.dim)
    let best = 0
    let where = 'none'
    for (const lv of lowVecs) {
      const c = cosine(v, lv)
      if (c > best) {
        best = c
        where = 'summary'
      }
    }
    for (const av of anchorVecs) {
      const c = cosine(v, av)
      if (c > best) {
        best = c
        where = 'anchor'
      }
    }
    const bad = best < P.tauSupport
    if (bad) unsupported++
    supportSum += best
    units.push({ text: u.text, support: round(best), where, unsupported: bad })
  }

  const degraded =
    typeof input.degraded === 'string' && input.degraded.trim() ? input.degraded.trim() : degrade(hi, P.dim)
  const fidelity = cosine(hashEmbed(degraded, P.dim), hashEmbed(summary, P.dim))
  const unsupportedRatio = hi.length ? unsupported / hi.length : 0
  const novelty = hi.length ? 1 - supportSum / hi.length : 0

  let verdict
  if (unsupportedRatio > 0.34) verdict = 'OVERDETAIL'
  else if (fidelity < 0.45) verdict = 'DRIFTED'
  else verdict = 'FAITHFUL'

  const directives = []
  if (verdict === 'OVERDETAIL') {
    directives.push(
      'OVERDETAIL: ' +
        unsupported +
        '/' +
        hi.length +
        ' elaboration units have no support in the summary or anchors — cut them or move them to an anchor.'
    )
  } else if (verdict === 'DRIFTED') {
    directives.push(
      'DRIFTED: degrading the expansion no longer reproduces the summary (fidelity ' +
        round(fidelity) +
        ') — the expansion changed the claim, not just its resolution.'
    )
  } else {
    directives.push(
      'FAITHFUL: round trip holds (fidelity ' +
        round(fidelity) +
        '), unsupported ratio ' +
        round(unsupportedRatio) +
        '.'
    )
  }

  return {
    ok: true,
    engine: ENGINE_VERSION,
    fidelity: round(fidelity),
    novelty: round(novelty),
    unsupported,
    unsupported_ratio: round(unsupportedRatio),
    degraded,
    units,
    verdict,
    directives,
    params: { tauSupport: P.tauSupport },
  }
}

/** Compact model-facing text for `xefg_frame`. */
export function renderFrameReport(r) {
  if (!r.ok) return 'xefg_frame: ' + r.reason
  const L = []
  L.push(
    'XeFG frames — ' +
      r.summary.frames +
      ' frames, ' +
      r.summary.units +
      ' units, holes ' +
      r.summary.holes +
      ' (' +
      r.summary.hole_ratio +
      '), stability ' +
      r.summary.stability
  )
  for (const f of r.frames) {
    L.push('')
    L.push(
      '[' +
        f.id +
        '] ' +
        f.verdict +
        '  holes ' +
        f.holes +
        '/' +
        f.units_count +
        '  gain ' +
        f.gain +
        '  redundant ' +
        f.redundant +
        '  weak ' +
        f.weak +
        '  assumed ' +
        f.assumed +
        '  flow ' +
        f.mean_flow_cos
    )
    for (const u of f.units) {
      const tag = u.lambda ? 'HOLE(' + u.why + ')' : u.weak ? 'WEAK-MV' : 'ok(' + u.why + ')'
      const ev = u.evidence === 'binary' ? 'B' : u.evidence === 'service' ? 'S' : 'A'
      L.push(
        '  - ' +
          u.key +
          ' [' +
          ev +
          '] ' +
          tag +
          ' cos=' +
          u.cos +
          ' rt=' +
          u.rt +
          ' anchor=' +
          u.anchor +
          ' blend=' +
          u.blend +
          ' gain=' +
          u.gain
      )
      L.push('    ' + u.text)
    }
  }
  L.push('')
  L.push('directives:')
  for (const d of r.directives) L.push('  * ' + d)
  return L.join('\n')
}

/** Compact model-facing text for `xefg_verify`. */
export function renderVerifyReport(r) {
  if (!r.ok) return 'xefg_verify: ' + r.reason
  const L = []
  L.push(
    'XeFG round-trip — verdict ' +
      r.verdict +
      '  fidelity ' +
      r.fidelity +
      '  unsupported ' +
      r.unsupported +
      '/' +
      r.units.length +
      '  novelty ' +
      r.novelty
  )
  for (const u of r.units) {
    L.push('  - ' + (u.unsupported ? 'UNSUPPORTED' : 'supported') + ' (' + u.where + ', ' + u.support + ') ' + u.text)
  }
  L.push('degraded(expansion) => ' + r.degraded)
  for (const d of r.directives) L.push('* ' + d)
  return L.join('\n')
}
