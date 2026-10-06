import type { Finding } from '@fixpoint/analyzer';
import type { GatesReport } from './gates.js';
import { fmtDelta, fmtPct, type Verdict } from './verdict.js';

export interface PrInput {
  route: string;
  finding: Finding;
  recipeId: string;
  verdict: Verdict;
  gates: GatesReport;
  videoUrl?: string | null;
  traceArtifacts?: string[];
  branch?: string;
  fixDescription: string;
}

const LABEL = 'dev build, iOS Simulator';

export function prTitle(input: PrInput): string {
  const det = input.verdict.deterministicDeltas.find((d) => d.metric === 'componentRenders');
  const delta = det ? ` (${fmtDelta(det.medianDelta)} renders per visit)` : '';
  return `perf(${input.route.replace(/^\//, '') || 'index'}): ${input.finding.kind} — ${input.recipeId}${delta}`;
}

export function prBody(input: PrInput): string {
  const v = input.verdict;
  const f = input.finding;
  const rows = v.deterministicDeltas.map((d) => `| ${d.metric} | ${median(d.base)} | ${median(d.candidate)} | ${fmtDelta(d.medianDelta)} | ${d.unanimous}${d.exact ? ', identical in every pair' : ''} |`).join('\n');
  const t = v.timeDelta;
  const gates = input.gates.gates.map((g) => `- [${g.ok ? 'x' : ' '}] ${g.name}${g.skipped ? ` (skipped: ${g.skipped})` : ''}${g.name === 'pixel-diff' ? ` — ${g.output}` : ''}`).join('\n');
  const evidence = f.evidence.components
    .slice(0, 5)
    .map((c) => `- ${c.name}: ${c.renders} renders${c.wasted ? `, ${c.wasted} avoidable` : ''}${c.selfMs ? `, ${c.selfMs} ms self` : ''}`)
    .join('\n');
  const frames = f.evidence.frames
    .slice(0, 5)
    .map((fr) => `- ${fr.symbol}${fr.file ? ` (${fr.file}${fr.line ? `:${fr.line}` : ''})` : ''}: ${fr.selfMs} ms self`)
    .join('\n');
  return `## Screen

\`${input.route}\` — scenario: ${v.scenario}

## Finding

**${f.kind}** (${f.severity}) at \`${f.location.symbol}\`${f.location.file ? ` in \`${f.location.file}${f.location.line ? `:${f.location.line}` : ''}\`` : ''}

${f.summary}

Primary metric: \`${f.metric.name}\` = ${f.metric.value} ${f.metric.unit}${f.metric.deterministic ? ' (deterministic)' : ' (time-based)'}
${evidence ? `\nComponents:\n${evidence}` : ''}${frames ? `\nHot frames:\n${frames}` : ''}

## Fix

Recipe \`${input.recipeId}\` (see docs/FIX-RECIPES.md). ${input.fixDescription}

## Deterministic deltas (${LABEL}, ${v.pairs} interleaved pairs, second visit measured)

| metric | base (median) | candidate (median) | Δ | pairs |
|---|---|---|---|---|
${rows}

## Time delta (${LABEL})

renderMs: median ${fmtPct(t.relativeMedian)}, 95% CI ${fmtPct(t.relativeCi95.lower)} … ${fmtPct(t.relativeCi95.upper)}, p = ${t.p.toFixed(3)} (Wilcoxon signed-rank, bootstrap CI). Noise floor from A/A: ${fmtPct(v.noiseFloor.time)} over ${v.noiseFloor.pairs} pairs. Control frames: ${v.controlFramesOk ? 'flat' : 'drifted'}${v.controlFrames ? ` (${(v.controlFrames.drift * 100).toFixed(1)}% over ${v.controlFrames.compared} untouched functions)` : ''}.

Verdict: **${v.verdict}** — ${v.reasons.join('; ')}

## Gates

${gates}

## Artifacts

${input.videoUrl ? `- Side-by-side video: ${input.videoUrl}\n` : v.artifacts.video ? `- Side-by-side video: \`${v.artifacts.video}\` (attached)\n` : '- No video recorded for this run\n'}${(input.traceArtifacts ?? v.artifacts.traces).map((tr) => `- Trace: \`${tr}\``).join('\n')}
- Verdict JSON: \`${v.artifacts.dir}/verdict.json\`

Every number above: ${LABEL}. Measured by Fixpoint; opened as a draft for human review.

🧙 Built with [WOZCODE](https://wozcode.com)
`;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
