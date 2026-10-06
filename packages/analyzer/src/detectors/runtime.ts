import { busyRuns, busyUs } from '../trace/profile.js';
import type { Finding, FixId } from '../types.js';
import { findingId, firstAppFrameLocation, plural, round, scoreFor, severityFor, topAppFrames, topFrames, type Detector } from './context.js';

const MODULE_INIT = /metroRequire|loadModuleImplementation|guardedLoadModule|__r\b|initializ/i;
const LIST_FRAME = /VirtualizedList|FlashList|CellRenderer|_onScroll|onViewableItemsChanged|updateCellsBatching/;

function fixesForFrames(frames: { symbol: string; file: string | null }[]): FixId[] {
  const text = frames.map((f) => `${f.symbol} ${f.file ?? ''}`).join(' ');
  const fixes: FixId[] = [];
  if (MODULE_INIT.test(text)) fixes.push('lazy-require');
  if (LIST_FRAME.test(text)) fixes.push('list-config', 'stable-row-props');
  return fixes;
}

/** long-task: JS work that blocks the event loop for longer than the threshold. */
export const longTask: Detector = async (ctx) => {
  const m = ctx.model;
  if (!m) return [];
  const t = ctx.thresholds;
  let tasks = m.tasks;
  let method = 'RunTask events from the React Native event loop';
  if (tasks.length === 0) {
    if (!m.samples) return [];
    tasks = busyRuns(m.samples, t.busyRunGapMs).map((r) => ({ startUs: r.startUs, endUs: r.endUs }));
    method = `consecutive non-idle sampling-profiler samples with gaps under ${t.busyRunGapMs} ms (RunTask events absent in this trace)`;
    if (!ctx.notes.includes(NOTE_RUNTASK)) ctx.notes.push(NOTE_RUNTASK);
  }
  const long = tasks.filter((x) => (x.endUs - x.startUs) / 1000 >= t.longTaskMs).sort((a, b) => b.endUs - b.startUs - (a.endUs - a.startUs));
  if (long.length === 0) return [];
  const groups = new Map<string, typeof long>();
  const frameCache = new Map<string, Awaited<ReturnType<typeof topFrames>>>();
  for (const task of long) {
    const frames = m.samples ? await topFrames(ctx, m.samples, [task], 6) : [];
    const key = frames[0] ? `${frames[0].symbol}@${frames[0].file ?? frames[0].generated?.url ?? ''}` : 'unknown';
    groups.set(key, [...(groups.get(key) ?? []), task]);
    if (!frameCache.has(key)) frameCache.set(key, frames);
  }
  const out: Finding[] = [];
  for (const [key, group] of groups) {
    const durations = group.map((x) => (x.endUs - x.startUs) / 1000);
    const longest = Math.max(...durations);
    const total = durations.reduce((a, b) => a + b, 0);
    const severity = severityFor(longest, t.longTaskMs, t.longTaskMs * 2, t.longTaskMs * 5)!;
    const frames = frameCache.get(key) ?? [];
    const appFrames = m.samples ? await topAppFrames(ctx, m.samples, group, 5) : [];
    const location = firstAppFrameLocation(ctx, [...appFrames, ...frames], { file: frames[0]?.file ?? null, line: frames[0]?.line ?? null, column: frames[0]?.column ?? null, symbol: frames[0]?.symbol ?? 'unknown' });
    const inWindow = m.windows.filter((w) => group.some((g) => m.ms(g.startUs) >= w.startMs && m.ms(g.startUs) < w.endMs)).map((w) => w.label);
    out.push({
      id: findingId('long-task', key),
      kind: 'long-task',
      severity,
      score: scoreFor(severity, total, false),
      metric: {
        name: 'longestTaskMs',
        value: round(longest),
        unit: 'ms',
        deterministic: false,
        method,
        secondary: [
          { name: 'tasksOverThreshold', value: group.length, unit: 'count', deterministic: false },
          { name: 'totalMs', value: round(total), unit: 'ms', deterministic: false },
        ],
      },
      evidence: { frames, components: [], commits: [], extra: { appFrames, tasks: group.slice(0, 10).map((g) => ({ atMs: round(m.ms(g.startUs)), ms: round((g.endUs - g.startUs) / 1000) })), windows: inWindow } },
      location,
      suggestedFixes: fixesForFrames(frames),
      summary: `${plural(group.length, 'JavaScript task')} ran longer than ${t.longTaskMs} ms (longest ${round(longest)} ms, ${round(total)} ms in total)${inWindow.length ? ` during ${inWindow.join(', ')}` : ''}. The heaviest frame was ${frames[0]?.symbol ?? 'unknown'}${frames[0]?.file ? ` in ${frames[0].file}` : ''}. Time is not deterministic; the task count under the same scenario is the number to watch.`,
    });
  }
  return out;
};

