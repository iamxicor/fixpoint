import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import type { Thresholds } from '@fixpoint/analyzer';

export type InteractionMode = 'cdp' | 'idb' | 'mcp' | 'none';
export type ReplayMode = 'record' | 'replay' | 'off';

export interface RouteConfig {
  /** URL path as Expo Router resolves it, e.g. `/notifications` or `/timeline/[id]`. */
  path: string;
  /** Values for dynamic segments. */
  params?: Record<string, string>;
  /** Scenario override; the default scenario is wait, scroll once, back. */
  scenario?: ScenarioStep[];
}

export type ScenarioStep =
  | { type: 'wait'; ms: number }
  | { type: 'scroll'; direction: 'down' | 'up'; amount: number }
  | { type: 'tap'; testID?: string; label?: string }
  | { type: 'back' }
  | { type: 'navigate'; href: string };

export interface FixpointConfig {
  /** App root (directory with app.config.ts / package.json). Defaults to the config file's directory. */
  appRoot: string;
  /** Deep-link scheme from app.json / app.config.*. */
  scheme: string;
  /** iOS bundle identifier of the dev client build. */
  bundleId: string;
  /** Simulator to use (name or udid). Defaults to the booted simulator. */
  simulator?: string;
  metroPort: number;
  /** Metro URL when a server is already running (scan). Derived from metroPort when omitted. */
  metroUrl?: string;
  routes: RouteConfig[];
  exclude: string[];
  /** Env var holding the API base URL; the replay proxy overrides it when Metro is started by Fixpoint. */
  apiBaseEnvVar: string;
  replay: { mode: ReplayMode; dir: string; port?: number };
  thresholds: {
    /** Minimum relative improvement of the time metric to call a win (fraction). */
    minEffect: number;
    alpha: number;
    /** Maximum relative drift allowed for frames the candidate diff did not touch. */
    maxControlDrift: number;
    /** Analyzer severity thresholds. */
    analyzer?: Partial<Thresholds>;
  };
  interactions: InteractionMode;
  /** Number of A/B pairs (default 6). */
  pairs: number;
  /** Ports for the two Metro servers an A/B starts. */
  abPorts: [number, number];
  /** Where traces, screenshots and verdicts go. */
  outDir: string;
  resultsDir: string;
  /** Settle time after a route reports ready, before the scenario starts. */
  settleMs: number;
}

export type FixpointUserConfig = Partial<Omit<FixpointConfig, 'routes' | 'replay' | 'thresholds'>> & {
  routes?: (RouteConfig | string)[];
  replay?: Partial<FixpointConfig['replay']>;
  thresholds?: Partial<FixpointConfig['thresholds']>;
};

export const CONFIG_FILES = ['fixpoint.config.mjs', 'fixpoint.config.js', 'fixpoint.config.ts', 'fixpoint.config.mts'];

export function defineConfig(config: FixpointUserConfig): FixpointUserConfig {
  return config;
}

export function resolveConfig(user: FixpointUserConfig, dir: string): FixpointConfig {
  const appRoot = resolve(dir, user.appRoot ?? '.');
  const metroPort = user.metroPort ?? 8081;
  // Outputs default to a cache directory outside the app so no untracked files, worktrees or 200 MB traces land in its tree.
  const outDir = resolve(appRoot, user.outDir ?? resolve(homedir(), '.cache', 'fixpoint', basename(appRoot)));
  return {
    appRoot,
    scheme: user.scheme ?? '',
    bundleId: user.bundleId ?? '',
    simulator: user.simulator,
    metroPort,
    metroUrl: user.metroUrl ?? `http://localhost:${metroPort}`,
    routes: (user.routes ?? []).map((r) => (typeof r === 'string' ? { path: r } : r)),
    exclude: user.exclude ?? [],
    apiBaseEnvVar: user.apiBaseEnvVar ?? 'EXPO_PUBLIC_API_URL',
    replay: { mode: user.replay?.mode ?? 'off', dir: resolve(outDir, user.replay?.dir ?? 'replay'), port: user.replay?.port ?? 8789 },
    thresholds: { minEffect: user.thresholds?.minEffect ?? 0.05, alpha: user.thresholds?.alpha ?? 0.05, maxControlDrift: user.thresholds?.maxControlDrift ?? 0.25, analyzer: user.thresholds?.analyzer },
    interactions: user.interactions ?? 'cdp',
    pairs: user.pairs ?? 6,
    abPorts: user.abPorts ?? [8091, 8092],
    outDir,
    resultsDir: resolve(outDir, user.resultsDir ?? 'results'),
    settleMs: user.settleMs ?? 1500,
  };
}

export function findConfigFile(dir: string): string | null {
  for (const f of CONFIG_FILES) {
    const p = resolve(dir, f);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Loads `fixpoint.config.ts` (TypeScript is transpiled on the fly with jiti). */
export async function loadConfig(dir: string): Promise<{ config: FixpointConfig; file: string | null }> {
  const file = findConfigFile(dir);
  if (!file) return { config: resolveConfig({}, dir), file: null };
  // `import { defineConfig } from 'fixpoint'` must work without the package installed in the app
  const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { fixpoint: fileURLToPath(new URL('./config.js', import.meta.url)) } });
  const mod: any = await jiti.import(file);
  const user: FixpointUserConfig = mod?.default ?? mod;
  return { config: resolveConfig(user, dir), file };
}

export function serializeConfig(user: FixpointUserConfig, format: 'ts' | 'mjs' = 'mjs'): string {
  const body = JSON.stringify(user, null, 2).replace(/"([a-zA-Z_][a-zA-Z0-9_]*)":/g, '$1:');
  if (format === 'ts') return `import { defineConfig } from 'fixpoint';\n\nexport default defineConfig(${body});\n`;
  // Import-free so the app's own typecheck and lint never need Fixpoint installed.
  return `// Fixpoint configuration. Docs: https://github.com/iamxicor/fixpoint#configuration\n/** @type {import('fixpoint').FixpointUserConfig} */\nconst config = ${body};\n\nexport default config;\n`;
}
