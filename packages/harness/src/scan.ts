import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Symbolicator, fetchMapLoader, type CallFrame } from '@fixpoint/devtools';
import { analyze, type CompilerBailout, type FindingsFile, type Location } from '@fixpoint/analyzer';
import { AppSession, type SessionOptions } from './app-session.js';
import type { FixpointConfig, ScenarioStep } from './config.js';
import { defaultScenario, describeScenario } from './scenario.js';
import { discoverRoutes, routeSlug, type DiscoveredRoute } from './routes.js';
import { collectCompilerBailouts, indexComponents } from './source-index.js';
import { resolveDevice } from './simulator.js';

export interface ScanOptions {
  config: FixpointConfig;
  /** Only these route paths (default: every navigable route). */
  only?: string[];
  outDir?: string;
  log?: (msg: string) => void;
  /** Skip the cold-start startup capture. */
  skipStartup?: boolean;
  /** Skip the React Compiler pass. */
  skipCompiler?: boolean;
}

export interface RouteScanResult {
  route: DiscoveredRoute;
  findingsFile: string;
  traceFile: string;
  screenshot: string;
  findings: FindingsFile;
  error?: string;
}

export interface ScanIndex {
  generatedAt: string;
  metroUrl: string;
  device: string;
  routes: { path: string; file: string; href: string | null; skipped: string | null; findingsFile?: string; top?: { kind: string; metric: string; value: number; severity: string; symbol: string }[]; error?: string }[];
  startup?: { findingsFile: string; modulesInitialized: number; readyMs: number };
  compiler?: { bailouts: number; compiled: number; errors: number; file: string };
}

/** Records and analyses every navigable route against the running dev build. */
export async function scanApp(opts: ScanOptions): Promise<ScanIndex> {
  const cfg = opts.config;
  const log = opts.log ?? (() => undefined);
  const outDir = opts.outDir ?? join(cfg.outDir, 'scan');
  mkdirSync(outDir, { recursive: true });
  const device = resolveDevice(cfg.simulator);
  const metroUrl = cfg.metroUrl ?? `http://localhost:${cfg.metroPort}`;
  const routes = discoverRoutes(cfg.appRoot, cfg);
  const wanted = routes.filter((r) => r.href && (!opts.only?.length || opts.only.includes(r.path) || opts.only.includes(r.href!)));
  log(`${routes.length} routes discovered, ${wanted.length} to scan, ${routes.filter((r) => r.skipped).length} skipped`);

  const componentLocations = indexComponents(cfg.appRoot);
  log(`indexed ${Object.keys(componentLocations).length} component declarations`);
  let compiler: { bailouts: CompilerBailout[] } | undefined;
  let compilerSummary: ScanIndex['compiler'];
  if (!opts.skipCompiler) {
    const t0 = Date.now();
    const res = collectCompilerBailouts(cfg.appRoot);
    compiler = { bailouts: res.bailouts };
    const file = join(outDir, 'compiler-bailouts.json');
    writeFileSync(file, JSON.stringify({ ...res, generatedAt: new Date().toISOString() }, null, 2));
    compilerSummary = { bailouts: res.bailouts.length, compiled: res.compiled, errors: res.errors.length, file };
    log(`React Compiler: ${res.bailouts.length} bailouts in ${res.compiled} files (${Date.now() - t0} ms)`);
  }

  const symbolicator = new Symbolicator(fetchMapLoader(), { rootDir: cfg.appRoot });
  const symbolicate = (frames: CallFrame[]) => symbolicator.frames(frames);
  const sessionOpts: SessionOptions = { device, bundleId: cfg.bundleId, scheme: cfg.scheme, metroUrl, interactions: cfg.interactions, log };
  const index: ScanIndex = { generatedAt: new Date().toISOString(), metroUrl, device: device.name, routes: routes.map((r) => ({ path: r.path, file: r.file, href: r.href, skipped: r.skipped })), compiler: compilerSummary };

  // startup: cold start, capture modules + timing at first-route-ready
  let session: AppSession;
  if (!opts.skipStartup) {
    session = await AppSession.coldStart({ ...sessionOpts, captureStartup: true });
    const s = session.startup!;
    const startupDir = join(outDir, 'startup');
    mkdirSync(startupDir, { recursive: true });
    const firstRouteModule = routes.find((r) => r.path === s.firstRoute)?.file;
    const capture = { ...s, firstRoute: s.firstRoute ?? undefined, firstRouteModule, capturedAt: new Date().toISOString() };
    writeFileSync(join(startupDir, 'startup-capture.json'), JSON.stringify(capture, null, 2));
    const findings = await analyze({ startup: capture, compiler, componentLocations, appRoot: cfg.appRoot, context: { route: 'startup', scenario: 'cold-launch' }, thresholds: cfg.thresholds.analyzer });
    const findingsFile = join(startupDir, 'findings.json');
    writeFileSync(findingsFile, JSON.stringify(findings, null, 2));
    index.startup = { findingsFile, modulesInitialized: s.modulesInitialized.length, readyMs: s.readyMs };
    log(`startup: ${s.modulesInitialized.length} modules initialised, ready in ${s.readyMs} ms`);
  } else {
    session = await AppSession.attach(sessionOpts);
  }

  const home = await session.settleRoute();
  log(`home route ${home}`);
  for (const route of wanted) {
    const entry = index.routes.find((r) => r.path === route.path)!;
    try {
      const result = await scanRoute(session, route, { cfg, outDir, symbolicate, componentLocations, compiler, log, home });
      entry.findingsFile = result.findingsFile;
      entry.top = result.findings.findings.slice(0, 5).map((f) => ({ kind: f.kind, metric: f.metric.name, value: f.metric.value, severity: f.severity, symbol: f.location.symbol }));
    } catch (e) {
      entry.error = (e as Error).message;
      log(`route ${route.path} failed: ${(e as Error).message}`);
      if (!session.alive()) {
        log('app died; cold-starting again');
        session.close();
        session = await AppSession.coldStart({ ...sessionOpts, captureStartup: false });
      }
    }
    writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  }
  session.close();
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  return index;
}

