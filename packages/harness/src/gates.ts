import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface GateResult {
  name: string;
  ok: boolean;
  skipped?: string;
  command?: string;
  durationMs: number;
  output: string;
}

export interface GatesReport {
  ok: boolean;
  gates: GateResult[];
}

function run(name: string, cmd: string, args: string[], cwd: string, timeoutMs: number): GateResult {
  const t0 = Date.now();
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    return { name, ok: true, command: `${cmd} ${args.join(' ')}`, durationMs: Date.now() - t0, output: tail(out) };
  } catch (e: any) {
    return { name, ok: false, command: `${cmd} ${args.join(' ')}`, durationMs: Date.now() - t0, output: tail(`${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`) };
  }
}

const tail = (s: string, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s);

/** Picks the app's own scripts for typecheck, lint and tests; the tests are skipped when they watch. */
export function detectCommands(appDir: string): { typecheck: string[] | null; lint: string[] | null; test: string[] | null } {
  const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const pick = (names: string[]) => names.find((n) => scripts[n]);
  const tc = pick(['type-check', 'typecheck', 'tsc', 'types']);
  const lint = pick(['lint']);
  const test = pick(['test', 'test:unit']);
  const runner = existsSync(join(appDir, 'yarn.lock')) ? ['yarn', '-s'] : existsSync(join(appDir, 'pnpm-lock.yaml')) ? ['pnpm', '-s'] : ['npm', 'run', '-s'];
  const script = (name: string) => (runner[0] === 'npm' ? [...runner, name] : [...runner, name]);
  let testCmd: string[] | null = null;
  if (test) {
    const body = scripts[test]!;
    testCmd = /--watch/.test(body) ? ['npx', 'jest', '--ci', '--silent'] : script(test);
  } else if (existsSync(join(appDir, 'jest.config.js')) || existsSync(join(appDir, 'jest.config.ts'))) testCmd = ['npx', 'jest', '--ci', '--silent'];
  return { typecheck: tc ? script(tc) : existsSync(join(appDir, 'tsconfig.json')) ? ['npx', 'tsc', '--noEmit'] : null, lint: lint ? script(lint) : null, test: testCmd };
}

export interface RunGatesOptions {
  appDir: string;
  pixel?: { base: string; candidate: string; diffOut?: string; maxRatio?: number };
  abVerdict?: 'accept' | 'reject' | 'inconclusive';
  timeoutMs?: number;
  skipTests?: boolean;
}

export function runGates(opts: RunGatesOptions): GatesReport {
  const cmds = detectCommands(opts.appDir);
  const timeout = opts.timeoutMs ?? 900_000;
  const gates: GateResult[] = [];
  gates.push(cmds.typecheck ? run('typecheck', cmds.typecheck[0]!, cmds.typecheck.slice(1), opts.appDir, timeout) : { name: 'typecheck', ok: true, skipped: 'no typecheck script', durationMs: 0, output: '' });
  gates.push(cmds.lint ? run('lint', cmds.lint[0]!, cmds.lint.slice(1), opts.appDir, timeout) : { name: 'lint', ok: true, skipped: 'no lint script', durationMs: 0, output: '' });
  if (opts.skipTests) gates.push({ name: 'tests', ok: true, skipped: 'skipped by request', durationMs: 0, output: '' });
  else gates.push(cmds.test ? run('tests', cmds.test[0]!, cmds.test.slice(1), opts.appDir, timeout) : { name: 'tests', ok: true, skipped: 'no runnable test script', durationMs: 0, output: '' });
  if (opts.pixel) {
    const t0 = Date.now();
    try {
      const r = pixelDiff(opts.pixel.base, opts.pixel.candidate, opts.pixel.diffOut);
      const max = opts.pixel.maxRatio ?? 0.005;
      gates.push({ name: 'pixel-diff', ok: r.ratio <= max, durationMs: Date.now() - t0, output: `${(r.ratio * 100).toFixed(3)}% of pixels differ (max ${(max * 100).toFixed(1)}%)` });
    } catch (e) {
      gates.push({ name: 'pixel-diff', ok: false, durationMs: Date.now() - t0, output: (e as Error).message });
    }
  }
  if (opts.abVerdict) gates.push({ name: 'ab-verdict', ok: opts.abVerdict === 'accept', durationMs: 0, output: opts.abVerdict });
  return { ok: gates.every((g) => g.ok), gates };
}

/** Fraction of differing pixels between two PNG screenshots of the same size. */
export function pixelDiff(baseFile: string, candidateFile: string, diffOut?: string): { ratio: number; differing: number; total: number; ok: boolean } {
  const a = PNG.sync.read(readFileSync(baseFile));
  const b = PNG.sync.read(readFileSync(candidateFile));
  if (a.width !== b.width || a.height !== b.height) throw new Error(`screenshot sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const diff = new PNG({ width: a.width, height: a.height });
  const differing = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  if (diffOut) writeFileSync(diffOut, PNG.sync.write(diff));
  const total = a.width * a.height;
  const ratio = differing / total;
  return { ratio, differing, total, ok: ratio <= 0.005 };
}
