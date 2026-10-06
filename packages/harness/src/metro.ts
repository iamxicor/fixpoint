import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metroStatus } from '@fixpoint/devtools';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function devClientUrl(scheme: string, metroUrl: string): string {
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}`;
}

export interface MetroHandle {
  url: string;
  port: number;
  pid: number | undefined;
  logFile: string | null;
  stop: () => Promise<void>;
}

export interface StartMetroOptions {
  appRoot: string;
  port: number;
  env?: Record<string, string>;
  logFile?: string;
  timeoutMs?: number;
  onLine?: (line: string) => void;
}

/** Spawns `expo start --dev-client --port N` non-interactively and waits for `/status`. */
export async function startMetro(opts: StartMetroOptions): Promise<MetroHandle> {
  const expoBin = join(opts.appRoot, 'node_modules', '.bin', 'expo');
  if (!existsSync(expoBin)) throw new Error(`expo CLI not found at ${expoBin}; install the app's dependencies first`);
  const url = `http://127.0.0.1:${opts.port}`;
  const existing = await metroStatus(url, 1500);
  if (existing.status === 'running') throw new Error(`Port ${opts.port} already serves a Metro; stop it or choose another port`);
  const env = { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOCTOR: '1', BROWSER: 'none', RCT_METRO_PORT: String(opts.port), ...(opts.env ?? {}) };
  const proc: ChildProcess = spawn(expoBin, ['start', '--dev-client', '--port', String(opts.port)], { cwd: opts.appRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log: ReturnType<typeof createWriteStream> | null = null;
  if (opts.logFile) {
    mkdirSync(join(opts.logFile, '..'), { recursive: true });
    log = createWriteStream(opts.logFile, { flags: 'a' });
  }
  const onData = (d: Buffer) => {
    const text = d.toString();
    log?.write(text);
    if (opts.onLine) for (const line of text.split('\n')) if (line.trim()) opts.onLine(line);
  };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  let exited = false;
  proc.once('exit', () => (exited = true));
  const t0 = Date.now();
  while (Date.now() - t0 < (opts.timeoutMs ?? 120_000)) {
    if (exited) throw new Error(`Metro on port ${opts.port} exited early; see ${opts.logFile ?? 'its output'}`);
    const s = await metroStatus(url, 1500);
    if (s.status === 'running') break;
    await sleep(500);
  }
  if ((await metroStatus(url, 1500)).status !== 'running') {
    killTree(proc);
    throw new Error(`Metro on port ${opts.port} did not become ready within ${opts.timeoutMs ?? 120_000} ms`);
  }
  return {
    url,
    port: opts.port,
    pid: proc.pid,
    logFile: opts.logFile ?? null,
    stop: async () => {
      killTree(proc);
      await sleep(300);
      log?.end();
    },
  };
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  setTimeout(() => {
    try {
      if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }, 3_000).unref();
}

// ---- worktrees --------------------------------------------------------------------------------------

export interface WorktreeOptions {
  repo: string;
  ref: string;
  dir: string;
  /** Files copied from the main checkout when present (dev env files are usually git-ignored). */
  copyFiles?: string[];
  /** Clone node_modules from the main checkout with APFS clonefile (instant) when the worktree has none. */
  cloneNodeModules?: boolean;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function resolveRef(repo: string, ref: string): string {
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

export function changedFiles(repo: string, baseRef: string, candidateRef: string): string[] {
  const out = git(repo, ['diff', '--name-only', `${baseRef}...${candidateRef}`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Creates or updates a detached worktree at `dir` for `ref`, with env files and node_modules in place. */
export async function prepareWorktree(opts: WorktreeOptions): Promise<{ dir: string; sha: string }> {
  const sha = resolveRef(opts.repo, opts.ref);
  const list = git(opts.repo, ['worktree', 'list', '--porcelain']);
  const registered = list.split('\n').some((l) => l === `worktree ${opts.dir}`);
  if (registered && existsSync(join(opts.dir, '.git'))) {
    git(opts.dir, ['checkout', '--detach', '--force', sha]);
    git(opts.dir, ['clean', '-fdq', '--exclude=node_modules', '--exclude=.env*', '--exclude=.fixpoint']);
  } else {
    if (registered) git(opts.repo, ['worktree', 'prune']);
    mkdirSync(join(opts.dir, '..'), { recursive: true });
    git(opts.repo, ['worktree', 'add', '--detach', '--force', opts.dir, sha]);
  }
  for (const f of opts.copyFiles ?? ['.env.development.local', '.env.local', '.env']) {
    const src = join(opts.repo, f);
    if (existsSync(src)) copyFileSync(src, join(opts.dir, f));
  }
  const nm = join(opts.dir, 'node_modules');
  if ((opts.cloneNodeModules ?? true) && !existsSync(join(nm, '.bin', 'expo'))) {
    const src = join(opts.repo, 'node_modules');
    if (!existsSync(src)) throw new Error(`${src} does not exist; install the app's dependencies first`);
    try {
      execFileSync('cp', ['-Rc', src, nm], { stdio: 'ignore', timeout: 600_000 });
    } catch {
      execFileSync('cp', ['-R', src, nm], { stdio: 'ignore', timeout: 1_800_000 });
    }
  }
  return { dir: opts.dir, sha };
}

export function removeWorktree(repo: string, dir: string): void {
  try {
    git(repo, ['worktree', 'remove', '--force', dir]);
  } catch {
    // ignore
  }
}

/** Reads `KEY=value` from the app's env files (first match wins, in the given order). */
export function readEnvVar(appRoot: string, key: string, files = ['.env.development.local', '.env.local', '.env.development', '.env']): string | null {
  for (const f of files) {
    const p = join(appRoot, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || m[1] !== key) continue;
      return m[2]!.replace(/^['"]|['"]$/g, '').trim();
    }
  }
  return null;
}