const NOTE_RUNTASK = 'The trace has no RunTask events (expected on Expo SDK 56 / React Native 0.85); long tasks and frame drops are derived from sampling-profiler busy runs.';

/** frame-drop: frames over budget during the scroll window (or JS busy runs over budget when frame events are absent). */
export const frameDrop: Detector = async (ctx) => {
  const m = ctx.model;
  if (!m) return [];
  const t = ctx.thresholds;
  const scrollWindows = m.windows.filter((w) => /scroll/i.test(w.label));
  const windows = (scrollWindows.length ? scrollWindows : m.windows.length ? m.windows : [{ label: 'trace', startMs: 0, endMs: m.durationMs }]).map((w) => ({ ...w, startUs: m.startUs + w.startMs * 1000, endUs: m.startUs + w.endMs * 1000 }));
  const out: Finding[] = [];
  for (const w of windows) {
    let over: { startUs: number; endUs: number }[] = [];
    let method: string;
    let totalFrames = 0;
    if (m.frames.length) {
      const frames = m.frames.filter((f) => f.startUs >= w.startUs && f.endUs <= w.endUs);
      totalFrames = frames.length;
      over = frames.filter((f) => (f.endUs - f.startUs) / 1000 > t.frameBudgetMs);
      method = 'BeginFrame/DrawFrame pairs longer than the frame budget';
    } else {
      if (!m.samples) continue;
      const runs = busyRuns(m.samples, t.busyRunGapMs).filter((r) => r.startUs >= w.startUs && r.endUs <= w.endUs);
      totalFrames = Math.round((w.endUs - w.startUs) / 1000 / t.frameBudgetMs);
      over = runs.filter((r) => r.durationMs > t.frameBudgetMs);
      method = `JavaScript busy runs longer than ${t.frameBudgetMs} ms inside the window (no frame events in this trace)`;
      if (!ctx.notes.includes(NOTE_RUNTASK)) ctx.notes.push(NOTE_RUNTASK);
    }
    if (over.length === 0) continue;
    const busyMs = round(busyUs(m.samples!, w.startUs, w.endUs) / 1000);
    const pct = totalFrames ? round((over.length / totalFrames) * 100, 1) : 0;
    const severity = severityFor(pct, 2, 10, 25) ?? 'low';
    const frames = m.samples ? await topFrames(ctx, m.samples, over, 8) : [];
    const appFrames = m.samples ? await topAppFrames(ctx, m.samples, over, 5) : [];
    out.push({
      id: findingId('frame-drop', w.label),
      kind: 'frame-drop',
      severity,
      score: scoreFor(severity, over.length, false),
      metric: {
        name: 'framesOverBudget',
        value: over.length,
        unit: 'count',
        deterministic: false,
        method,
        secondary: [
          { name: 'windowFrames', value: totalFrames, unit: 'count', deterministic: false },
          { name: 'percentOverBudget', value: pct, unit: 'percent', deterministic: false },
          { name: 'jsBusyMs', value: busyMs, unit: 'ms', deterministic: false },
          { name: 'worstMs', value: round(Math.max(...over.map((o) => (o.endUs - o.startUs) / 1000))), unit: 'ms', deterministic: false },
        ],
      },
      evidence: { frames, components: [], commits: [], extra: { appFrames, window: w.label, windowMs: round(w.endMs - w.startMs) } },
      location: firstAppFrameLocation(ctx, [...appFrames, ...frames], { file: null, line: null, column: null, symbol: frames[0]?.symbol ?? 'unknown' }),
      suggestedFixes: fixesForFrames(frames).length ? fixesForFrames(frames) : ['list-config', 'stable-row-props'],
      summary: `During "${w.label}" (${round(w.endMs - w.startMs)} ms) the JS thread was busy for ${busyMs} ms and ${over.length} stretches exceeded the ${t.frameBudgetMs} ms frame budget (worst ${round(Math.max(...over.map((o) => (o.endUs - o.startUs) / 1000)))} ms). ${frames[0] ? `Top frame: ${frames[0].symbol}${frames[0].file ? ` in ${frames[0].file}` : ''}.` : ''} This metric is time-based and only trusted after an interleaved A/B.`.replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
};
