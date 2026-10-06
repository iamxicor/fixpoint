import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { FindingsFile } from '@fixpoint/analyzer';
import { renderTable } from '@fixpoint/analyzer';
import { DevToolsClient, listTargets, metroStatus, pickTarget } from '@fixpoint/devtools';
import { COMPONENTS_TRACK, SCHEDULER_GROUP } from '@fixpoint/analyzer';
import { discoverRoutes, loadConfig, prBody, prTitle, readScanIndex, renderResults, resolveDevice, runAb, runGates, scanApp, validateScenario, visitMetrics, writeBaseline, type FixpointConfig, type GatesReport, type Verdict } from '@fixpoint/harness';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));

/** Builds the Fixpoint MCP server. Every tool is a thin wrapper over the harness; any agent can drive it. */
export function createServer(opts: { appDir?: string } = {}): McpServer {
  const appDir = resolve(opts.appDir ?? process.env.FIXPOINT_APP_DIR ?? process.cwd());
  const server = new McpServer({ name: 'fixpoint', version: '0.1.0' });
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(`${new Date().toISOString().slice(11, 19)} ${m}`);
    if (logs.length > 500) logs.shift();
  };
  const cfg = async (): Promise<FixpointConfig> => (await loadConfig(appDir)).config;

  server.registerTool(
    'fixpoint_verify',
    { title: 'Verify the Fixpoint setup', description: 'Checks simulator, Metro, inspector target, debugger socket, Expo Router probe and a two-second trace with React tracks. Returns a checklist.', inputSchema: {} },
    async () => {
      const config = await cfg();
      const results: Record<string, { ok: boolean; detail: string }> = {};
      const check = (k: string, ok: boolean, detail: string) => (results[k] = { ok, detail });
      try {
        const device = resolveDevice(config.simulator);
        check('simulator', true, `${device.name} (${device.udid})`);
        const metroUrl = config.metroUrl ?? `http://localhost:${config.metroPort}`;
        const status = await metroStatus(metroUrl);
        check('metro', status.status === 'running', `${metroUrl} ${status.status}`);
        if (status.status === 'running') {
          const targets = await listTargets(metroUrl);
          const target = pickTarget(targets, { deviceName: device.name, appId: config.bundleId || undefined });
          check('target', !!target, target?.id ?? `none for ${device.name} (${targets.length} targets)`);
          if (target) {
            const client = await DevToolsClient.connectTo(target, { metroUrl });
            try {
              const route = await client.expoRouter.routeInfo();
              check('router', !!route, route?.pathname ?? 'unavailable');
              const trace = await client.tracing.record({ durationMs: 2000 });
              const stamps = trace.traceEvents.filter((e) => e.name === 'TimeStamp');
              check('react-tracks', stamps.some((e) => e.args?.data?.trackGroup === SCHEDULER_GROUP), `${stamps.filter((e) => e.args?.data?.track === COMPONENTS_TRACK).length} component entries, ${stamps.filter((e) => e.args?.data?.trackGroup === SCHEDULER_GROUP).length} scheduler entries`);
              check('sampling', trace.traceEvents.some((e) => e.name === 'ProfileChunk'), 'sampling profiler in trace');
            } finally {
              client.disconnect();
            }
          }
        }
      } catch (e) {
        check('error', false, (e as Error).message);
      }
      return json({ ok: Object.values(results).every((r) => r.ok), results, label: 'dev build, iOS Simulator' });
    },
  );

  server.registerTool(
    'fixpoint_routes',
    { title: 'List routes', description: 'Expo Router routes Fixpoint can navigate, with skip reasons.', inputSchema: {} },
    async () => json(discoverRoutes((await cfg()).appRoot, await cfg())),
  );

  server.registerTool(
    'fixpoint_scan',
    {
      title: 'Scan routes',
      description: 'Record and analyse every navigable route (or one) against the running dev build. Writes findings.json per route under .fixpoint/scan and returns a summary. Takes a few minutes for a whole app.',
      inputSchema: { route: z.string().optional().describe('Route path to scan; omit for all'), skipStartup: z.boolean().optional(), skipCompiler: z.boolean().optional() },
    },
    async ({ route, skipStartup, skipCompiler }) => {
      const config = await cfg();
      const index = await scanApp({ config, only: route ? [route] : undefined, log, skipStartup, skipCompiler });
      return json({ index, log: logs.slice(-40) });
    },
  );

  server.registerTool(
    'fixpoint_findings',
    { title: 'Read findings', description: 'Ranked findings from the latest scan, for one route or all. Returns findings.json content; the agent reasons over this, never over raw traces.', inputSchema: { route: z.string().optional(), limit: z.number().int().positive().optional().describe('max findings per route'), table: z.boolean().optional().describe('return the text table instead of JSON') } },
    async ({ route, limit, table }) => {
      const config = await cfg();
      const index = readScanIndex(join(config.outDir, 'scan'));
      if (!index) return text('No scan yet. Run fixpoint_scan first.');
      const rows = index.routes.filter((r) => r.findingsFile && (!route || r.path === route || r.href === route));
      if ((!route || route === 'startup') && index.startup) rows.push({ path: 'startup', file: '', href: null, skipped: null, findingsFile: index.startup.findingsFile });
      const out = rows.map((r) => {
        const f = JSON.parse(readFileSync(r.findingsFile!, 'utf8')) as FindingsFile;
        return { route: r.path, findingsFile: r.findingsFile, totals: f.totals, notes: f.notes, findings: f.findings.slice(0, limit ?? 10), table: table ? renderTable(f, limit ?? 10) : undefined };
      });
      return json(out);
    },
  );

  server.registerTool(
    'fixpoint_ab',
    {
      title: 'Interleaved A/B',
      description: 'Measure candidateRef against baseRef on one route: two worktrees, two Metro servers, one simulator, A B A B …, deterministic counts compared exactly, time with a 95% CI, noise floor from an A/A (run automatically when missing), control-frame check, pixel diff. Returns the verdict (accept | reject | inconclusive) and the verdict file path. Takes 5–15 minutes.',
      inputSchema: { candidateRef: z.string(), route: z.string(), baseRef: z.string().optional().describe('default: main'), pairs: z.number().int().positive().optional(), video: z.boolean().optional(), scenario: z.array(z.any()).optional().describe('read-only scenario steps'), publishTo: z.string().optional().describe('directory to copy the verdict JSON into, e.g. docs/results of the Fixpoint repo') },
    },
    async ({ candidateRef, route, baseRef, pairs, video, scenario, publishTo }) => {
      const config = await cfg();
      const verdict = await runAb({ config, mode: 'ab', route, baseRef: baseRef ?? 'main', candidateRef, pairs, video, scenario: scenario ? validateScenario(scenario) : undefined, log });
      const file = join(verdict.artifacts.dir, 'verdict.json');
      let published: string | null = null;
      if (publishTo) {
        const dest = join(resolve(publishTo), `${verdict.route.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-') || 'index'}-${verdict.generatedAt.replace(/[:.]/g, '-')}.json`);
        writeFileSync(dest, JSON.stringify(verdict, null, 2));
        published = dest;
      }
      return json({ verdict: verdict.verdict, reasons: verdict.reasons, deterministicDeltas: verdict.deterministicDeltas.map((d) => ({ metric: d.metric, medianDelta: d.medianDelta, unanimous: d.unanimous, exact: d.exact })), timeDelta: { relativeMedian: verdict.timeDelta.relativeMedian, ci95: verdict.timeDelta.relativeCi95, p: verdict.timeDelta.p }, noiseFloor: verdict.noiseFloor, controlFramesOk: verdict.controlFramesOk, pixelDiff: verdict.pixelDiff, pairs: verdict.pairs, file, published, video: verdict.artifacts.video, screenshots: verdict.artifacts.screenshots, foreignEvents: verdict.environment.foreignEvents, log: logs.slice(-30) });
    },
  );

  server.registerTool(
    'fixpoint_aa',
    { title: 'A/A calibration', description: 'Base against base on one route. Records the noise floor the A/B threshold is derived from. A significant A/A difference fails the harness.', inputSchema: { route: z.string(), baseRef: z.string().optional(), pairs: z.number().int().positive().optional() } },
    async ({ route, baseRef, pairs }) => {
      const config = await cfg();
      const v = await runAb({ config, mode: 'aa', route, baseRef: baseRef ?? 'main', pairs, log });
      return json({ verdict: v.verdict, harnessFailed: v.harnessFailed, noiseFloor: v.noiseFloor, reasons: v.reasons, file: join(v.artifacts.dir, 'verdict.json') });
    },
  );

  server.registerTool(
    'fixpoint_gates',
    { title: 'Run gates', description: 'typecheck, lint, existing tests, pixel diff (from a verdict file) and the A/B verdict. All must pass before a PR.', inputSchema: { candidateDir: z.string().describe('checkout to check (worktree or branch dir)'), verdictFile: z.string().optional(), skipTests: z.boolean().optional(), out: z.string().optional() } },
    async ({ candidateDir, verdictFile, skipTests, out }) => {
      let pixel: { base: string; candidate: string; diffOut?: string } | undefined;
      let abVerdict: Verdict['verdict'] | undefined;
      if (verdictFile) {
        const v = JSON.parse(readFileSync(resolve(verdictFile), 'utf8')) as Verdict;
        const [a, b] = v.artifacts.screenshots;
        if (a && b && existsSync(a) && existsSync(b)) pixel = { base: a, candidate: b, diffOut: join(v.artifacts.dir, 'pixel-diff.png') };
        abVerdict = v.verdict;
      }
      const report = runGates({ appDir: resolve(candidateDir), pixel, abVerdict, skipTests });
      if (out) writeFileSync(resolve(out), JSON.stringify(report, null, 2));
      return json(report);
    },
  );

  server.registerTool(
    'fixpoint_pr_body',
    { title: 'PR title and body', description: 'Renders the pull request title and body (finding, recipe, deterministic deltas, time delta with CI, noise floor, gates, artifacts) from a verdict, findings file and gates report.', inputSchema: { verdictFile: z.string(), findingsFile: z.string(), findingId: z.string(), recipeId: z.string(), gatesFile: z.string().optional(), description: z.string().optional(), videoUrl: z.string().optional() } },
    async ({ verdictFile, findingsFile, findingId, recipeId, gatesFile, description, videoUrl }) => {
      const verdict = JSON.parse(readFileSync(resolve(verdictFile), 'utf8')) as Verdict;
      const findings = JSON.parse(readFileSync(resolve(findingsFile), 'utf8')) as FindingsFile;
      const finding = findings.findings.find((f) => f.id === findingId);
      if (!finding) return text(`finding ${findingId} not found in ${findingsFile}`);
      const gates: GatesReport = gatesFile ? JSON.parse(readFileSync(resolve(gatesFile), 'utf8')) : { ok: true, gates: [] };
      const input = { route: verdict.route, finding, recipeId, verdict, gates, fixDescription: description ?? '', videoUrl };
      return json({ title: prTitle(input), body: prBody(input) });
    },
  );

  server.registerTool(
    'fixpoint_baseline',
    { title: 'Write baseline', description: 'Stores the deterministic metrics of the latest scan per route for the CI regression guard (`fixpoint baseline check`).', inputSchema: { file: z.string().optional() } },
    async ({ file }) => {
      const config = await cfg();
      const index = readScanIndex(join(config.outDir, 'scan'));
      if (!index) return text('No scan yet.');
      const current: Record<string, ReturnType<typeof visitMetrics>> = {};
      for (const r of index.routes) {
        const traceFile = r.findingsFile ? join(r.findingsFile, '..', 'trace.json.gz') : null;
        if (traceFile && existsSync(traceFile)) current[r.path] = visitMetrics(JSON.parse(gunzipSync(readFileSync(traceFile)).toString()));
      }
      const target = resolve(appDir, file ?? 'fixpoint-baseline.json');
      return json(writeBaseline(target, current));
    },
  );

  server.registerTool(
    'fixpoint_report',
    { title: 'Render results', description: 'Markdown report from every verdict file (accepted, rejected and inconclusive) and the latest scan.', inputSchema: { resultsDir: z.string().optional(), out: z.string().optional(), linkBase: z.string().optional() } },
    async ({ resultsDir, out, linkBase }) => {
      const config = await cfg();
      const md = renderResults({ resultsDir: resultsDir ? resolve(resultsDir) : config.resultsDir, scanDir: join(config.outDir, 'scan'), linkBase: linkBase ? resolve(linkBase) : undefined });
      if (out) writeFileSync(resolve(out), md);
      return text(md);
    },
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
