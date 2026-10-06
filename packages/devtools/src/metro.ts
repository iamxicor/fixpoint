import type { InspectorTarget } from './types.js';

export interface MetroInfo {
  url: string;
  status: 'running' | 'unreachable';
}

/** `GET <metro>/status` returns `packager-status:running` when Metro is up. */
export async function metroStatus(metroUrl: string, timeoutMs = 3_000): Promise<MetroInfo> {
  try {
    const res = await fetch(new URL('/status', metroUrl), { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { url: metroUrl, status: text.includes('packager-status:running') ? 'running' : 'unreachable' };
  } catch {
    return { url: metroUrl, status: 'unreachable' };
  }
}

/** Lists inspector targets. `/json` and `/json/list` are equivalent on Metro; `/json` is tried first. */
export async function listTargets(metroUrl: string, timeoutMs = 5_000): Promise<InspectorTarget[]> {
  let lastError: unknown;
  for (const path of ['/json', '/json/list']) {
    try {
      const res = await fetch(new URL(path, metroUrl), { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        lastError = new Error(`${path} → HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as InspectorTarget[];
      if (Array.isArray(body)) return body;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`Could not list inspector targets at ${metroUrl}: ${String(lastError)}`);
}

export interface PickTargetOptions {
  /** Exact `deviceName` to match, normally the booted simulator's name ("iPhone 17"). */
  deviceName?: string;
  /** Optional app id (bundle identifier) to match. */
  appId?: string;
}

/** Parses `<logicalDeviceId>-<page>` target ids. */
export function parseTargetId(id: string): { device: string; page: number } {
  const i = id.lastIndexOf('-');
  if (i < 0) return { device: id, page: 0 };
  const page = Number(id.slice(i + 1));
  return { device: id.slice(0, i), page: Number.isFinite(page) ? page : 0 };
}

/**
 * Picks the Fusebox target for the configured device. The page number increments every time the
 * React Native instance is recreated (reload, dev-client switch), so the highest page wins. A
 * physical device attached to the same Metro appears in the same list and must not be chosen.
 */
export function pickTarget(targets: InspectorTarget[], opts: PickTargetOptions = {}): InspectorTarget | undefined {
  let candidates = targets.filter((t) => t.reactNative?.capabilities != null || /Hermes|Bridgeless/i.test(`${t.title} ${t.description}`));
  if (candidates.length === 0) candidates = targets;
  if (opts.appId) candidates = candidates.filter((t) => !t.appId || t.appId === opts.appId);
  if (opts.deviceName) {
    const byName = candidates.filter((t) => t.deviceName === opts.deviceName || t.title.includes(`(${opts.deviceName})`));
    if (byName.length === 0) return undefined;
    candidates = byName;
  }
  return [...candidates].sort((a, b) => parseTargetId(b.id).page - parseTargetId(a.id).page)[0];
}

/**
 * Expo's dev server reports the host it considers its own in the manifest (`debuggerHost`).
 * Returns candidate `Origin` header values in the order they should be tried.
 */
export async function originCandidates(metroUrl: string): Promise<string[]> {
  const u = new URL(metroUrl);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const candidates = new Set<string>();
  try {
    const res = await fetch(metroUrl, {
      headers: { 'expo-platform': 'ios', accept: 'application/expo+json,application/json' },
      signal: AbortSignal.timeout(4_000),
    });
    if (res.ok) {
      const manifest: any = await res.json();
      const host: string | undefined = manifest?.extra?.expoGo?.debuggerHost ?? manifest?.extra?.expoClient?.hostUri;
      if (typeof host === 'string' && host.length > 0) candidates.add(`${u.protocol}//${host}`);
    }
  } catch {
    // not an Expo server or manifest disabled; fall through to the defaults
  }
  candidates.add(`${u.protocol}//127.0.0.1:${port}`);
  candidates.add(`${u.protocol}//localhost:${port}`);
  candidates.add(u.origin);
  return [...candidates];
}

/** Maps a Metro bundle URL to its source map URL (`.bundle` → `.map`, query preserved). */
export function sourceMapUrlForBundle(bundleUrl: string): string | null {
  const m = /^(.*)\.bundle(\/\/?&?)?(\?|$|&)(.*)$/.exec(bundleUrl);
  if (!m) return null;
  const base = m[1]!;
  const rest = m[4] ?? '';
  return rest ? `${base}.map?${rest.replace(/^&/, '')}` : `${base}.map`;
}
