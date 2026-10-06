import { CdpConnection, CdpError } from './cdp.js';
import { listTargets, originCandidates, pickTarget, type PickTargetOptions } from './metro.js';
import type { CpuProfile, HeapSnapshot, InspectorTarget, RouteInfo, ScriptInfo, StartupTiming, TraceEvent, TraceFile } from './types.js';

/** Categories React Native's TracingAgent understands. Unknown tokens are ignored by RN, `-*` included. */
export const TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-devtools.timeline.frame',
] as const;

export type TraceRecordOptions = { durationMs: number; categories?: string[] } | { until: () => Promise<void>; categories?: string[] };

export interface ConnectOptions extends PickTargetOptions {
  metroUrl?: string;
  /** Force an Origin header instead of discovering it. */
  origin?: string;
  /** Milliseconds to wait for a `Runtime.evaluate` round-trip when probing an origin. */
  probeTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * High-level React Native DevTools client. One instance per inspector page.
 */
export class DevToolsClient {
  private constructor(
    readonly target: InspectorTarget,
    readonly cdp: CdpConnection,
    readonly origin: string,
  ) {}

  /** Lists targets on Metro, picks one for the device, and opens a working debugger socket. */
  static async connect(opts: ConnectOptions = {}): Promise<DevToolsClient> {
    const metroUrl = opts.metroUrl ?? 'http://localhost:8081';
    const targets = await listTargets(metroUrl);
    const target = pickTarget(targets, opts);
    if (!target) {
      const seen = targets.map((t) => `${t.id} (${t.deviceName ?? t.title})`).join(', ') || 'none';
      throw new Error(`No inspector target for device "${opts.deviceName ?? 'any'}" on ${metroUrl}. Targets: ${seen}`);
    }
    return DevToolsClient.connectTo(target, { ...opts, metroUrl });
  }

  static async connectTo(target: InspectorTarget, opts: ConnectOptions = {}): Promise<DevToolsClient> {
    const metroUrl = opts.metroUrl ?? 'http://localhost:8081';
    const candidates = opts.origin ? [opts.origin] : await originCandidates(metroUrl);
    const errors: string[] = [];
    for (const origin of candidates) {
      const cdp = new CdpConnection(target.webSocketDebuggerUrl);
      try {
        await cdp.connect({ origin });
        // Expo terminates a bad-origin socket right after open; prove the session is live first.
        const r = await cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, opts.probeTimeoutMs ?? 3_000);
        if (r?.result?.value === 2) return new DevToolsClient(target, cdp, origin);
        errors.push(`${origin}: unexpected probe result`);
      } catch (e) {
        errors.push(`${origin}: ${(e as Error).message}`);
      }
      cdp.close();
    }
    throw new Error(`Could not open a debugger session to ${target.webSocketDebuggerUrl}. Tried: ${errors.join('; ')}`);
  }

  disconnect(): void {
    this.cdp.close();
  }

  // ---- Runtime ---------------------------------------------------------------------------------

  readonly runtime = {
    /** Evaluates an expression and returns its value by value. Throws on JS exceptions. */
    evaluate: async <T = unknown>(expression: string, timeoutMs = 10_000): Promise<T> => {
      const r = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
      if (r?.exceptionDetails) {
        const text = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluation threw';
        throw new CdpError('Runtime.evaluate', undefined, text);
      }
      return r?.result?.value as T;
    },
    /** `performance.rnStartupTiming` fields that exist in this build. */
    startupTiming: async (): Promise<StartupTiming | null> =>
      this.runtime.evaluate<StartupTiming | null>(
        // the JS thread is often busy for seconds right after launch; the reply waits in its queue
        `(function(){ var s = (typeof performance !== 'undefined' && performance.rnStartupTiming) || null; if (!s) return null;
          var o = {}; ['startTime','endTime','initializeRuntimeStart','initializeRuntimeEnd','executeJavaScriptBundleEntryPointStart','executeJavaScriptBundleEntryPointEnd'].forEach(function(k){ if (typeof s[k] === 'number') o[k] = s[k]; }); return o; })()`,
        60_000,
      ),
    heapUsage: async (): Promise<{ totalSize: number; usedSize: number }> => this.cdp.send('Runtime.getHeapUsage'),
  };

