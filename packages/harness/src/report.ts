import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FindingsFile } from '@fixpoint/analyzer';
import { renderMarkdown } from '@fixpoint/analyzer';
import { fmtDelta, fmtPct, type Verdict } from './verdict.js';
import type { ScanIndex } from './scan.js';

export function readVerdicts(dir: string): { file: string; verdict: Verdict }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('aa-latest-'))
    .map((f) => ({ file: join(dir, f), verdict: JSON.parse(readFileSync(join(dir, f), 'utf8')) as Verdict }))
    .filter((x) => x.verdict && x.verdict.version === 1 && x.verdict.verdict)
    .sort((a, b) => a.verdict.generatedAt.localeCompare(b.verdict.generatedAt));
}

const med = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Markdown for docs/RESULTS.md: every verdict, rejects and inconclusives included, with file links. */
export function renderResults(opts: { resultsDir: string; scanDir?: string; linkBase?: string; title?: string }): string {
  const verdicts = readVerdicts(opts.resultsDir);
  const rel = (f: string) => (opts.linkBase ? relative(opts.linkBase, f) : f);
  const out: string[] = [];
  out.push(`# ${opts.title ?? 'Results'}`);
  out.push('');
  out.push('Every number on this page comes from a file in `docs/results/` produced by a real run. Dev build, iOS Simulator. Time metrics carry a 95% confidence interval from an interleaved A/B; counts are compared exactly.');
  out.push('');
  const aa = verdicts.filter((v) => v.verdict.mode === 'aa');
  const ab = verdicts.filter((v) => v.verdict.mode === 'ab');
  if (aa.length) {
    out.push('## A/A calibration');
    out.push('');
    out.push('| route | pairs | renderMs noise floor | counts identical | verdict | file |');
    out.push('|---|---|---|---|---|---|');
    for (const { file, verdict: v } of aa) {
      const identical = v.deterministicDeltas.every((d) => d.base.every((x, i) => x === d.candidate[i]));
      out.push(`| \`${v.route}\` | ${v.pairs} | ${fmtPct(v.noiseFloor.time)} | ${identical ? 'yes' : 'no'} | ${v.harnessFailed ? 'harness failed' : 'flat'} | [${rel(file)}](${rel(file)}) |`);
    }
    out.push('');
  }
  if (ab.length) {
    out.push('## A/B verdicts');
    out.push('');
    out.push('| route | base → candidate | renders per visit | avoidable renders | renderMs (median, 95% CI) | control frames | pixel diff | verdict | file |');
    out.push('|---|---|---|---|---|---|---|---|---|');
    for (const { file, verdict: v } of ab) {
      const r = v.deterministicDeltas.find((d) => d.metric === 'componentRenders');
      const w = v.deterministicDeltas.find((d) => d.metric === 'avoidableRenders');
      const t = v.timeDelta;
      out.push(
        `| \`${v.route}\` | ${v.base.sha.slice(0, 7)} → ${v.candidate.sha.slice(0, 7)} | ${r ? `${med(r.base)} → ${med(r.candidate)} (${fmtDelta(r.medianDelta)})` : '—'} | ${w ? `${med(w.base)} → ${med(w.candidate)} (${fmtDelta(w.medianDelta)})` : '—'} | ${fmtPct(t.relativeMedian)} (${fmtPct(t.relativeCi95.lower)} … ${fmtPct(t.relativeCi95.upper)}), p=${t.p.toFixed(3)} | ${v.controlFramesOk ? 'flat' : 'drifted'} | ${v.pixelDiff ? `${(v.pixelDiff.ratio * 100).toFixed(2)}%` : '—'} | **${v.verdict}** | [${rel(file)}](${rel(file)}) |`,
      );
    }
    out.push('');
    for (const { verdict: v } of ab) {
      out.push(`### \`${v.route}\` — ${v.verdict}`);
      out.push('');
      for (const reason of v.reasons) out.push(`- ${reason}`);
      if (v.artifacts.video) out.push(`- Video: \`${rel(v.artifacts.video)}\``);
      out.push('');
    }
  }
  if (opts.scanDir && existsSync(join(opts.scanDir, 'index.json'))) {
    const index = JSON.parse(readFileSync(join(opts.scanDir, 'index.json'), 'utf8')) as ScanIndex;
    out.push('## Scan');
    out.push('');
    out.push(`Metro ${index.metroUrl}, ${index.device}, ${index.generatedAt}. ${index.routes.filter((r) => r.findingsFile).length} routes recorded, ${index.routes.filter((r) => r.skipped).length} skipped.`);
    if (index.startup) out.push(`Startup: ${index.startup.modulesInitialized} modules initialised before the first screen, ready in ${index.startup.readyMs} ms.`);
    if (index.compiler) out.push(`React Compiler: ${index.compiler.bailouts} bailouts across ${index.compiler.compiled} files.`);
    out.push('');
    for (const r of index.routes) {
      if (!r.findingsFile) continue;
      const findings = JSON.parse(readFileSync(r.findingsFile, 'utf8')) as FindingsFile;
      out.push(`### \`${r.path}\``);
      out.push('');
      out.push(`${findings.totals.commits} commits, ${findings.totals.componentRenders} component renders, ${findings.totals.wastedRenders} avoidable, JS busy ${findings.totals.jsBusyMs} ms of ${findings.totals.traceMs} ms.`);
      out.push('');
      out.push(renderMarkdown(findings, 8));
      out.push('');
    }
  }
  return out.join('\n');
}
