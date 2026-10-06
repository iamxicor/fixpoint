import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { FindingsFile } from '@fixpoint/analyzer';
import { renderTable } from '@fixpoint/analyzer';
import { compareBaseline, loadConfig, prBody, prTitle, prepareWorktree, readScanIndex, renderResults, runAb, runGates, scanApp, startMetro, validateScenario, visitMetrics, writeBaseline, type GatesReport, type Verdict } from '@fixpoint/harness';
import { gunzipSync } from 'node:zlib';

const log = (m: string) => process.stderr.write(`[fixpoint] ${m}\n`);

export function registerRun(program: Command): void {
  program
    .command('scan [route]')
    .description('Record and analyse every route (or one) against the running dev build')
    .option('--dir <dir>', 'app directory', '.')
    .option('--skip-startup', 'do not cold-start for the startup capture')
    .option('--skip-compiler', 'do not run the React Compiler pass')
    .option('--metro <url>', 'Metro URL to use instead of the configured one')
    .option('--json', 'print the scan index as JSON')
    .action(async (route: string | undefined, opts) => {
      const { config } = await loadConfig(resolve(opts.dir));
      if (opts.metro) config.metroUrl = opts.metro;
      const index = await scanApp({ config, only: route ? [route] : undefined, log, skipStartup: !!opts.skipStartup, skipCompiler: !!opts.skipCompiler });
      if (opts.json) return void process.stdout.write(JSON.stringify(index, null, 2) + '\n');
      for (const r of index.routes) {
        if (!r.findingsFile) continue;
        const f = JSON.parse(readFileSync(r.findingsFile, 'utf8')) as FindingsFile;
        process.stdout.write(`\n== ${r.path}\n${renderTable(f, 8)}\n`);
      }
      if (index.startup) {
        const f = JSON.parse(readFileSync(index.startup.findingsFile, 'utf8')) as FindingsFile;
        process.stdout.write(`\n== startup\n${renderTable(f, 5)}\n`);
      }
      process.stdout.write(`\nscan index: ${join(config.outDir, 'scan', 'index.json')}\n`);
    });

  program
    .command('serve')
    .description('Prepare a worktree for a git ref and run Metro for it on a port (foreground; Ctrl-C stops it)')
    .requiredOption('--ref <ref>', 'git ref to serve')
    .option('--port <n>', 'Metro port', '8091')
    .option('--dir <dir>', 'app directory', '.')
    .option('--name <name>', 'worktree name under the cache dir', 'serve')
    .action(async (opts) => {
      const { config } = await loadConfig(resolve(opts.dir));
      const wt = await prepareWorktree({ repo: config.appRoot, ref: opts.ref, dir: join(config.outDir, 'worktrees', opts.name) });
      log(`worktree ${wt.dir} at ${wt.sha.slice(0, 8)}`);
      const metro = await startMetro({ appRoot: wt.dir, port: Number(opts.port), logFile: join(config.outDir, `metro-${opts.name}.log`), onLine: (l) => process.stderr.write(`[metro] ${l}\n`) });
      process.stdout.write(JSON.stringify({ url: metro.url, worktree: wt.dir, sha: wt.sha, pid: metro.pid }) + '\n');
      const stop = async () => {
        await metro.stop();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await new Promise(() => undefined);
    });

  program
    .command('findings [route]')
    .description('Print the latest scan findings (all routes or one)')
    .option('--dir <dir>', 'app directory', '.')
    .option('--json', 'print findings.json')
    .option('--limit <n>', 'rows', '15')
    .action(async (route: string | undefined, opts) => {
      const { config } = await loadConfig(resolve(opts.dir));
      const index = readScanIndex(join(config.outDir, 'scan'));
      if (!index) throw new Error('no scan yet; run `fixpoint scan`');
      const rows = index.routes.filter((r) => r.findingsFile && (!route || r.path === route || r.href === route));
      if (route === 'startup' && index.startup) rows.push({ path: 'startup', file: '', href: null, skipped: null, findingsFile: index.startup.findingsFile });
      if (opts.json) return void process.stdout.write(JSON.stringify(rows.map((r) => ({ route: r.path, findings: JSON.parse(readFileSync(r.findingsFile!, 'utf8')) })), null, 2) + '\n');
      for (const r of rows) process.stdout.write(`\n== ${r.path}\n${renderTable(JSON.parse(readFileSync(r.findingsFile!, 'utf8')) as FindingsFile, Number(opts.limit))}\n`);
    });

  const abLike = (name: 'ab' | 'aa') =>
    program
      .command(name)
      .description(name === 'ab' ? 'Interleaved A/B of a candidate ref against a base ref on one route' : 'A/A calibration: base against base, records the noise floor')
      .requiredOption('--route <path>', 'route path, e.g. /notifications')
      .requiredOption('--base <ref>', 'base git ref (branch, tag, sha)')
      .option('--candidate <ref>', 'candidate git ref (A/B only)')
      .option('--pairs <n>', 'number of measured pairs')
      .option('--video', 'record a side-by-side video of the diagnostic pair')
      .option('--scenario <json>', 'scenario steps as JSON (read-only step types only)')
      .option('--dir <dir>', 'app directory', '.')
      .option('--publish-to <dir>', 'copy the verdict JSON into this directory as well (e.g. docs/results)')
      .action(async (opts) => {
        const { config } = await loadConfig(resolve(opts.dir));
        if (name === 'ab' && !opts.candidate) throw new Error('--candidate is required for ab');
        const scenario = opts.scenario ? validateScenario(JSON.parse(opts.scenario)) : undefined;
        const verdict = await runAb({ config, mode: name, route: opts.route, baseRef: opts.base, candidateRef: opts.candidate, pairs: opts.pairs ? Number(opts.pairs) : undefined, video: !!opts.video, scenario, log });
        const file = join(verdict.artifacts.dir, 'verdict.json');
        if (opts.publishTo) {
          mkdirSync(resolve(opts.publishTo), { recursive: true });
          const dest = join(resolve(opts.publishTo), `${name === 'aa' ? 'aa-' : ''}${verdict.route.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-') || 'index'}-${verdict.generatedAt.replace(/[:.]/g, '-')}.json`);
          copyFileSync(file, dest);
          log(`published ${dest}`);
        }
        process.stdout.write(JSON.stringify({ verdict: verdict.verdict, reasons: verdict.reasons, route: verdict.route, pairs: verdict.pairs, deterministicDeltas: verdict.deterministicDeltas.map((d) => ({ metric: d.metric, medianDelta: d.medianDelta, unanimous: d.unanimous })), timeDelta: { relativeMedian: verdict.timeDelta.relativeMedian, ci95: verdict.timeDelta.relativeCi95, p: verdict.timeDelta.p }, noiseFloor: verdict.noiseFloor.time, controlFramesOk: verdict.controlFramesOk, pixelDiff: verdict.pixelDiff, file, video: verdict.artifacts.video }, null, 2) + '\n');
        if (verdict.verdict !== 'accept') process.exitCode = 2;
      });
  abLike('ab');
  abLike('aa');

  program
    .command('gates')
    .description('Run typecheck, lint, tests and the pixel gate for a candidate checkout')
    .option('--dir <dir>', 'candidate app directory', '.')
    .option('--verdict <file>', 'verdict JSON; its screenshots and A/B verdict feed the gates')
    .option('--skip-tests', 'skip the app test suite')
    .option('--out <file>', 'write the gates report JSON here')
    .action(async (opts) => {
      let pixel: { base: string; candidate: string; diffOut?: string } | undefined;
      let abVerdict: Verdict['verdict'] | undefined;
      if (opts.verdict) {
        const v = JSON.parse(readFileSync(resolve(opts.verdict), 'utf8')) as Verdict;
        const [a, b] = v.artifacts.screenshots;
        if (a && b && existsSync(a) && existsSync(b)) pixel = { base: a, candidate: b, diffOut: join(v.artifacts.dir, 'pixel-diff.png') };
        abVerdict = v.verdict;
      }
      const report = runGates({ appDir: resolve(opts.dir), pixel, abVerdict, skipTests: !!opts.skipTests });
      if (opts.out) writeFileSync(resolve(opts.out), JSON.stringify(report, null, 2));
      for (const g of report.gates) process.stdout.write(`${g.ok ? '✓' : '✗'} ${g.name}${g.skipped ? ` (skipped: ${g.skipped})` : ''} ${g.name === 'pixel-diff' || g.name === 'ab-verdict' ? g.output : `${Math.round(g.durationMs / 1000)}s`}\n${g.ok || !g.output ? '' : indent(g.output)}`);
      process.stdout.write(report.ok ? 'all gates passed\n' : 'gates failed\n');
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command('pr-body')
    .description('Render the pull request title and body for an accepted fix')
    .requiredOption('--verdict <file>', 'verdict JSON')
    .requiredOption('--findings <file>', 'findings.json the fix was chosen from')
    .requiredOption('--finding <id>', 'finding id')
    .requiredOption('--recipe <id>', 'fix recipe id')
    .option('--gates <file>', 'gates report JSON')
    .option('--description <text>', 'one-line description of the change', '')
    .option('--video-url <url>', 'public URL of the side-by-side video')
    .option('--out <file>', 'write the body to this file (title goes to stdout)')
    .action((opts) => {
      const verdict = JSON.parse(readFileSync(resolve(opts.verdict), 'utf8')) as Verdict;
      const findings = JSON.parse(readFileSync(resolve(opts.findings), 'utf8')) as FindingsFile;
      const finding = findings.findings.find((f) => f.id === opts.finding);
      if (!finding) throw new Error(`finding ${opts.finding} not in ${opts.findings}`);
      const gates: GatesReport = opts.gates ? JSON.parse(readFileSync(resolve(opts.gates), 'utf8')) : { ok: true, gates: [] };
      const input = { route: verdict.route, finding, recipeId: opts.recipe, verdict, gates, fixDescription: opts.description, videoUrl: opts.videoUrl };
      const body = prBody(input);
      if (opts.out) {
        writeFileSync(resolve(opts.out), body);
        process.stdout.write(prTitle(input) + '\n');
      } else process.stdout.write(`${prTitle(input)}\n\n${body}`);
    });

  program
    .command('baseline <action>')
    .description('write: store per-route deterministic metrics from the latest scan; check: compare the latest scan against the stored baseline')
    .option('--dir <dir>', 'app directory', '.')
    .option('--file <file>', 'baseline file', 'fixpoint-baseline.json')
    .action(async (action: string, opts) => {
      const { config } = await loadConfig(resolve(opts.dir));
      const index = readScanIndex(join(config.outDir, 'scan'));
      if (!index) throw new Error('no scan yet; run `fixpoint scan`');
      const current: Record<string, ReturnType<typeof visitMetrics>> = {};
      for (const r of index.routes) {
        if (!r.findingsFile) continue;
        const traceFile = join(r.findingsFile, '..', 'trace.json.gz');
        if (!existsSync(traceFile)) continue;
        current[r.path] = visitMetrics(JSON.parse(gunzipSync(readFileSync(traceFile)).toString()));
      }
      const file = resolve(opts.dir, opts.file);
      if (action === 'write') {
        writeBaseline(file, current);
        process.stdout.write(`wrote ${file} (${Object.keys(current).length} routes)\n`);
      } else if (action === 'check') {
        const r = compareBaseline(file, current);
        for (const x of r.regressions) process.stdout.write(`✗ ${x.route} ${x.metric}: ${x.baseline} → ${x.current}\n`);
        for (const m of r.missing) process.stdout.write(`! ${m}: not in baseline\n`);
        process.stdout.write(r.ok ? 'no deterministic regressions\n' : `${r.regressions.length} regression(s)\n`);
        if (!r.ok) process.exitCode = 1;
      } else throw new Error('action must be write or check');
    });

  program
    .command('report')
    .description('Render RESULTS markdown from verdict files and the latest scan')
    .option('--dir <dir>', 'app directory', '.')
    .option('--results <dir>', 'directory with verdict JSON files (default: config resultsDir)')
    .option('--out <file>', 'write markdown here instead of stdout')
    .option('--link-base <dir>', 'make file links relative to this directory')
    .option('--title <text>', 'page title', 'Results')
    .action(async (opts) => {
      const { config } = await loadConfig(resolve(opts.dir));
      const md = renderResults({ resultsDir: opts.results ? resolve(opts.results) : config.resultsDir, scanDir: join(config.outDir, 'scan'), linkBase: opts.linkBase ? resolve(opts.linkBase) : opts.out ? resolve(opts.out, '..') : undefined, title: opts.title });
      if (opts.out) {
        writeFileSync(resolve(opts.out), md);
        process.stdout.write(`wrote ${resolve(opts.out)}\n`);
      } else process.stdout.write(md);
    });
}

const indent = (s: string) => s.split('\n').slice(-40).map((l) => `    ${l}`).join('\n') + '\n';
void basename;
