import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

function simctl(args: string[], opts: { timeoutMs?: number } = {}): string {
  return execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? 60_000 });
}

export function listDevices(bootedOnly = true): SimDevice[] {
  const json = JSON.parse(simctl(['list', 'devices', ...(bootedOnly ? ['booted'] : []), '-j']));
  const out: SimDevice[] = [];
  for (const [runtime, devices] of Object.entries<any[]>(json.devices ?? {})) {
    for (const d of devices) out.push({ udid: d.udid, name: d.name, state: d.state, runtime: runtime.split('.').pop() ?? runtime });
  }
  return out;
}

/** Picks the simulator by name or udid; defaults to the single booted device. */
export function resolveDevice(nameOrUdid?: string): SimDevice {
  const booted = listDevices(true);
  if (!nameOrUdid) {
    if (booted.length === 1) return booted[0]!;
    if (booted.length === 0) throw new Error('No booted iOS Simulator. Boot one (open -a Simulator) or set `simulator` in fixpoint.config.ts.');
    throw new Error(`Several simulators are booted (${booted.map((d) => d.name).join(', ')}); set \`simulator\` in fixpoint.config.ts.`);
  }
  const all = listDevices(false);
  const match = all.find((d) => d.udid === nameOrUdid) ?? booted.find((d) => d.name === nameOrUdid) ?? all.find((d) => d.name === nameOrUdid);
  if (!match) throw new Error(`Simulator "${nameOrUdid}" not found.`);
  return match;
}

export function bootDevice(udid: string): void {
  try {
    simctl(['boot', udid]);
  } catch (e) {
    if (!/current state: Booted/.test(String((e as any).stderr ?? e))) throw e;
  }
  simctl(['bootstatus', udid, '-b'], { timeoutMs: 180_000 });
}

export function launchApp(udid: string, bundleId: string): number | null {
  const out = simctl(['launch', udid, bundleId]);
  const m = /:\s*(\d+)\s*$/.exec(out.trim());
  return m ? Number(m[1]) : null;
}

export function terminateApp(udid: string, bundleId: string): void {
  try {
    simctl(['terminate', udid, bundleId]);
  } catch {
    // not running
  }
}

export function openUrl(udid: string, url: string): void {
  simctl(['openurl', udid, url]);
}

/** Pid of the app process, through launchd inside the simulator. */
export function appPid(udid: string, bundleId: string): number | null {
  try {
    const out = simctl(['spawn', udid, 'launchctl', 'list']);
    for (const line of out.split('\n')) {
      if (!line.includes(`UIKitApplication:${bundleId}[`)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
  } catch {
    // ignore
  }
  return null;
}

export function screenshot(udid: string, file: string): void {
  simctl(['io', udid, 'screenshot', '--type=png', file]);
}

export interface VideoRecording {
  file: string;
  stop: () => Promise<string>;
}

/** `simctl io recordVideo`; stop sends SIGINT and waits for the file to be finalised. */
export function startVideo(udid: string, file: string, opts: { codec?: 'h264' | 'hevc' } = {}): VideoRecording {
  const proc: ChildProcess = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', `--codec=${opts.codec ?? 'h264'}`, '--force', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (d) => (stderr += d.toString()));
  return {
    file,
    stop: () =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
          reject(new Error(`recordVideo did not stop: ${stderr}`));
        }, 30_000);
        proc.once('exit', () => {
          clearTimeout(timer);
          if (existsSync(file)) resolve(file);
          else reject(new Error(`recordVideo produced no file: ${stderr}`));
        });
        proc.kill('SIGINT');
      }),
  };
}

/** Device point size from the simulator's screen (used for swipe coordinates). */
export function screenPoints(udid: string): { width: number; height: number } | null {
  try {
    const out = simctl(['spawn', udid, 'defaults', 'read', 'com.apple.coreservices.uiagent']);
    void out;
  } catch {
    // not available; fall through
  }
  return null;
}

// ---- idb (optional; https://fbidb.io) -------------------------------------------------------------

export function idbAvailable(): boolean {
  try {
    execFileSync('idb', ['--help'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export function idbTap(udid: string, x: number, y: number): void {
  execFileSync('idb', ['ui', 'tap', '--udid', udid, String(x), String(y)], { stdio: 'ignore', timeout: 20_000 });
}

export function idbSwipe(udid: string, x1: number, y1: number, x2: number, y2: number, durationMs = 300): void {
  execFileSync('idb', ['ui', 'swipe', '--udid', udid, '--duration', String(durationMs / 1000), String(x1), String(y1), String(x2), String(y2)], { stdio: 'ignore', timeout: 20_000 });
}

/** Lines the simulator's own log shows when something else drives the app (foreign launches, URLs). */
export function foreignDriverEvents(udid: string, sinceIso: string, bundleId: string): string[] {
  try {
    const out = simctl(['spawn', udid, 'log', 'show', '--start', sinceIso, '--predicate', `process == "CoreSimulatorBridge" AND eventMessage CONTAINS "${bundleId}"`, '--style', 'compact'], { timeoutMs: 120_000 });
    return out.split('\n').filter((l) => /Opening URL|Requesting launch|terminate application/.test(l));
  } catch {
    return [];
  }
}
