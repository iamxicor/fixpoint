import type { BootstrapCI } from './stats.js';
import { noiseFloor as computeNoiseFloor, summarizePairs, type PairedSummary } from './stats.js';
import { DETERMINISTIC_METRICS, type DeterministicMetric, type VisitMetrics } from './metrics.js';

export interface DeterministicDelta {
  metric: DeterministicMetric;
  base: number[];
  candidate: number[];
  medianDelta: number;
  /** Every pair moved the same way (strictly). */
  unanimous: PairedSummary['unanimous'];
  /** Candidate − base was identical in every pair. */
  exact: boolean;
}

export interface TimeDelta {
  metric: 'renderMs';
  base: number[];
  candidate: number[];
  /** Median of candidate − base in ms. */
  median: number;
  /** Median of (candidate − base) / base; negative is faster. */
  relativeMedian: number;
  ci95: BootstrapCI;
  /** Bootstrap CI of the relative difference, centred on 0. */
  relativeCi95: BootstrapCI;
  p: number;
}

export interface NoiseFloor {
  /** 95th percentile of |relative A/A pair difference| of renderMs. */
  time: number;
  /** 95th percentile of |absolute A/A pair difference| per deterministic metric (expected 0). */
  counts: Record<DeterministicMetric, number>;
  pairs: number;
  source: string;
}

export interface ControlFrames {
  ok: boolean;
  /** Relative drift of total self time over frames in files the diff did not touch. */
  drift: number;
  maxAllowed: number;
  compared: number;
  topMovers: { symbol: string; file: string | null; baseMs: number; candidateMs: number }[];
  attempts: number;
}

export interface PairRecord {
  index: number;
  discarded: boolean;
  mode: 'full' | 'light';
  order: ['A', 'B'] | ['B', 'A'];
  base: VisitMetrics;
  candidate: VisitMetrics;
  traces: { base: string; candidate: string };
  appPids: { base: number | null; candidate: number | null };
}

export type VerdictValue = 'accept' | 'reject' | 'inconclusive';

export interface Verdict {
  version: 1;
  mode: 'ab' | 'aa';
  route: string;
  scenario: string;
  generatedAt: string;
  label: 'dev build, iOS Simulator';
  base: { ref: string; sha: string; metro: string };
  candidate: { ref: string; sha: string; metro: string };
  deterministicDeltas: DeterministicDelta[];
  timeDelta: TimeDelta;
  noiseFloor: NoiseFloor;
  controlFramesOk: boolean;
  controlFrames: ControlFrames | null;
  pairs: number;
  pairsDetail: PairRecord[];
  pixelDiff: { ratio: number; ok: boolean; maxRatio: number; diffFile: string | null } | null;
  verdict: VerdictValue;
  reasons: string[];
  /** A/A only: true when base-vs-base produced a significant difference, meaning the harness, not the app, failed. */
  harnessFailed?: boolean;
  artifacts: { traces: string[]; video: string | null; screenshots: string[]; dir: string };
  environment: { device: string; replayMode: string; foreignEvents: string[] };
}

export interface DecisionInput {
  mode: 'ab' | 'aa';
  pairs: PairRecord[];
  noiseFloor: NoiseFloor;
  controlFrames: ControlFrames | null;
  thresholds: { minEffect: number; alpha: number };
}

export function deterministicDeltas(pairs: PairRecord[]): DeterministicDelta[] {
  const kept = pairs.filter((p) => !p.discarded);
  return DETERMINISTIC_METRICS.map((metric) => {
    const base = kept.map((p) => p.base[metric]);
    const candidate = kept.map((p) => p.candidate[metric]);
    const s = summarizePairs(base, candidate);
    const diffs = s.diffs;
    return { metric, base, candidate, medianDelta: s.median, unanimous: s.unanimous, exact: diffs.every((d) => d === diffs[0]) };
  });
}

export function timeDelta(pairs: PairRecord[]): TimeDelta {
  const kept = pairs.filter((p) => !p.discarded);
  const base = kept.map((p) => p.base.renderMs);
  const candidate = kept.map((p) => p.candidate.renderMs);
  const s = summarizePairs(base, candidate);
  const rel = summarizePairs(
    base.map(() => 1),
    base.map((b, i) => (b ? candidate[i]! / b : 1)),
  );
  return { metric: 'renderMs', base, candidate, median: s.median, relativeMedian: s.relativeMedian ?? 0, ci95: s.ci95, relativeCi95: rel.ci95, p: s.p };
}

