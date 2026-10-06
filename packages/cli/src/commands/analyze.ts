import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CpuProfile, TraceFile } from '@fixpoint/devtools';
import { Symbolicator, normalizeBundleUrl } from '@fixpoint/devtools';
import { analyze, renderTable, type AnalyzeInput } from '@fixpoint/analyzer';

export interface AnalyzeOptions {
  profile?: string;
  heapBefore?: string;
  heapAfter?: string;
  cycles?: string;
  startup?: string;
  compiler?: string;
  map?: string[];
  appRoot?: string;
  route?: string;
  scenario?: string;
  out?: string;
  json?: boolean;
  limit?: string;
}

export async function runAnalyze(traceFile: string | undefined, opts: AnalyzeOptions): Promise<void> {
  const input: AnalyzeInput = { context: { route: opts.route, scenario: opts.scenario }, appRoot: opts.appRoot };
  if (traceFile) input.trace = JSON.parse(readFileSync(resolve(traceFile), 'utf8')) as TraceFile;
  if (opts.profile) input.profile = JSON.parse(readFileSync(resolve(opts.profile), 'utf8')) as CpuProfile;
  if (opts.heapBefore && opts.heapAfter) input.heap = { before: readFileSync(resolve(opts.heapBefore), 'utf8'), after: readFileSync(resolve(opts.heapAfter), 'utf8'), cycles: Number(opts.cycles ?? 1) };
  if (opts.startup) input.startup = JSON.parse(readFileSync(resolve(opts.startup), 'utf8'));
  if (opts.compiler) input.compiler = JSON.parse(readFileSync(resolve(opts.compiler), 'utf8'));
  if (opts.map?.length) {
    // --map <bundleUrl>=<file.map> or a bare file (applied to the bundle URL found in the trace)
    const sym = new Symbolicator(async () => null, { rootDir: opts.appRoot });
    for (const spec of opts.map) {
      const eq = spec.indexOf('=');
      const file = eq >= 0 ? spec.slice(eq + 1) : spec;
      let url = eq >= 0 ? spec.slice(0, eq) : null;
      if (!url && input.trace) url = bundleUrlFromTrace(input.trace);
      if (!url) throw new Error(`--map ${spec}: no bundle URL could be inferred; use --map <bundleUrl>=<file>`);
      sym.addMap(normalizeBundleUrl(url), JSON.parse(readFileSync(resolve(file), 'utf8')));
    }
    input.symbolicate = (frames) => sym.frames(frames);
  }
  if (!input.trace && !input.startup && !input.heap && !input.compiler) throw new Error('nothing to analyze: pass a trace file or --startup/--heap-before/--compiler inputs');
  const result = await analyze(input);
  if (opts.out) {
    writeFileSync(resolve(opts.out), JSON.stringify(result, null, 2));
  }
  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(renderTable(result, Number(opts.limit ?? 30)) + '\n');
  if (opts.out) process.stderr.write(`wrote ${resolve(opts.out)}\n`);
}

function bundleUrlFromTrace(trace: TraceFile): string | null {
  for (const e of trace.traceEvents) {
    if (e.name !== 'ProfileChunk') continue;
    for (const n of e.args?.data?.cpuProfile?.nodes ?? []) if (typeof n.callFrame?.url === 'string' && n.callFrame.url.includes('.bundle')) return n.callFrame.url;
  }
  return null;
}

export function registerAnalyze(program: Command): void {
  program
    .command('analyze [trace]')
    .description('Reduce a recording to ranked findings (pure, offline)')
    .option('--profile <file>', 'separate .cpuprofile to use for sampling data')
    .option('--heap-before <file>', 'heap snapshot taken before navigate-and-back cycles')
    .option('--heap-after <file>', 'heap snapshot taken after the cycles')
    .option('--cycles <n>', 'number of navigate-and-back cycles between the snapshots', '1')
    .option('--startup <file>', 'startup capture JSON (modules initialised, rnStartupTiming)')
    .option('--compiler <file>', 'React Compiler bailout JSON')
    .option('--map <spec...>', 'source map file, or <bundleUrl>=<file>, for symbolication')
    .option('--app-root <dir>', 'app root used to recognise app code in paths')
    .option('--route <route>', 'route label for the findings context')
    .option('--scenario <name>', 'scenario label for the findings context')
    .option('--out <file>', 'write findings.json here')
    .option('--json', 'print findings.json instead of the table')
    .option('--limit <n>', 'rows in the table', '30')
    .action(async (trace: string | undefined, opts: AnalyzeOptions) => {
      if (opts.map && !existsSync(resolve(opts.map[0]!.includes('=') ? opts.map[0]!.split('=')[1]! : opts.map[0]!))) throw new Error(`map file not found: ${opts.map[0]}`);
      await runAnalyze(trace, opts);
    });
}
