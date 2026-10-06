import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { DevToolsClient, listTargets, metroStatus, pickTarget } from '@fixpoint/devtools';
import { COMPONENTS_TRACK, SCHEDULER_GROUP } from '@fixpoint/analyzer';
import { discoverRoutes, findConfigFile, loadConfig, resolveDevice, serializeConfig, type FixpointUserConfig } from '@fixpoint/harness';

const ok = (s: string) => `  ✓ ${s}`;
const bad = (s: string) => `  ✗ ${s}`;
const warn = (s: string) => `  ! ${s}`;

export interface Detected {
  kind: 'expo' | 'bare' | 'unknown';
  reactNativeVersion: string | null;
  expoVersion: string | null;
  source: 'tracing' | 'profiler' | 'unsupported';
  scheme: string | null;
  bundleId: string | null;
  metroPort: number;
  apiBaseEnvVar: string | null;
  routes: { total: number; navigable: number; skipped: number };
  notes: string[];
}

/** Reads the app without executing its config: package.json, app.json/app.config.* text, env files. */
export function detectApp(appRoot: string): Detected {
  const notes: string[] = [];
  const req = createRequire(join(appRoot, 'package.json'));
  const version = (name: string) => {
    try {
      return req(`${name}/package.json`).version as string;
    } catch {
      return null;
    }
  };
  const pkg = existsSync(join(appRoot, 'package.json')) ? JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) : {};
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const expoVersion = version('expo');
  const rn = version('react-native');
  const kind: Detected['kind'] = expoVersion ? 'expo' : rn ? 'bare' : 'unknown';
  let source: Detected['source'] = 'unsupported';
  if (rn) {
    const [maj, min] = rn.split('.').map(Number);
    source = (maj ?? 0) > 0 || (min ?? 0) >= 81 ? 'tracing' : (min ?? 0) >= 76 ? 'profiler' : 'unsupported';
  }
  if (!deps['expo-dev-client']) notes.push('expo-dev-client is not a dependency; v1 supports Expo dev-client builds only');
  if (!deps['expo-router']) notes.push('expo-router is not a dependency; route discovery and router-driven navigation need it');
  // scheme / bundle id from app config text (no evaluation of app.config.ts)
  let scheme: string | null = null;
  let bundleId: string | null = null;
  const appJson = join(appRoot, 'app.json');
  if (existsSync(appJson)) {
    try {
      const j = JSON.parse(readFileSync(appJson, 'utf8'));
      const expo = j.expo ?? j;
      scheme = Array.isArray(expo.scheme) ? expo.scheme[0] : (expo.scheme ?? null);
      bundleId = expo.ios?.bundleIdentifier ?? null;
    } catch {
      notes.push('app.json could not be parsed');
    }
  }
  for (const f of ['app.config.ts', 'app.config.js', 'app.config.mjs']) {
    const p = join(appRoot, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    scheme ??= /\bscheme:\s*['"]([^'"]+)['"]/.exec(text)?.[1] ?? null;
    bundleId ??= /bundleIdentifier:\s*['"]([^'"]+)['"]/.exec(text)?.[1] ?? null;
    if (!bundleId) {
      const m = /bundleIdentifier:\s*([A-Za-z_$][\w$.]*)/.exec(text);
      if (m) notes.push(`bundleIdentifier is computed (${m[1]}) in ${f}; set bundleId in fixpoint.config.ts by hand`);
    }
  }
  if (!bundleId) {
    // iOS project as a last resort
    const ios = join(appRoot, 'ios');
    if (existsSync(ios)) {
      for (const entry of readdirSync(ios)) {
        if (!entry.endsWith('.xcodeproj')) continue;
        const pb = join(ios, entry, 'project.pbxproj');
        if (!existsSync(pb)) continue;
        const m = /PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/.exec(readFileSync(pb, 'utf8'));
        if (m) bundleId = m[1]!.trim().replace(/"/g, '');
      }
    }
  }
  // API base env var
  let apiBaseEnvVar: string | null = null;
  const candidates = new Set<string>();
  for (const f of ['.env.development.local', '.env.local', '.env.development', '.env', '.env.sample', '.env.example', 'app.config.ts', 'app.config.js']) {
    const p = join(appRoot, f);
    if (!existsSync(p)) continue;
    for (const m of readFileSync(p, 'utf8').matchAll(/\b(EXPO_PUBLIC_[A-Z0-9_]*(?:API|BASE)[A-Z0-9_]*URL[A-Z0-9_]*)\b/g)) candidates.add(m[1]!);
  }
  apiBaseEnvVar = [...candidates].sort((a, b) => a.length - b.length)[0] ?? null;
  const routes = existsSync(join(appRoot, 'app')) ? discoverRoutes(appRoot) : [];
  return {
    kind,
    reactNativeVersion: rn,
    expoVersion,
    source,
    scheme,
    bundleId,
    metroPort: 8081,
    apiBaseEnvVar,
    routes: { total: routes.length, navigable: routes.filter((r) => r.href).length, skipped: routes.filter((r) => r.skipped).length },
    notes,
  };
}

export async function runInit(dir: string, opts: { force?: boolean; print?: boolean }): Promise<void> {
  const appRoot = resolve(dir);
  const d = detectApp(appRoot);
  const lines: string[] = [];
  lines.push(`Fixpoint init — ${appRoot}`);
  lines.push(d.kind === 'expo' ? ok(`Expo SDK ${d.expoVersion} (dev client)`) : d.kind === 'bare' ? warn('bare React Native project; v1 targets Expo dev-client apps') : bad('no react-native dependency found'));
  lines.push(d.reactNativeVersion ? (d.source === 'tracing' ? ok(`React Native ${d.reactNativeVersion}: CDP Tracing domain available`) : d.source === 'profiler' ? warn(`React Native ${d.reactNativeVersion}: Tracing domain needs 0.81+; falling back to the Profiler domain (no React tracks)`) : bad(`React Native ${d.reactNativeVersion} is too old`)) : bad('react-native not installed'));
  lines.push(d.scheme ? ok(`scheme ${d.scheme}`) : bad('no deep-link scheme found in app.json / app.config.*'));
  lines.push(d.bundleId ? ok(`bundle id ${d.bundleId}`) : bad('no iOS bundle identifier found; set bundleId in fixpoint.config.ts'));
  lines.push(ok(`Metro port ${d.metroPort}`));
  lines.push(d.apiBaseEnvVar ? ok(`API base env var ${d.apiBaseEnvVar} (replay proxy overrides this)`) : warn('no EXPO_PUBLIC_*API*URL variable found; set apiBaseEnvVar to use the replay proxy'));
  lines.push(ok(`${d.routes.navigable} navigable routes, ${d.routes.skipped} skipped (dynamic segments need params)`));
  for (const n of d.notes) lines.push(warn(n));
  const user: FixpointUserConfig = {
    scheme: d.scheme ?? 'myapp',
    bundleId: d.bundleId ?? 'com.example.app',
    metroPort: d.metroPort,
    apiBaseEnvVar: d.apiBaseEnvVar ?? 'EXPO_PUBLIC_API_URL',
    routes: [],
    exclude: [],
    replay: { mode: 'off', dir: '.fixpoint/replay' },
    thresholds: { minEffect: 0.05, alpha: 0.05, maxControlDrift: 0.25 },
    interactions: 'cdp',
    pairs: 6,
  };
  const existing = findConfigFile(appRoot);
  const text = serializeConfig(user);
  if (opts.print) lines.push('', text);
  else if (existing && !opts.force) lines.push(ok(`${existing} already exists (use --force to overwrite)`));
  else {
    writeFileSync(join(appRoot, 'fixpoint.config.mjs'), text);
    lines.push(ok(`wrote fixpoint.config.mjs (import-free; keep it untracked or commit it, either way it never affects the app build)`));
  }
  lines.push('', 'Next: `fixpoint verify` with the dev client open on the simulator and Metro running.');
  lines.push('Claude Code plugin: run `claude --plugin-dir <fixpoint repo>/plugin` or add it through /plugin; the skills call this CLI through the fixpoint MCP server.');
  process.stdout.write(lines.join('\n') + '\n');
}

export async function runVerify(dir: string, opts: { json?: boolean; metro?: string }): Promise<boolean> {
  const { config, file } = await loadConfig(resolve(dir));
  if (opts.metro) config.metroUrl = opts.metro;
  const lines: string[] = [];
  const results: Record<string, unknown> = {};
  let allOk = true;
  const check = (name: string, good: boolean, detail: string) => {
    results[name] = { ok: good, detail };
    lines.push(good ? ok(`${name}: ${detail}`) : bad(`${name}: ${detail}`));
    if (!good) allOk = false;
  };
  lines.push(`Fixpoint verify — ${file ?? 'no config file (defaults)'}`);
  const metroUrl = config.metroUrl ?? `http://localhost:${config.metroPort}`;
  let device: ReturnType<typeof resolveDevice> | null = null;
  try {
    device = resolveDevice(config.simulator);
    check('simulator', true, `${device.name} (${device.udid}) booted`);
  } catch (e) {
    check('simulator', false, (e as Error).message);
  }
  const status = await metroStatus(metroUrl);
  check('metro', status.status === 'running', `${metroUrl} ${status.status}`);
  if (status.status !== 'running' || !device) return finish();
  const targets = await listTargets(metroUrl).catch(() => []);
  const target = pickTarget(targets, { deviceName: device.name, appId: config.bundleId || undefined });
  check('target', !!target, target ? `${target.id} (${target.title})` : `no page for ${device.name} among ${targets.length} target(s): ${targets.map((t) => t.deviceName ?? t.title).join(', ') || 'none'}`);
  if (!target) return finish();
  let client: DevToolsClient;
  try {
    client = await DevToolsClient.connectTo(target, { metroUrl });
    check('debugger', true, `connected with Origin ${client.origin}`);
  } catch (e) {
    check('debugger', false, (e as Error).message);
    return finish();
  }
  try {
    const route = await client.expoRouter.routeInfo();
    check('router', !!route, route ? `current route ${route.pathname}` : 'expo-router store not reachable through the module registry');
    const mods = await client.modules.count();
    check('modules', mods.total > 0, `${mods.initialized} of ${mods.total} modules initialised`);
    const trace = await client.tracing.record({ durationMs: 2000 });
    const stamps = trace.traceEvents.filter((e) => e.name === 'TimeStamp');
    const components = stamps.filter((e) => e.args?.data?.track === COMPONENTS_TRACK).length;
    const scheduler = stamps.filter((e) => e.args?.data?.trackGroup === SCHEDULER_GROUP).length;
    const samples = trace.traceEvents.filter((e) => e.name === 'ProfileChunk').length;
    check('tracing', trace.traceEvents.length > 0, `${trace.traceEvents.length} events in 2 s`);
    check('react-tracks', scheduler > 0, scheduler > 0 ? `Scheduler ⚛ ${scheduler} entries, Components ⚛ ${components} entries` : 'no React performance track entries (React 19.2+ with console.timeStamp support expected)');
    check('sampling', samples > 0, samples > 0 ? `${samples} profile chunks` : 'no sampling data; include disabled-by-default-v8.cpu_profiler');
    const timing = await client.runtime.startupTiming();
    check('startup-timing', !!timing, timing ? `performance.rnStartupTiming has ${Object.keys(timing).length} fields` : 'performance.rnStartupTiming unavailable');
  } catch (e) {
    check('tracing', false, (e as Error).message);
  } finally {
    client.disconnect();
  }
  return finish();

  function finish(): boolean {
    lines.push('', allOk ? 'All checks passed. Run `fixpoint scan` to record every route.' : 'Some checks failed; see docs/DECISIONS.md for the usual causes (Origin header, physical device on the same Metro, Debugger domain left enabled).');
    if (opts.json) process.stdout.write(JSON.stringify({ ok: allOk, results }, null, 2) + '\n');
    else process.stdout.write(lines.join('\n') + '\n');
    return allOk;
  }
}

export function registerProject(program: Command): void {
  program
    .command('init [dir]')
    .description('Detect the app and write fixpoint.config.ts (idempotent, no app edits)')
    .option('--force', 'overwrite an existing config')
    .option('--print', 'print the config instead of writing it')
    .action(async (dir: string | undefined, opts) => runInit(dir ?? '.', opts));
  program
    .command('verify [dir]')
    .description('Connect to the running dev build, record two seconds, and check the React tracks')
    .option('--json', 'machine-readable output')
    .option('--metro <url>', 'Metro URL to use instead of the configured one')
    .action(async (dir: string | undefined, opts) => {
      const good = await runVerify(dir ?? '.', opts);
      if (!good) process.exitCode = 1;
    });
  program
    .command('routes [dir]')
    .description('List the Expo Router routes Fixpoint would scan')
    .option('--json', 'machine-readable output')
    .action(async (dir: string | undefined, opts) => {
      const { config } = await loadConfig(resolve(dir ?? '.'));
      const routes = discoverRoutes(config.appRoot, config);
      if (opts.json) return void process.stdout.write(JSON.stringify(routes, null, 2) + '\n');
      for (const r of routes) process.stdout.write(`${r.skipped ? '-' : '+'} ${r.path.padEnd(48)} ${r.href ?? ''}${r.skipped ? `  (skipped: ${r.skipped})` : ''}\n`);
      process.stdout.write(`${routes.filter((r) => r.href).length} navigable, ${routes.filter((r) => r.skipped).length} skipped\n`);
    });
}