export function noiseFloorFromAA(pairs: PairRecord[], source: string): NoiseFloor {
  const kept = pairs.filter((p) => !p.discarded);
  const counts = {} as Record<DeterministicMetric, number>;
  for (const m of DETERMINISTIC_METRICS) counts[m] = computeNoiseFloor(kept.map((p) => p.base[m]), kept.map((p) => p.candidate[m]), false);
  return { time: computeNoiseFloor(kept.map((p) => p.base.renderMs), kept.map((p) => p.candidate.renderMs), true), counts, pairs: kept.length, source };
}

export function decide(input: DecisionInput): { verdict: VerdictValue; reasons: string[]; harnessFailed?: boolean } {
  const reasons: string[] = [];
  const det = deterministicDeltas(input.pairs);
  const time = timeDelta(input.pairs);
  const nf = input.noiseFloor;
  const minEffect = Math.max(input.thresholds.minEffect, Number.isFinite(nf.time) ? nf.time : 0);
  const kept = input.pairs.filter((p) => !p.discarded).length;
  if (kept < 3) {
    reasons.push(`only ${kept} usable pairs`);
    return { verdict: 'inconclusive', reasons };
  }
  const regressed = det.filter((d) => d.unanimous === 'regressed' || (d.unanimous === 'mixed' && d.medianDelta > (nf.counts[d.metric] ?? 0)));
  const improved = det.filter((d) => d.unanimous === 'improved' && (d.metric === 'componentRenders' || d.metric === 'avoidableRenders'));
  // relativeMedian and relativeCi95 are (candidate − base) / base, centred on 0
  const timeImproved = time.relativeCi95.upper < 0 && -time.relativeMedian >= minEffect && time.p < input.thresholds.alpha;
  const timeRegressed = time.relativeCi95.lower > 0 && time.relativeMedian >= minEffect;
  if (input.mode === 'aa') {
    const harnessFailed = timeImproved || timeRegressed || det.some((d) => d.unanimous === 'improved' || d.unanimous === 'regressed');
    reasons.push(harnessFailed ? 'A/A produced a significant difference between identical builds; the harness or the environment is not stable' : 'A/A is flat; noise floor recorded');
    return { verdict: harnessFailed ? 'reject' : 'accept', reasons, harnessFailed };
  }
  if (input.controlFrames && !input.controlFrames.ok) {
    reasons.push(`control frames drifted ${(input.controlFrames.drift * 100).toFixed(1)}% (max ${(input.controlFrames.maxAllowed * 100).toFixed(0)}%)`);
    return { verdict: 'inconclusive', reasons };
  }
  if (regressed.length) {
    reasons.push(`deterministic regression: ${regressed.map((d) => `${d.metric} ${fmtDelta(d.medianDelta)}`).join(', ')}`);
    return { verdict: 'reject', reasons };
  }
  if (timeRegressed) {
    reasons.push(`time regression: renderMs ${fmtPct(time.relativeMedian)} (95% CI ${fmtPct(time.relativeCi95.lower)} … ${fmtPct(time.relativeCi95.upper)})`);
    return { verdict: 'reject', reasons };
  }
  if (improved.length) {
    reasons.push(`deterministic improvement: ${improved.map((d) => `${d.metric} ${fmtDelta(d.medianDelta)}${d.exact ? ' (identical in every pair)' : ''}`).join(', ')}`);
    reasons.push(timeImproved ? `time improved: renderMs ${fmtPct(time.relativeMedian)} (p=${time.p.toFixed(3)})` : `time not significantly changed (median ${fmtPct(time.relativeMedian)}, noise floor ${fmtPct(nf.time)})`);
    return { verdict: 'accept', reasons };
  }
  if (timeImproved) {
    reasons.push(`time improved: renderMs ${fmtPct(time.relativeMedian)} (95% CI ${fmtPct(time.relativeCi95.lower)} … ${fmtPct(time.relativeCi95.upper)}, p=${time.p.toFixed(3)}) with counts unchanged`);
    return { verdict: 'accept', reasons };
  }
  reasons.push(`no deterministic change and time within the noise floor (median ${fmtPct(time.relativeMedian)}, floor ${fmtPct(nf.time)})`);
  return { verdict: 'inconclusive', reasons };
}

export const fmtDelta = (d: number) => (d > 0 ? `+${d}` : String(d));
export const fmtPct = (f: number) => `${f > 0 ? '+' : ''}${(f * 100).toFixed(1)}%`;