  // ---- Metro module registry (zero app edits) ---------------------------------------------------

  readonly modules = {
    /** Repo-relative paths of modules that have been initialised (`__r.getModules()` in dev). */
    initialized: async (): Promise<string[]> =>
      this.runtime.evaluate<string[]>(
        `(function(){ if (typeof __r !== 'function' || typeof __r.getModules !== 'function') return []; var out = [];
          var m = __r.getModules(); var it = (m instanceof Map) ? m.entries() : Object.entries(m);
          for (var e of it) { var v = e[1]; if (v && v.isInitialized && v.verboseName) out.push(v.verboseName); } return out; })()`,
        90_000,
      ),
    count: async (): Promise<{ total: number; initialized: number }> =>
      this.runtime.evaluate<{ total: number; initialized: number }>(
        `(function(){ if (typeof __r !== 'function' || typeof __r.getModules !== 'function') return {total:0,initialized:0};
          var m = __r.getModules(); var it = (m instanceof Map) ? m.entries() : Object.entries(m); var t=0,i=0;
          for (var e of it) { t++; if (e[1] && e[1].isInitialized) i++; } return {total:t, initialized:i}; })()`,
      ),
  };

  // ---- Expo Router (through the module registry) ----------------------------------------------

  readonly expoRouter = {
    routeInfo: async (): Promise<RouteInfo | null> =>
      this.runtime.evaluate<RouteInfo | null>(
        `(function(){ ${MODULE_LOOKUP} var ex = lookup('expo-router/build/global-state/router-store.js'); if (!ex || !ex.store) return null;
          var s = ex.store; var ri = typeof s.getRouteInfo === 'function' ? s.getRouteInfo() : s.routeInfo; if (!ri) return null;
          return { pathname: ri.pathname, segments: ri.segments, params: ri.params || {}, pathnameWithParams: ri.pathnameWithParams }; })()`,
        30_000,
      ),
    navigate: async (href: string): Promise<void> => {
      await this.runtime.evaluate(`(function(){ ${MODULE_LOOKUP} var ex = lookup('expo-router/build/imperative-api.js'); if (!ex || !ex.router) throw new Error('expo-router imperative api not found'); ex.router.navigate(${JSON.stringify(href)}); return true; })()`);
    },
    push: async (href: string): Promise<void> => {
      await this.runtime.evaluate(`(function(){ ${MODULE_LOOKUP} var ex = lookup('expo-router/build/imperative-api.js'); ex.router.push(${JSON.stringify(href)}); return true; })()`);
    },
    back: async (): Promise<boolean> =>
      this.runtime.evaluate<boolean>(`(function(){ ${MODULE_LOOKUP} var ex = lookup('expo-router/build/imperative-api.js'); if (!ex || !ex.router) return false; if (ex.router.canGoBack()) { ex.router.back(); return true; } return false; })()`),
    /** Polls the route store until `pathname` matches (exact or prefix). */
    waitForPathname: async (pathname: string, timeoutMs = 10_000, pollMs = 150): Promise<RouteInfo> => {
      const t0 = Date.now();
      let last: RouteInfo | null = null;
      while (Date.now() - t0 < timeoutMs) {
        last = await this.expoRouter.routeInfo();
        if (last && (last.pathname === pathname || last.pathname.startsWith(pathname.replace(/\/$/, '') + '/'))) return last;
        await sleep(pollMs);
      }
      throw new Error(`Route did not reach ${pathname} within ${timeoutMs} ms (last: ${last?.pathname ?? 'unknown'})`);
    },
  };

  // ---- Debugger scripts ---------------------------------------------------------------------------

  /**
   * Collects `Debugger.scriptParsed` for a short window. The Debugger domain is disabled again before
   * returning because `Tracing.start` refuses to run while it is enabled.
   */
  async scripts(windowMs = 1_500): Promise<ScriptInfo[]> {
    const scripts: ScriptInfo[] = [];
    const off = this.cdp.on((n) => {
      if (n.method === 'Debugger.scriptParsed') scripts.push({ scriptId: String(n.params.scriptId), url: n.params.url ?? '', sourceMapURL: n.params.sourceMapURL || undefined });
    });
    try {
      await this.cdp.send('Debugger.enable');
      await sleep(windowMs);
    } finally {
      off();
      await this.cdp.send('Debugger.disable').catch(() => undefined);
    }
    return scripts.filter((s) => s.url);
  }

