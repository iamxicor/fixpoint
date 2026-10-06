import type { CallFrame, TraceEvent, TraceFile } from '@fixpoint/devtools';
import { parsePropsDiff, type PropsDiff } from './props-diff.js';
import { samplesFromTrace, type SampleTimeline } from './profile.js';
import type { ScenarioWindow } from '../types.js';

export const COMPONENTS_TRACK = 'Components ⚛';
export const SCHEDULER_GROUP = 'Scheduler ⚛';
const ZWSP = '​';

export interface ComponentRender {
  name: string;
  /** Trace µs. */
  startUs: number;
  endUs: number;
  /** Self time after subtracting nested renders, µs. */
  selfUs: number;
  color: string | null;
  /** 'render' entries come from console.timeStamp; 'changed-props' from performance.measure with a diff; 'effect' are secondary colours. */
  kind: 'render' | 'changed-props' | 'effect' | 'trigger' | 'error';
  diff: PropsDiff | null;
  tooltip: string | null;
  commit: number;
  parent: number | null;
  index: number;
}

export interface UpdateEvent {
  startUs: number;
  endUs: number;
  component: string | null;
  method: string | null;
  track: string | null;
  cascading: boolean;
  blocked: boolean;
  stack: CallFrame[];
}

export interface Commit {
  index: number;
  track: string | null;
  renderStartUs: number;
  renderEndUs: number;
  commitStartUs: number;
  commitEndUs: number;
  effectsEndUs: number | null;
  components: ComponentRender[];
  root: ComponentRender | null;
  triggers: UpdateEvent[];
}

export interface TraceModel {
  startUs: number;
  endUs: number;
  durationMs: number;
  commits: Commit[];
  renders: ComponentRender[];
  updates: UpdateEvent[];
  samples: SampleTimeline | null;
  /** `RunTask` events when the event loop emits them. */
  tasks: { startUs: number; endUs: number }[];
  frames: { startUs: number; endUs: number }[];
  windows: ScenarioWindow[];
  /** Converts trace µs to ms since trace start. */
  ms: (us: number) => number;
}

interface TrackEntry {
  name: string;
  track: string | null;
  trackGroup: string | null;
  color: string | null;
  startUs: number;
  endUs: number;
  stack: CallFrame[];
}

function timeStampEntries(events: TraceEvent[]): TrackEntry[] {
  const out: TrackEntry[] = [];
  for (const e of events) {
    if (e.name !== 'TimeStamp') continue;
    const d = e.args?.data ?? {};
    if (typeof d.start !== 'number' || typeof d.end !== 'number') continue;
    out.push({ name: String(d.name ?? d.message ?? ''), track: d.track ?? null, trackGroup: d.trackGroup ?? null, color: d.color ?? null, startUs: d.start, endUs: d.end, stack: d.rnStackTrace?.callFrames ?? [] });
  }
  return out;
}

interface Measure {
  name: string;
  startUs: number;
  endUs: number;
  detail: any;
  stack: CallFrame[];
}

function measures(events: TraceEvent[]): Measure[] {
  const begins = new Map<string, TraceEvent>();
  const out: Measure[] = [];
  for (const e of events) {
    if (e.cat !== 'blink.user_timing') continue;
    const key = `${e.id}:${e.name}`;
    if (e.ph === 'b') begins.set(key, e);
    else if (e.ph === 'e') {
      const b = begins.get(key);
      if (!b) continue;
      begins.delete(key);
      let detail: any = null;
      const raw = b.args?.detail;
      if (typeof raw === 'string') {
        try {
          detail = JSON.parse(raw);
        } catch {
          detail = null;
        }
      } else if (raw && typeof raw === 'object') detail = raw;
      out.push({ name: e.name, startUs: b.ts, endUs: e.ts, detail, stack: b.args?.data?.rnStackTrace?.callFrames ?? [] });
    }
  }
  return out;
}

const isEffectColor = (c: string | null) => !!c && c.startsWith('secondary');

