import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceFile } from '@fixpoint/devtools';
import { loadConfig, resolveConfig, serializeConfig } from './config.js';
import { discoverRoutes, routeSlug } from './routes.js';
import { bootstrapMedianCI, median, noiseFloor, summarizePairs, wilcoxonSignedRank } from './stats.js';
import { ReplayProxy, exchangeKey } from './replay-proxy.js';
import { defaultScenario, describeScenario, validateScenario } from './scenario.js';
import { indexComponents, listSourceFiles } from './source-index.js';
import { visitMetrics } from './metrics.js';
import { decide, deterministicDeltas, noiseFloorFromAA, timeDelta, type PairRecord, type Verdict } from './verdict.js';
import { compareBaseline, writeBaseline } from './baseline.js';
import { prBody, prTitle } from './pr.js';
import { renderResults } from './report.js';
import { detectCommands } from './gates.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const tabsTrace = JSON.parse(readFileSync(join(root, 'fixtures/phase0/trace-tabs-scroll-ios-sim.json'), 'utf8')) as TraceFile;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fixpoint-'));
}

describe('config', () => {
  it('loads a TypeScript config file and applies defaults', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'fixpoint.config.ts'), `export default { scheme: 'demo', bundleId: 'com.demo', routes: ['/home', { path: '/user/[id]', params: { id: '42' } }], replay: { mode: 'replay' } };\n`);
    const { config, file } = await loadConfig(dir);
    expect(file).toBe(join(dir, 'fixpoint.config.ts'));
    expect(config.scheme).toBe('demo');
    expect(config.routes).toEqual([{ path: '/home' }, { path: '/user/[id]', params: { id: '42' } }]);
    expect(config.replay).toMatchObject({ mode: 'replay', port: 8789 });
    expect(config.outDir).toContain('.cache/fixpoint/');
    expect(config.metroUrl).toBe('http://localhost:8081');
    expect(config.interactions).toBe('cdp');
    expect(config.pairs).toBe(6);
  });

  it('serialises a user config back to a defineConfig file', () => {
    const text = serializeConfig({ scheme: 'demo', routes: ['/a'] }, 'ts');
    expect(text).toContain("import { defineConfig } from 'fixpoint'");
    expect(text).toContain('scheme: "demo"');
    expect(serializeConfig({ scheme: 'demo' })).not.toContain('import {');
    expect(resolveConfig({}, '/x').appRoot).toBe('/x');
  });
});

describe('routes', () => {
  it('derives Expo Router routes, strips groups, and reports skipped files', () => {
    const dir = tmp();
    const files = ['app/_layout.tsx', 'app/+not-found.tsx', 'app/index.tsx', 'app/(auth)/(tabs)/_layout.tsx', 'app/(auth)/(tabs)/home/index.tsx', 'app/(auth)/(tabs)/home/HomeShimmer.tsx', 'app/(auth)/(tabs)/home/index.ui.tsx', 'app/(auth)/(tabs)/home/_components/card.tsx', 'app/(auth)/(tabs)/user/use-profile.ts', 'app/(auth)/(modal)/post/[id].tsx', 'app/(auth)/(modal)/post/[id]/edit.tsx', 'app/api/hello+api.ts', 'app/settings.tsx'];
    for (const f of files) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), 'export default function X() { return null }\n');
    }
    const routes = discoverRoutes(dir, { routes: [{ path: '/post/[id]', params: { id: '7' } }], exclude: ['/settings'] });
    const byPath = Object.fromEntries(routes.map((r) => [r.path, r]));
    expect(byPath['/']).toMatchObject({ href: '/', skipped: null });
    expect(byPath['/home']).toMatchObject({ href: '/home', file: 'app/(auth)/(tabs)/home/index.tsx' });
    expect(byPath['/home/HomeShimmer']?.skipped).toMatch(/component or hook/);
    expect(byPath['/home/index.ui']?.skipped).toMatch(/component or hook/);
    expect(byPath['/home/_components/card']?.skipped).toMatch(/_private/);
    expect(byPath['/post/[id]']).toMatchObject({ href: '/post/7', dynamic: ['id'] });
    expect(byPath['/post/[id]/edit']).toMatchObject({ href: null, skipped: 'needs params: id' });
    expect(byPath['/settings']).toMatchObject({ href: null, skipped: 'excluded by config' });
    expect(routes.some((r) => r.file.includes('_layout') || r.file.includes('+not-found') || r.file.includes('+api'))).toBe(false);
    expect(routeSlug('/post/[id]/edit')).toBe('post-id-edit');
  });
});

