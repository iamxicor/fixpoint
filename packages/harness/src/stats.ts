/**
 * Paired statistics for interleaved A/B runs. Small n (6–12 pairs) is the normal case, so the
 * Wilcoxon signed-rank test uses the exact permutation distribution and the confidence interval
 * comes from a bootstrap of the paired differences.
 */

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

/** Deterministic PRNG (mulberry32) so bootstrap results are reproducible. */
export function rng(seed = 0x5eed): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapCI {
  lower: number;
  upper: number;
  level: number;
  resamples: number;
}

/** Percentile bootstrap CI of the median of `diffs`. */
export function bootstrapMedianCI(diffs: number[], level = 0.95, resamples = 4000, seed = 0x5eed): BootstrapCI {
  const n = diffs.length;
  if (n === 0) return { lower: NaN, upper: NaN, level, resamples };
  const rand = rng(seed);
  const meds: number[] = new Array(resamples);
  const sample: number[] = new Array(n);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) sample[i] = diffs[Math.floor(rand() * n)]!;
    meds[r] = median(sample);
  }
  const alpha = (1 - level) / 2;
  return { lower: percentile(meds, alpha), upper: percentile(meds, 1 - alpha), level, resamples };
}

export interface WilcoxonResult {
  n: number;
  /** Sum of positive ranks. */
  wPlus: number;
  /** Exact two-sided p-value for n ≤ 20, normal approximation above. */
  p: number;
  method: 'exact' | 'normal';
}

/** Two-sided Wilcoxon signed-rank test on paired differences (zeros dropped, average ranks for ties). */
export function wilcoxonSignedRank(diffs: number[]): WilcoxonResult {
  const d = diffs.filter((x) => x !== 0);
  const n = d.length;
  if (n === 0) return { n: 0, wPlus: 0, p: 1, method: 'exact' };
  const abs = d.map((x, i) => ({ v: Math.abs(x), i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(n);
  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && abs[j + 1]!.v === abs[k]!.v) j++;
    const avg = (k + 1 + (j + 1)) / 2;
    for (let m = k; m <= j; m++) ranks[abs[m]!.i] = avg;
    k = j + 1;
  }
  let wPlus = 0;
  for (let i = 0; i < n; i++) if (d[i]! > 0) wPlus += ranks[i]!;
  if (n <= 20) {
    // exact distribution over all 2^n sign assignments (ties handled by using the actual rank values)
    const total = 1 << n;
    const stat = Math.round(wPlus * 2); // ranks may be .5 with ties; scale by 2
    const rk = ranks.map((r) => Math.round(r * 2));
    const maxW = rk.reduce((a, b) => a + b, 0);
    const counts = new Array<number>(maxW + 1).fill(0);
    counts[0] = 1;
    for (const r of rk) for (let w = maxW; w >= r; w--) counts[w]! += counts[w - r]!;
    const lowerOrEq = counts.slice(0, Math.min(stat, maxW - stat) + 1).reduce((a, b) => a + b, 0);
    const p = Math.min(1, (2 * lowerOrEq) / total);
    return { n, wPlus, p, method: 'exact' };
  }
  const mean = (n * (n + 1)) / 4;
  const sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = (wPlus - mean) / sd;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { n, wPlus, p, method: 'normal' };
}

function normalCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - p;
}

export interface PairedSummary {
  n: number;
  diffs: number[];
  median: number;
  /** Median relative change (candidate − base) / base, when `relative` requested. */
  relativeMedian: number | null;
  ci95: BootstrapCI;
  p: number;
  /** All pairs agree in sign (strictly), which is what a deterministic metric must show. */
  unanimous: 'improved' | 'regressed' | 'unchanged' | 'mixed';
}

export function summarizePairs(base: number[], candidate: number[], opts: { seed?: number } = {}): PairedSummary {
  const n = Math.min(base.length, candidate.length);
  const diffs = Array.from({ length: n }, (_, i) => candidate[i]! - base[i]!);
  const rel = Array.from({ length: n }, (_, i) => (base[i] ? (candidate[i]! - base[i]!) / base[i]! : 0));
  const sign = diffs.map((d) => Math.sign(d));
  const unanimous: PairedSummary['unanimous'] = n === 0 ? 'unchanged' : sign.every((s) => s < 0) ? 'improved' : sign.every((s) => s > 0) ? 'regressed' : sign.every((s) => s === 0) ? 'unchanged' : 'mixed';
  return { n, diffs, median: median(diffs), relativeMedian: n ? median(rel) : null, ci95: bootstrapMedianCI(diffs, 0.95, 4000, opts.seed), p: wilcoxonSignedRank(diffs).p, unanimous };
}

/** Noise floor from an A/A run: the 95th percentile of |relative pair differences| (time) or |absolute| (counts). */
export function noiseFloor(base: number[], same: number[], relative: boolean): number {
  const n = Math.min(base.length, same.length);
  const xs = Array.from({ length: n }, (_, i) => (relative ? (base[i] ? Math.abs(same[i]! - base[i]!) / base[i]! : 0) : Math.abs(same[i]! - base[i]!)));
  return n ? percentile(xs, 0.95) : NaN;
}