export function buildModel(trace: TraceFile): TraceModel {
  const events = trace.traceEvents;
  const tsValues = events.map((e) => e.ts).filter((t) => typeof t === 'number' && t > 0);
  const startUs = Math.min(...tsValues);
  const endUs = Math.max(...tsValues, ...events.filter((e) => e.name === 'TimeStamp').map((e) => e.args?.data?.end ?? 0));
  const ms = (us: number) => (us - startUs) / 1000;

  const stamps = timeStampEntries(events);
  const ms_ = measures(events);

  // ---- component renders from both sources
  const renders: ComponentRender[] = [];
  for (const s of stamps) {
    if (s.track !== COMPONENTS_TRACK || s.name === 'ReactNative-ComponentsTrack') continue;
    renders.push({ name: s.name, startUs: s.startUs, endUs: s.endUs, selfUs: 0, color: s.color, kind: isEffectColor(s.color) ? 'effect' : 'render', diff: null, tooltip: null, commit: -1, parent: null, index: 0 });
  }
  for (const m of ms_) {
    const dt = m.detail?.devtools;
    if (!dt || dt.track !== COMPONENTS_TRACK) continue;
    const name = m.name.startsWith(ZWSP) ? m.name.slice(1) : m.name;
    const diff = parsePropsDiff(dt.properties);
    const kind: ComponentRender['kind'] = diff ? 'changed-props' : /error/i.test(String(dt.tooltipText ?? '')) ? 'error' : dt.color === 'warning' ? 'trigger' : isEffectColor(dt.color) ? 'effect' : 'render';
    renders.push({ name, startUs: m.startUs, endUs: m.endUs, selfUs: 0, color: dt.color ?? null, kind, diff, tooltip: dt.tooltipText ?? null, commit: -1, parent: null, index: 0 });
  }
  renders.sort((a, b) => a.startUs - b.startUs || b.endUs - a.endUs);
  renders.forEach((r, i) => (r.index = i));

  // ---- scheduler updates (Update, Cascading Update, Update Blocked measures)
  const updates: UpdateEvent[] = [];
  for (const m of ms_) {
    const dt = m.detail?.devtools;
    if (!dt || dt.trackGroup !== SCHEDULER_GROUP) continue;
    if (!/^(Update|Cascading Update|Update Blocked)$/.test(m.name)) continue;
    const props: [string, string][] = Array.isArray(dt.properties) ? dt.properties : [];
    const get = (k: string) => props.find((p) => p[0] === k)?.[1] ?? null;
    updates.push({ startUs: m.startUs, endUs: m.endUs, component: get('Component name'), method: get('Method name'), track: dt.track ?? null, cascading: m.name === 'Cascading Update', blocked: m.name === 'Update Blocked', stack: m.stack });
  }
  updates.sort((a, b) => a.startUs - b.startUs);

  // ---- commits from scheduler Render/Commit/Remaining Effects entries
  const sched = stamps.filter((s) => s.trackGroup === SCHEDULER_GROUP).sort((a, b) => a.startUs - b.startUs);
  const commits: Commit[] = [];
  for (let i = 0; i < sched.length; i++) {
    const s = sched[i]!;
    if (s.name !== 'Render') continue;
    const commitEntry = sched.slice(i + 1, i + 6).find((x) => x.name === 'Commit' && x.track === s.track);
    const effects = sched.slice(i + 1, i + 8).find((x) => x.name === 'Remaining Effects' && x.track === s.track);
    const c: Commit = {
      index: commits.length,
      track: s.track,
      renderStartUs: s.startUs,
      renderEndUs: s.endUs,
      commitStartUs: commitEntry?.startUs ?? s.endUs,
      commitEndUs: commitEntry?.endUs ?? s.endUs,
      effectsEndUs: effects?.endUs ?? null,
      components: [],
      root: null,
      triggers: [],
    };
    commits.push(c);
  }
  // assign renders to commits by render window containment (with 50 µs slack)
  let ci = 0;
  for (const r of renders) {
    while (ci < commits.length && commits[ci]!.renderEndUs + 50 < r.startUs) ci++;
    let assigned = -1;
    for (let k = Math.max(0, ci - 1); k < Math.min(commits.length, ci + 2); k++) {
      const c = commits[k]!;
      const limit = c.effectsEndUs ?? c.commitEndUs;
      if (r.startUs >= c.renderStartUs - 50 && r.endUs <= limit + 50) {
        assigned = k;
        break;
      }
    }
    if (assigned >= 0) {
      r.commit = assigned;
      commits[assigned]!.components.push(r);
    }
  }
  // tree by interval containment inside each commit (render entries only)
  for (const c of commits) {
    const stack: ComponentRender[] = [];
    for (const r of c.components) {
      if (r.kind === 'effect' || r.kind === 'trigger' || r.kind === 'error') continue;
      while (stack.length && stack[stack.length - 1]!.endUs < r.startUs) stack.pop();
      r.parent = stack.length ? stack[stack.length - 1]!.index : null;
      stack.push(r);
    }
    const rootCandidates = c.components.filter((r) => r.parent === null && r.kind !== 'effect' && r.kind !== 'trigger' && r.kind !== 'error');
    c.root = rootCandidates.sort((a, b) => b.endUs - b.startUs - (a.endUs - a.startUs))[0] ?? null;
    // self time = own span minus direct children spans
    const children = new Map<number, number>();
    for (const r of c.components) if (r.parent !== null) children.set(r.parent, (children.get(r.parent) ?? 0) + (r.endUs - r.startUs));
    for (const r of c.components) r.selfUs = Math.max(0, r.endUs - r.startUs - (children.get(r.index) ?? 0));
  }
  // triggers: updates that ended before this render started and after the previous render
  let ui = 0;
  for (let k = 0; k < commits.length; k++) {
    const c = commits[k]!;
    const prevEnd = k > 0 ? commits[k - 1]!.renderStartUs : -Infinity;
    while (ui < updates.length && updates[ui]!.startUs < prevEnd) ui++;
    let j = ui;
    while (j < updates.length && updates[j]!.startUs <= c.renderStartUs) {
      c.triggers.push(updates[j]!);
      j++;
    }
    ui = j;
  }

  const samples = samplesFromTrace(events);
  const tasks = events.filter((e) => e.name === 'RunTask' && typeof e.dur === 'number').map((e) => ({ startUs: e.ts, endUs: e.ts + (e.dur ?? 0) }));
  const frames = framePairs(events);
  const windows = windowsFromMetadata(trace, startUs);
  return { startUs, endUs, durationMs: (endUs - startUs) / 1000, commits, renders, updates, samples, tasks, frames, windows, ms };
}

