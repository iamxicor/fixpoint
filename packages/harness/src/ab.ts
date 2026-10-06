import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Symbolicator, fetchMapLoader, type TraceFile } from '@fixpoint/devtools';
import { buildModel, selfTimeByFrame } from '@fixpoint/analyzer';
import { AppSession, type SessionOptions } from './app-session.js';
import type { FixpointConfig, ScenarioStep } from './config.js';
import { visitMetrics, type VisitMetrics } from './metrics.js';
import { changedFiles, devClientUrl, overrideEnvVar, prepareWorktree, readEnvVar, startMetro, type MetroHandle } from './metro.js';
import { pixelDiff } from './gates.js';
import { ReplayProxy } from './replay-proxy.js';
import { routeSlug } from './routes.js';
import { defaultScenario, describeScenario } from './scenario.js';
import { foreignDriverEvents, resolveDevice, startVideo } from './simulator.js';
import { composeSideBySide } from './video.js';
import { decide, deterministicDeltas, noiseFloorFromAA, timeDelta, type ControlFrames, type NoiseFloor, type PairRecord, type Verdict } from './verdict.js';

const LIGHT_CATEGORIES = ['-*', 'devtools.timeline', 'blink.user_timing'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AbOptions {
  config: FixpointConfig;
  mode: 'ab' | 'aa';
  route: string;
  scenario?: ScenarioStep[];
  baseRef: string;
  /** Ignored for A/A (base is used twice). */
  candidateRef?: string;
  pairs?: number;
  video?: boolean;
  outDir?: string;
  /** Where verdict JSON files are written (defaults to config.resultsDir). */
  resultsDir?: string;
  log?: (msg: string) => void;
  /** Reuse an existing A/A noise floor instead of running one (A/B only). */
  noiseFloorFile?: string;
}

interface Variant {
  key: 'A' | 'B';
  ref: string;
  sha: string;
  dir: string;
  metro: MetroHandle;
  sym: Symbolicator;
}

export async function runAb(opts: AbOptions): Promise<Verdict> {
  const cfg = opts.config;
  const log = opts.log ?? (() => undefined);
  const slug = routeSlug(opts.route);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = opts.outDir ?? join(cfg.outDir, opts.mode, `${slug}-${stamp}`);
  const resultsDir = opts.resultsDir ?? cfg.resultsDir;
  mkdirSync(outDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  const device = resolveDevice(cfg.simulator);
  const startedAt = new Date();
  const pairs = opts.pairs ?? cfg.pairs;
  const scenario = opts.scenario ?? defaultScenario({ settleMs: cfg.settleMs, back: false });
  const candidateRef = opts.mode === 'aa' ? opts.baseRef : opts.candidateRef!;
  if (!candidateRef) throw new Error('candidateRef is required for A/B');

  // A/B needs a noise floor from an A/A; run one first when none exists
  let noiseFloor: NoiseFloor | null = null;
  if (opts.mode === 'ab') {
    const nfFile = opts.noiseFloorFile ?? join(resultsDir, `aa-latest-${slug}.json`);
    if (existsSync(nfFile)) {
      const aa = JSON.parse(readFileSync(nfFile, 'utf8')) as Verdict;
      noiseFloor = aa.noiseFloor;
      log(`noise floor from ${nfFile}: time ${(noiseFloor.time * 100).toFixed(1)}%`);
    } else {
      log('no A/A calibration found for this route; running one first');
      const aa = await runAb({ ...opts, mode: 'aa', candidateRef: undefined, video: false, outDir: undefined });
      if (aa.harnessFailed) throw new Error(`A/A calibration failed: ${aa.reasons.join('; ')}`);
      noiseFloor = aa.noiseFloor;
    }
  }

  // worktrees, replay proxy, two Metro servers
  const wtRoot = join(cfg.outDir, 'worktrees');
  const base = await prepareWorktree({ repo: cfg.appRoot, ref: opts.baseRef, dir: join(wtRoot, 'base') });
  const cand = await prepareWorktree({ repo: cfg.appRoot, ref: candidateRef, dir: join(wtRoot, 'candidate') });
  log(`worktrees: base ${base.sha.slice(0, 8)} candidate ${cand.sha.slice(0, 8)}`);
  const touched = new Set(opts.mode === 'ab' ? changedFiles(cfg.appRoot, base.sha, cand.sha) : []);
  let proxy: ReplayProxy | null = null;
  const env: Record<string, string> = {};
  if (cfg.replay.mode !== 'off') {
    const upstream = readEnvVar(cfg.appRoot, cfg.apiBaseEnvVar);
    if (!upstream) throw new Error(`${cfg.apiBaseEnvVar} not found in the app's env files; the replay proxy needs the upstream API URL`);
    proxy = new ReplayProxy({ upstream, dir: cfg.replay.dir, mode: cfg.replay.mode, port: cfg.replay.port });
    await proxy.start();
    env[cfg.apiBaseEnvVar] = proxy.url;
    overrideEnvVar(base.dir, cfg.apiBaseEnvVar, proxy.url);
    overrideEnvVar(cand.dir, cfg.apiBaseEnvVar, proxy.url);
    log(`replay proxy (${cfg.replay.mode}) at ${proxy.url} → ${upstream}`);
  }
  const metroA = await startMetro({ appRoot: base.dir, port: cfg.abPorts[0], env, logFile: join(outDir, 'metro-A.log') });
  const metroB = await startMetro({ appRoot: cand.dir, port: cfg.abPorts[1], env, logFile: join(outDir, 'metro-B.log') });
  log(`Metro A ${metroA.url} (base), Metro B ${metroB.url} (candidate)`);
  const A: Variant = { key: 'A', ref: opts.baseRef, sha: base.sha, dir: base.dir, metro: metroA, sym: new Symbolicator(fetchMapLoader(), { rootDir: base.dir }) };
  const B: Variant = { key: 'B', ref: candidateRef, sha: cand.sha, dir: cand.dir, metro: metroB, sym: new Symbolicator(fetchMapLoader(), { rootDir: cand.dir }) };

  const records: PairRecord[] = [];
  const traces: string[] = [];
  const screenshots: string[] = [];
  let video: string | null = null;
  let controlFrames: ControlFrames | null = null;
  let pixel: Verdict['pixelDiff'] = null;
  try {
    // pair 0: full tracing, discarded from the statistics, used for control frames, screenshots and video
    let attempts = 0;
    let diag: { a: Visit; b: Visit } | null = null;
    while (attempts < 3) {
      attempts++;
      log(`diagnostic pair (attempt ${attempts}): A then B, full tracing`);
      const a = await visit(A, 'full', { record: opts.video ? join(outDir, 'A.mp4') : null, screenshot: join(outDir, 'A-settled.png') });
      const b = await visit(B, 'full', { record: opts.video ? join(outDir, 'B.mp4') : null, screenshot: join(outDir, 'B-settled.png') });
      diag = { a, b };
      controlFrames = opts.mode === 'ab' ? await controlFrameCheck(a, b, A.sym, B.sym, touched, cfg.thresholds.maxControlDrift, attempts) : null;
      if (!controlFrames || controlFrames.ok) break;
      log(`control frames drifted ${(controlFrames.drift * 100).toFixed(1)}%; retrying the diagnostic pair`);
    }
    const d = diag!;
    records.push(toRecord(0, true, 'full', d.a, d.b, outDir, traces));
    screenshots.push(d.a.screenshot!, d.b.screenshot!);
    pixel = { ...pixelDiff(d.a.screenshot!, d.b.screenshot!, join(outDir, 'pixel-diff.png')), maxRatio: 0.005, diffFile: join(outDir, 'pixel-diff.png') };
    pixel.ok = pixel.ratio <= pixel.maxRatio;
    if (opts.video && d.a.video && d.b.video) {
      try {
        video = await composeSideBySide({ left: d.a.video, right: d.b.video, out: join(outDir, 'side-by-side.mp4'), leftLabel: `A base ${A.sha.slice(0, 7)}`, rightLabel: `B candidate ${B.sha.slice(0, 7)}`, caption: `${opts.route} · dev build, iOS Simulator` });
      } catch (e) {
        log(`video composition failed: ${(e as Error).message}`);
      }
    }
    // measured pairs: light counters only, interleaved A B A B …
    for (let i = 1; i <= pairs; i++) {
      log(`pair ${i}/${pairs}: A then B, light counters`);
      const a = await visit(A, 'light', {});
      const b = await visit(B, 'light', {});
      records.push(toRecord(i, false, 'light', a, b, outDir, traces));
      log(`  A renders=${a.metrics.componentRenders} renderMs=${a.metrics.renderMs}  B renders=${b.metrics.componentRenders} renderMs=${b.metrics.renderMs}`);
    }
  } finally {
    await metroA.stop();
    await metroB.stop();
    await proxy?.stop();
  }

  const nf = opts.mode === 'aa' ? noiseFloorFromAA(records, `aa ${slug} ${stamp}`) : noiseFloor!;
  const decision = decide({ mode: opts.mode, pairs: records, noiseFloor: nf, controlFrames, thresholds: cfg.thresholds });
  const foreign = foreignDriverEvents(device.udid, startedAt, cfg.bundleId);
  const verdict: Verdict = {
    version: 1,
    mode: opts.mode,
    route: opts.route,
    scenario: describeScenario(scenario),
    generatedAt: new Date().toISOString(),
    label: 'dev build, iOS Simulator',
    base: { ref: opts.baseRef, sha: base.sha, metro: metroA.url },
    candidate: { ref: candidateRef, sha: cand.sha, metro: metroB.url },
    deterministicDeltas: deterministicDeltas(records),
    timeDelta: timeDelta(records),
    noiseFloor: nf,
    controlFramesOk: controlFrames ? controlFrames.ok : true,
    controlFrames,
    pairs: records.filter((r) => !r.discarded).length,
    pairsDetail: records,
    pixelDiff: pixel,
    verdict: decision.verdict,
    reasons: decision.reasons,
    harnessFailed: decision.harnessFailed,
    artifacts: { traces, video, screenshots, dir: outDir },
    environment: { device: device.name, replayMode: cfg.replay.mode, foreignEvents: foreign },
  };
  if (foreign.length) verdict.reasons.push(`${foreign.length} foreign simulator events during the run (another tool drove the app)`);
  const file = join(resultsDir, `${opts.mode === 'aa' ? 'aa-' : ''}${slug}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(verdict, null, 2));
  writeFileSync(join(outDir, 'verdict.json'), JSON.stringify(verdict, null, 2));
  if (opts.mode === 'aa') writeFileSync(join(resultsDir, `aa-latest-${slug}.json`), JSON.stringify(verdict, null, 2));
  log(`verdict: ${verdict.verdict} — ${verdict.reasons.join('; ')} → ${file}`);
  return verdict;

  // ---- helpers ------------------------------------------------------------------------------------

  interface Visit {
    variant: 'A' | 'B';
    mode: 'full' | 'light';
    trace: TraceFile;
    metrics: VisitMetrics;
    pid: number | null;
    screenshot: string | null;
    video: string | null;
  }

  async function visit(v: Variant, mode: 'full' | 'light', extra: { record?: string | null; screenshot?: string }): Promise<Visit> {
    const sessionOpts: SessionOptions = { device, bundleId: cfg.bundleId, scheme: cfg.scheme, metroUrl: v.metro.url, interactions: cfg.interactions, log };
    const session = await AppSession.coldStart({ ...sessionOpts, captureStartup: false });
    try {
      const home = await session.settleRoute();
      // visit discipline: warm visit first, measure the second
      await session.navigate(opts.route);
      await sleep(Math.min(cfg.settleMs, 1500));
      await session.back();
      if ((await session.routeInfo())?.pathname !== home) await session.navigate(home, 8_000).catch(() => undefined);
      const rec = extra.record ? startVideo(device.udid, extra.record) : null;
      const { trace } = await session.record(scenario, {
        categories: mode === 'light' ? LIGHT_CATEGORIES : undefined,
        label: `${v.key}:${opts.route}`,
        before: async () => {
          await session.navigate(opts.route);
          await sleep(cfg.settleMs);
          if (extra.screenshot) session.screenshot(extra.screenshot);
        },
      });
      const videoFile = rec ? await rec.stop().catch(() => null) : null;
      return { variant: v.key, mode, trace, metrics: visitMetrics(trace), pid: session.pid, screenshot: extra.screenshot ?? null, video: videoFile };
    } finally {
      session.close();
    }
  }
}

function toRecord(index: number, discarded: boolean, mode: 'full' | 'light', a: { trace: TraceFile; metrics: VisitMetrics; pid: number | null }, b: { trace: TraceFile; metrics: VisitMetrics; pid: number | null }, outDir: string, traces: string[]): PairRecord {
  const fa = join(outDir, `pair-${index}-A.trace.json.gz`);
  const fb = join(outDir, `pair-${index}-B.trace.json.gz`);
  writeFileSync(fa, gzipSync(JSON.stringify(a.trace)));
  writeFileSync(fb, gzipSync(JSON.stringify(b.trace)));
  traces.push(fa, fb);
  return { index, discarded, mode, order: ['A', 'B'], base: a.metrics, candidate: b.metrics, traces: { base: fa, candidate: fb }, appPids: { base: a.pid, candidate: b.pid } };
}

/**
 * Control-frame check: self time per symbolicated function, restricted to files the candidate diff
 * did not touch. If that total drifts more than `maxDrift`, the environment moved, not the code.
 */
async function controlFrameCheck(a: { trace: TraceFile }, b: { trace: TraceFile }, symA: Symbolicator, symB: Symbolicator, touched: Set<string>, maxDrift: number, attempts: number): Promise<ControlFrames> {
  const perFn = async (trace: TraceFile, sym: Symbolicator) => {
    const m = buildModel(trace);
    const out = new Map<string, { ms: number; file: string | null; symbol: string }>();
    if (!m.samples) return out;
    const top = selfTimeByFrame(m.samples, -Infinity, Infinity, 400);
    const frames = await sym.frames(top.map((t) => t.frame));
    top.forEach((t, i) => {
      const f = frames[i]!;
      const key = `${f.file ?? f.generated.url}#${f.symbol}`;
      const e = out.get(key) ?? { ms: 0, file: f.file, symbol: f.symbol };
      e.ms += t.selfUs / 1000;
      out.set(key, e);
    });
    return out;
  };
  const [fa, fb] = await Promise.all([perFn(a.trace, symA), perFn(b.trace, symB)]);
  let baseTotal = 0;
  let candTotal = 0;
  let compared = 0;
  const movers: ControlFrames['topMovers'] = [];
  const keys = new Set([...fa.keys(), ...fb.keys()]);
  for (const k of keys) {
    const x = fa.get(k);
    const y = fb.get(k);
    const file = x?.file ?? y?.file ?? null;
    if (!file || touched.has(file)) continue;
    const bx = x?.ms ?? 0;
    const by = y?.ms ?? 0;
    if (Math.max(bx, by) < 5) continue;
    compared++;
    baseTotal += bx;
    candTotal += by;
    movers.push({ symbol: x?.symbol ?? y!.symbol, file, baseMs: Math.round(bx * 10) / 10, candidateMs: Math.round(by * 10) / 10 });
  }
  const drift = baseTotal > 0 ? Math.abs(candTotal - baseTotal) / baseTotal : 0;
  movers.sort((p, q) => Math.abs(q.candidateMs - q.baseMs) - Math.abs(p.candidateMs - p.baseMs));
  return { ok: compared === 0 || drift <= maxDrift, drift: Math.round(drift * 1000) / 1000, maxAllowed: maxDrift, compared, topMovers: movers.slice(0, 8), attempts };
}

export { devClientUrl };