  // ---- Tracing ----------------------------------------------------------------------------------

  readonly tracing = {
    record: async (opts: TraceRecordOptions): Promise<TraceFile> => {
      const events: TraceEvent[] = [];
      let chunks = 0;
      const off = this.cdp.on((n) => {
        if (n.method === 'Tracing.dataCollected') {
          chunks++;
          const value = n.params?.value;
          if (Array.isArray(value)) events.push(...value);
        }
      });
      let started = false;
      try {
        await this.cdp.send('Debugger.disable').catch(() => undefined);
        const categories = (opts.categories ?? [...TRACE_CATEGORIES]).join(',');
        await this.cdp.send('Tracing.start', { categories, options: 'sampling-frequency=10000', transferMode: 'ReportEvents' });
        started = true;
        const startedAt = Date.now();
        if ('durationMs' in opts) await sleep(opts.durationMs);
        else await opts.until();
        const complete = this.cdp.waitFor('Tracing.tracingComplete', 120_000);
        await this.cdp.send('Tracing.end');
        started = false;
        const done = await complete;
        return {
          traceEvents: events,
          metadata: { source: 'fixpoint', chunks, dataLossOccurred: !!done?.dataLossOccurred, wallMs: Date.now() - startedAt, target: this.target.id },
        };
      } finally {
        off();
        // a scenario that throws must not leave the recording running: the next Tracing.start would fail
        if (started) {
          const complete = this.cdp.waitFor('Tracing.tracingComplete', 30_000).catch(() => undefined);
          await this.cdp.send('Tracing.end').catch(() => undefined);
          await complete;
        }
      }
    },
  };

  // ---- Profiler ---------------------------------------------------------------------------------

  readonly profiler = {
    /** Hermes supports `Profiler.start/stop` but not `enable` or `setSamplingInterval`. */
    record: async (opts: { durationMs: number } | { until: () => Promise<void> }): Promise<CpuProfile> => {
      await this.cdp.send('Profiler.start');
      if ('durationMs' in opts) await sleep(opts.durationMs);
      else await opts.until();
      const r = await this.cdp.send('Profiler.stop', {}, 60_000);
      return r.profile as CpuProfile;
    },
  };

  // ---- Heap -------------------------------------------------------------------------------------

  readonly heap = {
    collectGarbage: async (): Promise<void> => {
      await this.cdp.send('HeapProfiler.collectGarbage', {}, 60_000);
    },
    /**
     * Takes a V8-format snapshot. Chunks arrive as `HeapProfiler.addHeapSnapshotChunk` before the
     * (empty) result; a short grace period catches stragglers. Expect ~200 MB and ~7 s on a dev build.
     */
    snapshot: async (opts: { gcFirst?: boolean; graceMs?: number } = {}): Promise<{ text: string; parse: () => HeapSnapshot }> => {
      const parts: string[] = [];
      const off = this.cdp.on((n) => {
        if (n.method === 'HeapProfiler.addHeapSnapshotChunk') parts.push(n.params.chunk);
      });
      try {
        if (opts.gcFirst ?? true) await this.heap.collectGarbage();
        await this.cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 300_000);
        await sleep(opts.graceMs ?? 500);
      } finally {
        off();
      }
      const text = parts.join('');
      return { text, parse: () => JSON.parse(text) as HeapSnapshot };
    },
  };
}

/** JS helper injected into evaluated expressions: finds a module's exports by `verboseName` suffix. */
const MODULE_LOOKUP = `
  function lookup(suffix) {
    if (typeof __r !== 'function' || typeof __r.getModules !== 'function') return null;
    var m = __r.getModules(); var it = (m instanceof Map) ? m.entries() : Object.entries(m);
    for (var e of it) { var v = e[1]; if (v && v.verboseName && v.verboseName.endsWith(suffix) && v.publicModule) return v.publicModule.exports; }
    return null;
  }`;