describe('stats', () => {
  it('computes medians, bootstrap intervals and exact Wilcoxon p-values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    const diffs = [-12, -9, -15, -8, -11, -10];
    const w = wilcoxonSignedRank(diffs);
    expect(w.method).toBe('exact');
    expect(w.p).toBeCloseTo(2 / 64, 5);
    const ci = bootstrapMedianCI(diffs);
    expect(ci.lower).toBeLessThanOrEqual(ci.upper);
    expect(ci.upper).toBeLessThan(0);
    expect(wilcoxonSignedRank([0, 0, 0]).p).toBe(1);
    expect(wilcoxonSignedRank([1, -1, 2, -2]).p).toBe(1);
  });

  it('summarises pairs and derives a noise floor', () => {
    const s = summarizePairs([100, 100, 100, 100], [90, 90, 90, 90]);
    expect(s.unanimous).toBe('improved');
    expect(s.relativeMedian).toBeCloseTo(-0.1, 6);
    expect(noiseFloor([100, 100, 100], [103, 98, 101], true)).toBeCloseTo(0.029, 2);
    expect(summarizePairs([5, 5], [5, 5]).unanimous).toBe('unchanged');
    expect(summarizePairs([5, 5], [4, 6]).unanimous).toBe('mixed');
  });
});

