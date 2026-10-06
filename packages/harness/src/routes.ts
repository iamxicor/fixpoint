import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FixpointConfig, RouteConfig } from './config.js';

export interface DiscoveredRoute {
  /** Repo-relative route file, e.g. `app/(authenticated)/(tabs)/notifications/index.tsx`. */
  file: string;
  /** Route path with groups removed, e.g. `/notifications`. Dynamic segments keep their brackets. */
  path: string;
  dynamic: string[];
  /** Navigable href once params are applied, or null when skipped. */
  href: string | null;
  skipped: string | null;
  scenario?: RouteConfig['scenario'];
}

const ROUTE_EXT = /\.(tsx|jsx)$/;
const IGNORED_DIRS = new Set(['__tests__', 'node_modules']);

/** Walks an Expo Router `app/` directory and derives navigable routes. */
export function discoverRoutes(appRoot: string, config?: Pick<FixpointConfig, 'routes' | 'exclude'>): DiscoveredRoute[] {
  const appDir = join(appRoot, 'app');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') || IGNORED_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(relative(appRoot, p));
    }
  };
  walk(appDir);
  const configured = new Map<string, RouteConfig>();
  for (const r of config?.routes ?? []) configured.set(normalizePath(r.path), r);
  const out: DiscoveredRoute[] = [];
  for (const file of files.sort()) {
    const rel = file.slice('app/'.length);
    const base = rel.split('/').pop()!;
    const name = base.replace(/\.[^.]+$/, '');
    if (!ROUTE_EXT.test(base)) continue;
    if (name.startsWith('_layout') || name.startsWith('+')) continue;
    if (/\+api$/.test(name)) continue;
    if (/\.(test|spec|stories)$/.test(name)) continue;
    const segments = rel.replace(/\.[^.]+$/, '').split('/');
    const last = segments[segments.length - 1]!;
    if (segments.some((seg) => seg.startsWith('_'))) {
      out.push({ file, path: toPath(segments), dynamic: [], href: null, skipped: 'under a _private directory' });
      continue;
    }
    if (/^[A-Z]/.test(last) || /^use-/.test(last) || last.includes('.')) {
      out.push({ file, path: toPath(segments), dynamic: [], href: null, skipped: 'component or hook file, not a screen' });
      continue;
    }
    const path = toPath(segments);
    const dynamic = [...path.matchAll(/\[(\.\.\.)?([^\]]+)\]/g)].map((m) => m[2]!);
    const cfg = configured.get(normalizePath(path));
    if (config?.exclude?.some((x) => path === normalizePath(x) || file.startsWith(x) || path.startsWith(normalizePath(x) + '/'))) {
      out.push({ file, path, dynamic, href: null, skipped: 'excluded by config' });
      continue;
    }
    let href: string | null = path;
    let skipped: string | null = null;
    if (dynamic.length) {
      const params = cfg?.params ?? {};
      const missing = dynamic.filter((d) => !(d in params));
      if (missing.length) {
        href = null;
        skipped = `needs params: ${missing.join(', ')}`;
      } else {
        href = path.replace(/\[(\.\.\.)?([^\]]+)\]/g, (_m, _rest, key) => encodeURIComponent(params[key]!));
      }
    }
    out.push({ file, path, dynamic, href, skipped, scenario: cfg?.scenario });
  }
  // configured routes that did not come from files (e.g. with query params) are added verbatim
  for (const [p, cfg] of configured) {
    if (!out.some((r) => normalizePath(r.path) === p)) out.push({ file: '', path: cfg.path, dynamic: [], href: cfg.path, skipped: null, scenario: cfg.scenario });
  }
  return out;
}

function toPath(segments: string[]): string {
  const parts = segments.filter((s) => !/^\(.*\)$/.test(s));
  if (parts[parts.length - 1] === 'index') parts.pop();
  return '/' + parts.join('/');
}

function normalizePath(p: string): string {
  const parts = p.split('?')[0]!.split('/').filter((s) => s && !/^\(.*\)$/.test(s));
  if (parts[parts.length - 1] === 'index') parts.pop();
  return '/' + parts.join('/');
}

export function routeSlug(path: string): string {
  return path.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'index';
}
