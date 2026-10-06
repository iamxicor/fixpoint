import type { CallFrame, SymbolicatedFrame } from '@fixpoint/devtools';
import { makeCachedSymbolicator, makeIsAppComponent, makeIsAppFile, makeLocate, type DetectorContext } from './detectors/context.js';
import { hotComponent, renderFanout, wastedRender } from './detectors/render.js';
import { frameDrop, longTask } from './detectors/runtime.js';
import { compilerBailout, heapGrowth, startupCriticalPath } from './detectors/static.js';
import { buildModel, type TraceModel } from './trace/model.js';
import { busyUs, samplesFromProfile } from './trace/profile.js';
import { DEFAULT_THRESHOLDS, type AnalyzeInput, type Finding, type FindingsFile } from './types.js';

const KIND_ORDER = ['render-fanout', 'wasted-render', 'hot-component', 'long-task', 'frame-drop', 'startup-critical-path', 'heap-growth', 'compiler-bailout'];

export function rank(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.id.localeCompare(b.id));
}

const passthrough = async (frames: CallFrame[]): Promise<SymbolicatedFrame[]> =>
  frames.map((f) => ({ functionName: f.functionName, symbol: f.functionName || '(anonymous)', file: null, line: null, column: null, generated: { url: f.url, line: f.lineNumber, column: f.columnNumber } }));

/**
 * Reduces recordings to ranked findings. Pure: no network, no simulator. Symbolication is injected.
 */
export async function analyze(input: AnalyzeInput): Promise<FindingsFile> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const notes: string[] = [];
  let model: TraceModel | null = null;
  if (input.trace) {
    model = buildModel(input.trace);
    if (input.windows?.length) model.windows = input.windows;
    if (!model.samples && input.profile) {
      model.samples = samplesFromProfile(input.profile);
      notes.push('Sampling data came from a separate .cpuprofile; its clock may not align with the trace.');
    }
    if (model.commits.length === 0) notes.push('No Scheduler ⚛ Render entries were found; React performance tracks may be unavailable in this build.');
  }
  const ctx: DetectorContext = {
    model,
    input,
    thresholds,
    notes,
    locate: makeLocate(input),
    symbolicate: input.symbolicate ?? passthrough,
    symbolicateCached: makeCachedSymbolicator(input.symbolicate ?? passthrough),
    isAppFile: makeIsAppFile(input.appRoot),
    isAppComponent: makeIsAppComponent(input),
  };
  if (!input.symbolicate) notes.push('No symbolicator was provided; frames are reported at bundle positions.');

  const findings: Finding[] = [];
  for (const d of [renderFanout, wastedRender, hotComponent, longTask, frameDrop, startupCriticalPath, heapGrowth]) findings.push(...(await d(ctx)));
  const related = new Set<string>();
  for (const f of findings) for (const c of f.evidence.components) related.add(c.name);
  for (const f of findings) if (f.location.symbol) related.add(f.location.symbol);
  findings.push(...(await compilerBailout(related)(ctx)));

  const ranked = rank(findings);
  const renders = model ? model.renders.filter((r) => r.kind === 'render' || r.kind === 'changed-props') : [];
  const wasted = renders.filter((r) => r.diff && (r.diff.deepEqualOnly || r.diff.callbackOnly)).length;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    context: { route: input.context?.route, scenario: input.context?.scenario, platform: input.context?.platform ?? 'ios-simulator', build: input.context?.build ?? 'dev' },
    totals: {
      commits: model?.commits.length ?? 0,
      componentRenders: renders.length,
      wastedRenders: wasted,
      jsBusyMs: model?.samples ? Math.round(busyUs(model.samples) / 1000) : 0,
      traceMs: model ? Math.round(model.durationMs) : 0,
      samples: model?.samples?.samples.length ?? 0,
    },
    findings: ranked,
    notes,
  };
}
