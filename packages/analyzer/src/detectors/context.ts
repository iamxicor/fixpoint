import { createHash } from 'node:crypto';
import type { CallFrame, SymbolicatedFrame } from '@fixpoint/devtools';
import type { TraceModel } from '../trace/model.js';
import type { AnalyzeInput, Finding, FindingKind, FrameEvidence, Location, Severity, Thresholds } from '../types.js';
import { selfTimeByFrame, stackOf, type SampleTimeline } from '../trace/profile.js';

export interface DetectorContext {
  model: TraceModel | null;
  isAppComponent: (name: string) => boolean;
  /** Memoised symbolication keyed by generated position. */
  symbolicateCached: (frames: CallFrame[]) => Promise<SymbolicatedFrame[]>;
  input: AnalyzeInput;
  thresholds: Thresholds;
  notes: string[];
  locate: (componentName: string) => Location;
  symbolicate: (frames: CallFrame[]) => Promise<SymbolicatedFrame[]>;
  isAppFile: (file: string | null) => boolean;
}

export type Detector = (ctx: DetectorContext) => Promise<Finding[]>;

export function findingId(kind: FindingKind, ...parts: (string | number | null | undefined)[]): string {
  const key = parts.filter((p) => p !== null && p !== undefined).join('|');
  const hash = createHash('sha1').update(`${kind}|${key}`).digest('hex').slice(0, 8);
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${kind}:${slug || 'x'}:${hash}`;
}

export function severityFor(value: number, low: number, medium: number, high: number): Severity | null {
  if (value >= high) return 'high';
  if (value >= medium) return 'medium';
  if (value >= low) return 'low';
  return null;
}

const SEVERITY_WEIGHT: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export function scoreFor(severity: Severity, value: number, deterministic: boolean): number {
  const base = SEVERITY_WEIGHT[severity] * 100;
  const impact = Math.log10(Math.max(1, value) + 1) * 10;
  return Math.round((base + impact + (deterministic ? 5 : 0)) * 100) / 100;
}

/** Expo Router names route components `Name(./(group)/route.tsx)`; the path is relative to `app/`. */
export function routeFileFromName(name: string): string | null {
  const m = /\((\.\/.+)\)\s*$/.exec(name);
  return m ? `app/${m[1]!.slice(2)}` : null;
}

export function displayName(name: string): string {
  return name.replace(/\(\.\/.+\)\s*$/, '');
}

/** App-owned component: an Expo Router route component or one the harness located in the app source. */
export function makeIsAppComponent(input: AnalyzeInput): (name: string) => boolean {
  return (name) => routeFileFromName(name) !== null || !!input.componentLocations?.[displayName(name)];
}

export function makeLocate(input: AnalyzeInput): (name: string) => Location {
  return (name) => {
    const bare = displayName(name);
    const fromRoute = routeFileFromName(name);
    const known = input.componentLocations?.[bare] ?? input.componentLocations?.[name];
    if (known) return { ...known, symbol: known.symbol || bare };
    return { file: fromRoute, line: null, column: null, symbol: bare };
  };
}

export function makeIsAppFile(appRoot?: string): (file: string | null) => boolean {
  return (file) => {
    if (!file) return false;
    if (file.includes('node_modules/')) return false;
    if (appRoot && file.startsWith('/') && !file.startsWith(appRoot)) return false;
    return true;
  };
}

export async function topFrames(ctx: DetectorContext, tl: SampleTimeline, windows: { startUs: number; endUs: number }[], limit = 8): Promise<FrameEvidence[]> {
  const acc = new Map<string, { frame: CallFrame; selfUs: number; samples: number }>();
  for (const w of windows) {
    for (const f of selfTimeByFrame(tl, w.startUs, w.endUs, 50)) {
      const key = `${f.frame.url}:${f.frame.lineNumber}:${f.frame.columnNumber}`;
      const e = acc.get(key);
      if (e) {
        e.selfUs += f.selfUs;
        e.samples += f.samples;
      } else acc.set(key, { ...f });
    }
  }
  const top = [...acc.values()].sort((a, b) => b.selfUs - a.selfUs).slice(0, limit);
  const sym = await ctx.symbolicateCached(top.map((t) => t.frame));
  return top.map((t, i) => {
    const s = sym[i];
    return {
      symbol: s?.symbol ?? t.frame.functionName ?? '(anonymous)',
      file: s?.file ?? null,
      line: s?.line ?? null,
      column: s?.column ?? null,
      selfMs: round(t.selfUs / 1000),
      samples: t.samples,
      generated: { url: t.frame.url, line: t.frame.lineNumber, column: t.frame.columnNumber },
    };
  });
}

export function firstAppFrameLocation(ctx: DetectorContext, frames: FrameEvidence[], fallback: Location): Location {
  const app = frames.find((f) => ctx.isAppFile(f.file));
  if (app) return { file: app.file, line: app.line, column: app.column, symbol: app.symbol };
  return fallback;
}

export function round(n: number, digits = 2): number {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function makeCachedSymbolicator(symbolicate: (frames: CallFrame[]) => Promise<SymbolicatedFrame[]>): (frames: CallFrame[]) => Promise<SymbolicatedFrame[]> {
  const cache = new Map<string, SymbolicatedFrame>();
  const key = (f: CallFrame) => `${f.url}|${f.lineNumber}|${f.columnNumber}|${f.functionName}`;
  return async (frames) => {
    const missing = frames.filter((f) => !cache.has(key(f)));
    const unique = [...new Map(missing.map((f) => [key(f), f])).values()];
    if (unique.length) {
      const res = await symbolicate(unique);
      unique.forEach((f, i) => cache.set(key(f), res[i]!));
    }
    return frames.map((f) => cache.get(key(f))!);
  };
}

/**
 * Attributes sample time to the nearest app-code frame on each sample's stack (inclusive time),
 * so a long task inside a library call still points at the app code that called it.
 */
export async function topAppFrames(ctx: DetectorContext, tl: SampleTimeline, windows: { startUs: number; endUs: number }[], limit = 5): Promise<FrameEvidence[]> {
  const stacks = new Map<number, CallFrame[]>();
  const candidates = new Map<string, CallFrame>();
  const fkey = (f: CallFrame) => `${f.url}|${f.lineNumber}|${f.columnNumber}`;
  const perSample: { stack: CallFrame[]; us: number }[] = [];
  for (const w of windows) {
    for (let i = 0; i < tl.samples.length; i++) {
      const t = tl.times[i]!;
      if (t < w.startUs || t >= w.endUs) continue;
      const id = tl.samples[i]!;
      let st = stacks.get(id);
      if (!st) stacks.set(id, (st = stackOf(tl, id, 16).filter((f) => /\.bundle/.test(f.url))));
      if (st.length === 0) continue;
      for (const f of st) candidates.set(fkey(f), f);
      perSample.push({ stack: st, us: tl.durations[i]! });
    }
  }
  const list = [...candidates.values()];
  const sym = await ctx.symbolicateCached(list);
  const symByKey = new Map(list.map((f, i) => [fkey(f), sym[i]!]));
  const acc = new Map<string, { s: SymbolicatedFrame; us: number; samples: number }>();
  for (const { stack, us } of perSample) {
    const app = stack.find((f) => ctx.isAppFile(symByKey.get(fkey(f))?.file ?? null));
    if (!app) continue;
    const s = symByKey.get(fkey(app))!;
    const k = `${s.file}:${s.line}:${s.symbol}`;
    const e = acc.get(k);
    if (e) {
      e.us += us;
      e.samples++;
    } else acc.set(k, { s, us, samples: 1 });
  }
  return [...acc.values()]
    .sort((a, b) => b.us - a.us)
    .slice(0, limit)
    .map(({ s, us, samples }) => ({ symbol: s.symbol, file: s.file, line: s.line, column: s.column, selfMs: round(us / 1000), samples, generated: s.generated }));
}
