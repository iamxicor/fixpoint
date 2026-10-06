import type { CallFrame, CpuProfile, CpuProfileNode, TraceEvent } from '@fixpoint/devtools';

export interface SampleTimeline {
  nodes: Map<number, CpuProfileNode>;
  /** Node id per sample. */
  samples: number[];
  /** Absolute timestamp (trace µs) per sample. */
  times: number[];
  /** Duration attributed to each sample in µs (the delta to the next sample). */
  durations: number[];
  startTime: number;
  endTime: number;
}

const IDLE_NAMES = new Set(['(root)', '(program)', '(idle)', '(garbage collector)', '[root]', '[program]', '[idle]']);

/** Merges `Profile` + `ProfileChunk` trace events into one sample timeline. */
export function samplesFromTrace(events: TraceEvent[]): SampleTimeline | null {
  const profile = events.find((e) => e.name === 'Profile');
  const chunks = events.filter((e) => e.name === 'ProfileChunk').sort((a, b) => a.ts - b.ts);
  if (!profile || chunks.length === 0) return null;
  const nodes = new Map<number, CpuProfileNode>();
  const samples: number[] = [];
  const deltas: number[] = [];
  for (const c of chunks) {
    const cp = c.args?.data?.cpuProfile;
    for (const n of cp?.nodes ?? []) nodes.set(n.id, n);
    for (const s of cp?.samples ?? []) samples.push(s);
    for (const d of c.args?.data?.timeDeltas ?? []) deltas.push(d);
  }
  const startTime: number = profile.args?.data?.startTime ?? profile.ts;
  return finish(nodes, samples, deltas, startTime);
}

export function samplesFromProfile(profile: CpuProfile): SampleTimeline {
  const nodes = new Map<number, CpuProfileNode>();
  for (const n of profile.nodes) nodes.set(n.id, n);
  return finish(nodes, profile.samples, profile.timeDeltas, profile.startTime);
}

function finish(nodes: Map<number, CpuProfileNode>, samples: number[], deltas: number[], startTime: number): SampleTimeline {
  // Fill parent links when only `children` is present (Profiler.stop output).
  for (const n of nodes.values()) for (const c of n.children ?? []) { const child = nodes.get(c); if (child && child.parent == null) child.parent = n.id; }
  const times: number[] = new Array(samples.length);
  let t = startTime;
  for (let i = 0; i < samples.length; i++) {
    t += deltas[i] ?? 0;
    times[i] = t;
  }
  const durations: number[] = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) durations[i] = i + 1 < samples.length ? times[i + 1]! - times[i]! : deltas[i] ?? 0;
  return { nodes, samples, times, durations, startTime, endTime: t };
}

export function isIdleNode(node: CpuProfileNode | undefined): boolean {
  if (!node) return true;
  const name = node.callFrame.functionName;
  return IDLE_NAMES.has(name) && !node.callFrame.url;
}

export interface BusyRun {
  startUs: number;
  endUs: number;
  durationMs: number;
  sampleStart: number;
  sampleEnd: number;
}

/**
 * Groups consecutive non-idle samples into runs of JavaScript work. A gap of more than `gapMs`
 * between samples or an idle sample ends a run. This is the fallback when the event loop does not
 * emit `RunTask` events (verified absent on Expo SDK 56 / RN 0.85).
 */
export function busyRuns(tl: SampleTimeline, gapMs = 2): BusyRun[] {
  const runs: BusyRun[] = [];
  let cur: BusyRun | null = null;
  for (let i = 0; i < tl.samples.length; i++) {
    const node = tl.nodes.get(tl.samples[i]!);
    const t = tl.times[i]!;
    const idle = isIdleNode(node);
    if (idle) {
      if (cur) runs.push(cur), (cur = null);
      continue;
    }
    if (cur && t - tl.times[cur.sampleEnd]! > gapMs * 1000) runs.push(cur), (cur = null);
    if (!cur) cur = { startUs: t, endUs: t + tl.durations[i]!, durationMs: 0, sampleStart: i, sampleEnd: i };
    cur.sampleEnd = i;
    cur.endUs = t + tl.durations[i]!;
  }
  if (cur) runs.push(cur);
  for (const r of runs) r.durationMs = (r.endUs - r.startUs) / 1000;
  return runs;
}

export interface FrameSelf {
  frame: CallFrame;
  selfUs: number;
  samples: number;
}

/** Self time per leaf frame for samples in [startUs, endUs). */
export function selfTimeByFrame(tl: SampleTimeline, startUs: number, endUs: number, limit = 10): FrameSelf[] {
  const acc = new Map<number, FrameSelf>();
  for (let i = 0; i < tl.samples.length; i++) {
    const t = tl.times[i]!;
    if (t < startUs || t >= endUs) continue;
    const id = tl.samples[i]!;
    const node = tl.nodes.get(id);
    if (!node || isIdleNode(node)) continue;
    let e = acc.get(id);
    if (!e) acc.set(id, (e = { frame: node.callFrame, selfUs: 0, samples: 0 }));
    e.selfUs += tl.durations[i]!;
    e.samples++;
  }
  return [...acc.values()].sort((a, b) => b.selfUs - a.selfUs).slice(0, limit);
}

/** Total non-idle sample time in µs within a window (or the whole timeline). */
export function busyUs(tl: SampleTimeline, startUs = -Infinity, endUs = Infinity): number {
  let total = 0;
  for (let i = 0; i < tl.samples.length; i++) {
    const t = tl.times[i]!;
    if (t < startUs || t >= endUs) continue;
    if (!isIdleNode(tl.nodes.get(tl.samples[i]!))) total += tl.durations[i]!;
  }
  return total;
}

/** Walks up to find the nearest frame whose URL is a bundle (skips native stubs). */
export function stackOf(tl: SampleTimeline, nodeId: number, max = 12): CallFrame[] {
  const out: CallFrame[] = [];
  let node = tl.nodes.get(nodeId);
  while (node && out.length < max) {
    if (!isIdleNode(node)) out.push(node.callFrame);
    node = node.parent != null ? tl.nodes.get(node.parent) : undefined;
  }
  return out;
}