function framePairs(events: TraceEvent[]): { startUs: number; endUs: number }[] {
  const begins = events.filter((e) => e.name === 'BeginFrame').sort((a, b) => a.ts - b.ts);
  const draws = events.filter((e) => e.name === 'DrawFrame').sort((a, b) => a.ts - b.ts);
  const out: { startUs: number; endUs: number }[] = [];
  let di = 0;
  for (const b of begins) {
    while (di < draws.length && draws[di]!.ts < b.ts) di++;
    const d = draws[di];
    if (d) out.push({ startUs: b.ts, endUs: d.ts });
  }
  return out;
}

/**
 * The harness records `marks` (wall-clock) in trace metadata. The first mark is taken at
 * `Tracing.start`, so wall offsets map to trace time with ±50 ms accuracy.
 */
export function windowsFromMetadata(trace: TraceFile, startUs: number): ScenarioWindow[] {
  const marks = (trace.metadata as any)?.marks as { label: string; at: number }[] | undefined;
  if (!Array.isArray(marks) || marks.length < 2) return [];
  const t0 = marks[0]!.at;
  const out: ScenarioWindow[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i]!;
    const b = marks[i + 1]!;
    out.push({ label: a.label, startMs: a.at - t0, endMs: b.at - t0 });
  }
  void startUs;
  return out;
}