describe('replay proxy', () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  let hits = 0;
  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      hits++;
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
        res.end(JSON.stringify({ method: req.method, url: req.url, body }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}`;
  });
  afterAll(() => upstream.close());

  it('records in record mode and serves without forwarding in replay mode; mutations are stubbed', async () => {
    const dir = tmp();
    const rec = new ReplayProxy({ upstream: upstreamUrl, dir, mode: 'record' });
    await rec.start();
    const r1 = await fetch(`${rec.url}/feed?page=1`);
    expect(r1.headers.get('x-fixpoint-replay')).toBe('recorded');
    expect((await r1.json()).url).toBe('/feed?page=1');
    await fetch(`${rec.url}/like`, { method: 'POST', body: JSON.stringify({ id: 1 }), headers: { 'content-type': 'application/json' } });
    await rec.stop();
    const before = hits;
    const rep = new ReplayProxy({ upstream: upstreamUrl, dir, mode: 'replay' });
    await rep.start();
    const r2 = await fetch(`${rep.url}/feed?page=1`);
    expect(r2.headers.get('x-fixpoint-replay')).toBe('hit');
    expect(r2.headers.get('x-upstream')).toBe('yes');
    expect((await r2.json()).url).toBe('/feed?page=1');
    const r3 = await fetch(`${rep.url}/like`, { method: 'POST', body: JSON.stringify({ id: 1 }), headers: { 'content-type': 'application/json' } });
    expect(r3.headers.get('x-fixpoint-replay')).toBe('hit');
    const r4 = await fetch(`${rep.url}/delete-everything`, { method: 'DELETE' });
    expect(r4.status).toBe(200);
    expect(r4.headers.get('x-fixpoint-replay')).toBe('stub');
    const r5 = await fetch(`${rep.url}/unknown`);
    expect(r5.status).toBe(404);
    expect(r5.headers.get('x-fixpoint-replay')).toBe('miss');
    await rep.stop();
    expect(hits).toBe(before); // nothing reached upstream in replay mode
    expect(rep.stats).toMatchObject({ hits: 2, misses: 2, stubbed: 1, forwarded: 0 });
    expect(exchangeKey('GET', '/a', null)).not.toBe(exchangeKey('POST', '/a', null));
  });
});

describe('scenario', () => {
  it('builds the default read-only scenario and validates steps', () => {
    const s = defaultScenario({ settleMs: 1000, scrollAmount: 500 });
    expect(describeScenario(s)).toBe('wait 1000ms → scroll down 500 → wait 600ms → back');
    expect(() => validateScenario([{ type: 'delete', id: 1 }])).toThrow(/invalid scenario step/);
    expect(() => validateScenario([{ type: 'tap' }])).toThrow(/testID or label/);
    expect(validateScenario(s)).toBe(s);
  });
});

describe('source index', () => {
  it('maps component and hook declarations to file:line', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'components'), { recursive: true });
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    writeFileSync(join(dir, 'components/Row.tsx'), `import React from 'react';\n\nexport const Row = React.memo(function Row() { return null });\nexport default function Screen() { return null }\nconst helper = 1;\n`);
    writeFileSync(join(dir, 'hooks/use-thing.ts'), `export function useThing() { return 1 }\n`);
    writeFileSync(join(dir, 'hooks/use-thing.test.ts'), `export function useOther() { return 1 }\n`);
    expect(listSourceFiles(dir)).toEqual(['components/Row.tsx', 'hooks/use-thing.ts']);
    const idx = indexComponents(dir);
    expect(idx.Row).toMatchObject({ file: 'components/Row.tsx', line: 3 });
    expect(idx.Screen).toMatchObject({ file: 'components/Row.tsx', line: 4 });
    expect(idx.useThing).toMatchObject({ file: 'hooks/use-thing.ts', line: 1 });
    expect(idx.helper).toBeUndefined();
  });
});

function pair(index: number, base: Partial<ReturnType<typeof visitMetrics>>, cand: Partial<ReturnType<typeof visitMetrics>>, discarded = false): PairRecord {
  const m = (p: Partial<ReturnType<typeof visitMetrics>>) => ({ componentRenders: 300, avoidableRenders: 50, commits: 10, maxComponentsPerCommit: 120, renderMs: 400, jsBusyMs: null, scenarioMs: 5000, ...p });
  return { index, discarded, mode: discarded ? 'full' : 'light', order: ['A', 'B'], base: m(base), candidate: m(cand), traces: { base: 'a', candidate: 'b' }, appPids: { base: 1, candidate: 2 } };
}

describe('metrics and verdicts', () => {
  it('extracts deterministic counts and render time from a trace', () => {
    const m = visitMetrics(tabsTrace);
    expect(m).toMatchObject({ componentRenders: 3342, avoidableRenders: 499, commits: 53, maxComponentsPerCommit: 628 });
    expect(m.renderMs).toBeGreaterThan(50);
    expect(m.jsBusyMs).toBeGreaterThan(500);
    expect(m.scenarioMs).toBeGreaterThan(10_000);
  });

  it('accepts a unanimous deterministic improvement, rejects a regression, and flags an unstable A/A', () => {
    const nf = { time: 0.03, counts: { componentRenders: 0, avoidableRenders: 0, commits: 0, maxComponentsPerCommit: 0 }, pairs: 6, source: 'test' };
    const good = [pair(0, {}, {}, true), ...[1, 2, 3, 4, 5, 6].map((i) => pair(i, { renderMs: 400 + i }, { componentRenders: 220, avoidableRenders: 10, renderMs: 300 + i }))];
    const d = decide({ mode: 'ab', pairs: good, noiseFloor: nf, controlFrames: null, thresholds: { minEffect: 0.05, alpha: 0.05 } });
    expect(d.verdict).toBe('accept');
    expect(deterministicDeltas(good).find((x) => x.metric === 'componentRenders')).toMatchObject({ medianDelta: -80, unanimous: 'improved', exact: true });
    expect(timeDelta(good).relativeMedian).toBeLessThan(-0.2);
    const bad = [1, 2, 3, 4, 5, 6].map((i) => pair(i, {}, { componentRenders: 310 + i }));
    expect(decide({ mode: 'ab', pairs: bad, noiseFloor: nf, controlFrames: null, thresholds: { minEffect: 0.05, alpha: 0.05 } }).verdict).toBe('reject');
    const flat = [1, 2, 3, 4, 5, 6].map((i) => pair(i, { renderMs: 400 + (i % 2) }, { renderMs: 401 - (i % 2) }));
    expect(decide({ mode: 'ab', pairs: flat, noiseFloor: nf, controlFrames: null, thresholds: { minEffect: 0.05, alpha: 0.05 } }).verdict).toBe('inconclusive');
    const drift = decide({ mode: 'ab', pairs: good, noiseFloor: nf, controlFrames: { ok: false, drift: 0.4, maxAllowed: 0.25, compared: 20, topMovers: [], attempts: 3 }, thresholds: { minEffect: 0.05, alpha: 0.05 } });
    expect(drift.verdict).toBe('inconclusive');
    const aaFlat = [1, 2, 3, 4, 5, 6].map((i) => pair(i, { renderMs: 400 + i }, { renderMs: 402 + i }));
    const aa = decide({ mode: 'aa', pairs: aaFlat, noiseFloor: noiseFloorFromAA(aaFlat, 't'), controlFrames: null, thresholds: { minEffect: 0.05, alpha: 0.05 } });
    expect(aa.harnessFailed).toBe(false);
    const aaBad = [1, 2, 3, 4, 5, 6].map((i) => pair(i, {}, { componentRenders: 280 }));
    expect(decide({ mode: 'aa', pairs: aaBad, noiseFloor: noiseFloorFromAA(aaBad, 't'), controlFrames: null, thresholds: { minEffect: 0.05, alpha: 0.05 } }).harnessFailed).toBe(true);
    expect(noiseFloorFromAA(aaFlat, 't').time).toBeCloseTo(2 / 401, 3);
  });

  it('writes and checks baselines exactly', () => {
    const dir = tmp();
    const file = join(dir, 'baseline.json');
    const m = visitMetrics(tabsTrace);
    writeBaseline(file, { '/timelines': m });
    expect(compareBaseline(file, { '/timelines': m }).ok).toBe(true);
    const worse = compareBaseline(file, { '/timelines': { ...m, componentRenders: m.componentRenders + 1 }, '/new': m });
    expect(worse.ok).toBe(false);
    expect(worse.regressions[0]).toMatchObject({ route: '/timelines', metric: 'componentRenders' });
    expect(worse.missing).toEqual(['/new']);
  });

  it('renders a PR body and a results page from verdict files', () => {
    const dir = tmp();
    const nf = { time: 0.03, counts: { componentRenders: 0, avoidableRenders: 0, commits: 0, maxComponentsPerCommit: 0 }, pairs: 6, source: 'aa' };
    const records = [pair(0, {}, {}, true), ...[1, 2, 3, 4, 5, 6].map((i) => pair(i, { renderMs: 400 + i }, { componentRenders: 220, renderMs: 300 + i }))];
    const decision = decide({ mode: 'ab', pairs: records, noiseFloor: nf, controlFrames: null, thresholds: { minEffect: 0.05, alpha: 0.05 } });
    const verdict: Verdict = { version: 1, mode: 'ab', route: '/notifications', scenario: 'wait → scroll', generatedAt: new Date().toISOString(), label: 'dev build, iOS Simulator', base: { ref: 'main', sha: 'a'.repeat(40), metro: 'http://127.0.0.1:8091' }, candidate: { ref: 'fix', sha: 'b'.repeat(40), metro: 'http://127.0.0.1:8092' }, deterministicDeltas: deterministicDeltas(records), timeDelta: timeDelta(records), noiseFloor: nf, controlFramesOk: true, controlFrames: null, pairs: 6, pairsDetail: records, pixelDiff: { ratio: 0.001, ok: true, maxRatio: 0.005, diffFile: null }, verdict: decision.verdict, reasons: decision.reasons, artifacts: { traces: ['t.gz'], video: null, screenshots: [], dir }, environment: { device: 'iPhone 17', replayMode: 'off', foreignEvents: [] } };
    const finding = { id: 'wasted-render:x:deadbeef', kind: 'wasted-render' as const, severity: 'high' as const, score: 300, metric: { name: 'avoidableRenders', value: 60, unit: 'count' as const, deterministic: true }, evidence: { frames: [], components: [{ name: 'Row', renders: 80, selfMs: 12, wasted: 60 }], commits: [] }, location: { file: 'components/Row.tsx', line: 10, column: 0, symbol: 'Row' }, suggestedFixes: ['stable-row-props' as const], summary: 'Row rendered 80 times with deeply equal props.' };
    const gates = { ok: true, gates: [{ name: 'typecheck', ok: true, durationMs: 1, output: '' }, { name: 'pixel-diff', ok: true, durationMs: 1, output: '0.100% of pixels differ (max 0.5%)' }] };
    const body = prBody({ route: '/notifications', finding, recipeId: 'stable-row-props', verdict, gates, fixDescription: 'Memoised row props.' });
    expect(prTitle({ route: '/notifications', finding, recipeId: 'stable-row-props', verdict, gates, fixDescription: '' })).toBe('perf(notifications): wasted-render — stable-row-props (-80 renders per visit)');
    expect(body).toContain('| componentRenders | 300 | 220 | -80 | improved, identical in every pair |');
    expect(body).toContain('dev build, iOS Simulator');
    expect(body).toContain('Verdict: **accept**');
    expect(body).toContain('[x] pixel-diff');
    const resultsDir = join(dir, 'results');
    mkdirSync(resultsDir);
    writeFileSync(join(resultsDir, 'notifications-1.json'), JSON.stringify(verdict));
    const md = renderResults({ resultsDir, linkBase: dir });
    expect(md).toContain('## A/B verdicts');
    expect(md).toContain('300 → 220 (-80)');
    expect(md).toContain('**accept**');
  });

  it('detects the app scripts used by the gates', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'type-check': 'tsc --noEmit', lint: 'eslint .', test: 'jest --watchAll' } }));
    writeFileSync(join(dir, 'yarn.lock'), '');
    const c = detectCommands(dir);
    expect(c.typecheck).toEqual(['yarn', '-s', 'type-check']);
    expect(c.lint).toEqual(['yarn', '-s', 'lint']);
    expect(c.test).toEqual(['npx', 'jest', '--ci', '--silent']);
  });

  it('keeps gzip-compressed traces readable', () => {
    const z = gzipSync(JSON.stringify({ traceEvents: [] }));
    expect(JSON.parse(gunzipSync(z).toString())).toEqual({ traceEvents: [] });
  });
});