export async function scanRoute(
  session: AppSession,
  route: DiscoveredRoute,
  ctx: { cfg: FixpointConfig; outDir: string; symbolicate: (f: CallFrame[]) => Promise<any>; componentLocations: Record<string, Location>; compiler?: { bailouts: any[] }; log: (m: string) => void; home: string },
): Promise<RouteScanResult> {
  const href = route.href!;
  const slug = routeSlug(route.path);
  const dir = join(ctx.outDir, slug);
  mkdirSync(dir, { recursive: true });
  const scenario: ScenarioStep[] = route.scenario ?? defaultScenario({ settleMs: ctx.cfg.settleMs, back: false });
  ctx.log(`route ${route.path}: warm visit`);
  // visit discipline: the first visit pays module initialisation; measure the second
  await session.navigate(href);
  await new Promise((r) => setTimeout(r, Math.min(ctx.cfg.settleMs, 1500)));
  await goHome(session, ctx.home);
  ctx.log(`route ${route.path}: measured visit (${describeScenario(scenario)})`);
  const screenshot = join(dir, 'settled.png');
  const { trace, marks } = await session.record(scenario, {
    label: route.path,
    before: async () => {
      await session.navigate(href);
      await new Promise((r) => setTimeout(r, ctx.cfg.settleMs));
      session.screenshot(screenshot);
    },
  });
  await goHome(session, ctx.home);
  const traceFile = join(dir, 'trace.json.gz');
  writeFileSync(traceFile, gzipSync(JSON.stringify(trace)));
  const findings = await analyze({ trace, symbolicate: ctx.symbolicate, componentLocations: ctx.componentLocations, compiler: ctx.compiler, appRoot: ctx.cfg.appRoot, context: { route: route.path, scenario: describeScenario(scenario) }, thresholds: ctx.cfg.thresholds.analyzer });
  const findingsFile = join(dir, 'findings.json');
  writeFileSync(findingsFile, JSON.stringify(findings, null, 2));
  writeFileSync(join(dir, 'marks.json'), JSON.stringify(marks, null, 2));
  ctx.log(`route ${route.path}: ${findings.findings.length} findings (${findings.totals.componentRenders} renders, ${findings.totals.wastedRenders} avoidable)`);
  return { route, findingsFile, traceFile, screenshot, findings };
}

async function goHome(session: AppSession, home: string): Promise<void> {
  const current = (await session.routeInfo())?.pathname;
  if (current === home) return;
  const went = await session.back();
  const after = (await session.routeInfo())?.pathname;
  if (!went || after !== home) {
    try {
      await session.navigate(home, 8_000);
    } catch {
      // stay where we are; the next navigate will still work
    }
  }
}

export function readScanIndex(outDir: string): ScanIndex | null {
  const f = join(outDir, 'index.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ScanIndex) : null;
}
