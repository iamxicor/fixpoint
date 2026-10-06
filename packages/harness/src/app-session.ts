import { DevToolsClient, listTargets, pickTarget, type InspectorTarget, type RouteInfo, type StartupTiming, type TraceFile } from '@fixpoint/devtools';
import type { ScenarioStep } from './config.js';
import { devClientUrl } from './metro.js';
import { appPid, idbAvailable, idbSwipe, idbTap, launchApp, openUrl, screenshot as simScreenshot, setDevClientLastOpened, terminateApp, type SimDevice } from './simulator.js';
import type { InteractionMode } from './config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StartupCaptureResult {
  modulesInitialized: string[];
  rnStartupTiming: StartupTiming | null;
  firstRoute: string | null;
  /** Wall-clock milliseconds from openurl to the first route reporting ready. */
  readyMs: number;
}

export interface SessionOptions {
  device: SimDevice;
  bundleId: string;
  scheme: string;
  metroUrl: string;
  interactions?: InteractionMode;
  /** Logical screen size in points for idb swipes. */
  screen?: { width: number; height: number };
  log?: (msg: string) => void;
}

export interface Mark {
  label: string;
  at: number;
  route?: string;
}

/**
 * One running app instance on the simulator, reachable through DevTools. Created either by cold
 * start (terminate + dev-client URL) or by attaching to the page Metro already lists.
 */
export class AppSession {
  private scrollOffset = 0;
  readonly startedAt = Date.now();

  private constructor(
    readonly client: DevToolsClient,
    readonly opts: SessionOptions,
    readonly pid: number | null,
    readonly startup: StartupCaptureResult | null,
  ) {}

  static async attach(opts: SessionOptions): Promise<AppSession> {
    const client = await DevToolsClient.connect({ metroUrl: opts.metroUrl, deviceName: opts.device.name, appId: opts.bundleId });
    await waitForRouter(client, 30_000);
    return new AppSession(client, opts, appPid(opts.device.udid, opts.bundleId), null);
  }

  /**
   * Cold start: terminate, open the dev-client deep link to `metroUrl`, wait for a new inspector page,
   * connect, wait for Expo Router to be ready, and capture the startup state at that moment.
   */
  /**
   * Cold start with exactly one React Native host: terminate, make `metroUrl` the dev launcher's
   * most recent app, plain-launch, wait for the inspector page, connect, wait for Expo Router.
   * Falls back to the dev-client deep link (which registers the URL) followed by a second plain
   * launch when the registry cannot be written.
   */
  static async coldStart(opts: SessionOptions & { timeoutMs?: number; captureStartup?: boolean; strategy?: 'launch' | 'openurl' }): Promise<AppSession> {
    const log = opts.log ?? (() => undefined);
    const timeout = opts.timeoutMs ?? 120_000;
    const strategy = opts.strategy ?? 'launch';
    const t0 = Date.now();
    terminateApp(opts.device.udid, opts.bundleId);
    await waitForNoTarget(opts, 10_000);
    let launched = false;
    if (strategy === 'launch' && setDevClientLastOpened(opts.device.udid, opts.bundleId, opts.metroUrl)) {
      launchApp(opts.device.udid, opts.bundleId);
      launched = true;
      log(`cold start (launch) → ${opts.metroUrl}`);
    }
    if (!launched) {
      // deep link registers the URL as most recent, then a plain launch gives a single-host process
      openUrl(opts.device.udid, devClientUrl(opts.scheme, opts.metroUrl));
      log(`cold start (deep link) → ${opts.metroUrl}`);
      await waitForTarget(opts, 60_000);
      await sleep(1_500);
      terminateApp(opts.device.udid, opts.bundleId);
      await waitForNoTarget(opts, 10_000);
      launchApp(opts.device.udid, opts.bundleId);
      log('relaunched for a single-host process');
    }
    const target = await waitForTarget(opts, timeout - (Date.now() - t0));
    let client: DevToolsClient | null = null;
    let lastErr: unknown;
    while (!client && Date.now() - t0 < timeout) {
      try {
        client = await DevToolsClient.connectTo(target, { metroUrl: opts.metroUrl });
      } catch (e) {
        lastErr = e;
        await sleep(500);
      }
    }
    if (!client) throw new Error(`Could not connect to the new page: ${String(lastErr)}`);
    const route = await waitForRouter(client, timeout - (Date.now() - t0));
    const readyMs = Date.now() - t0;
    log(`ready at ${route.pathname} after ${readyMs} ms (page ${target.id})`);
    let startup: StartupCaptureResult | null = null;
    if (opts.captureStartup ?? true) {
      // sequential: both wait for the busy startup JS thread; the module list is the slow one
      const timing = await client.runtime.startupTiming();
      const modules = await client.modules.initialized();
      startup = { modulesInitialized: modules, rnStartupTiming: timing, firstRoute: route.pathname, readyMs };
    }
    return new AppSession(client, opts, appPid(opts.device.udid, opts.bundleId), startup);
  }

  alive(): boolean {
    const pid = appPid(this.opts.device.udid, this.opts.bundleId);
    return pid !== null && (this.pid === null || pid === this.pid) && this.client.cdp.isOpen;
  }

  close(): void {
    this.client.disconnect();
  }

  // ---- navigation -----------------------------------------------------------------------------

  routeInfo(): Promise<RouteInfo | null> {
    return this.client.expoRouter.routeInfo();
  }

  /** Waits until the route stops changing (index redirects settle), then returns the pathname. */
  async settleRoute(stableMs = 1_200, timeoutMs = 20_000): Promise<string> {
    const t0 = Date.now();
    let last = (await this.routeInfo())?.pathname ?? '/';
    let since = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(300);
      const now = (await this.routeInfo())?.pathname ?? last;
      if (now !== last) {
        last = now;
        since = Date.now();
      } else if (Date.now() - since >= stableMs) return last;
    }
    return last;
  }

  async navigate(href: string, timeoutMs = 15_000): Promise<RouteInfo> {
    await this.client.expoRouter.navigate(href);
    this.scrollOffset = 0;
    return this.client.expoRouter.waitForPathname(href.split('?')[0]!, timeoutMs);
  }

  async back(): Promise<boolean> {
    const ok = await this.client.expoRouter.back();
    this.scrollOffset = 0;
    await sleep(400);
    return ok;
  }

  // ---- interactions ----------------------------------------------------------------------------

  /**
   * Scrolls the main vertical scroll view. Default driver: through DevTools, by calling `scrollTo`
   * on the largest mounted ScrollView instance found in the fiber tree (exact offsets, no app edits).
   * `idb` sends a real touch swipe instead when available.
   */
  async scroll(direction: 'down' | 'up', amount: number): Promise<{ driver: string; offset: number }> {
    const mode = this.opts.interactions ?? 'cdp';
    if (mode === 'idb' && idbAvailable()) {
      const { width, height } = this.opts.screen ?? { width: 393, height: 852 };
      const x = Math.round(width / 2);
      const y1 = direction === 'down' ? Math.round(height * 0.75) : Math.round(height * 0.3);
      const y2 = direction === 'down' ? Math.max(60, y1 - amount) : Math.min(height - 60, y1 + amount);
      idbSwipe(this.opts.device.udid, x, y1, x, y2, 350);
      await sleep(900);
      this.scrollOffset = Math.max(0, this.scrollOffset + (direction === 'down' ? amount : -amount));
      return { driver: 'idb', offset: this.scrollOffset };
    }
    if (mode === 'none') return { driver: 'none', offset: this.scrollOffset };
    const next = Math.max(0, this.scrollOffset + (direction === 'down' ? amount : -amount));
    const result = await this.client.runtime.evaluate<string>(SCROLL_JS(next));
    if (result === 'no-scrollview') {
      // a screen without a vertical scroll view simply has nothing to scroll; the scenario goes on
      this.opts.log?.('scroll skipped: no vertical ScrollView mounted');
      return { driver: 'none', offset: this.scrollOffset };
    }
    if (result !== 'ok') throw new Error(`scroll failed: ${result}`);
    this.scrollOffset = next;
    await sleep(900);
    return { driver: 'cdp', offset: next };
  }

  async tap(target: { testID?: string; label?: string }): Promise<void> {
    const mode = this.opts.interactions ?? 'cdp';
    if (mode === 'none') return;
    const result = await this.client.runtime.evaluate<string>(TAP_JS(target));
    if (result !== 'ok') {
      if (mode === 'idb' && idbAvailable() && /x=(\d+),y=(\d+)/.test(result)) {
        const [, x, y] = /x=(\d+),y=(\d+)/.exec(result)!;
        idbTap(this.opts.device.udid, Number(x), Number(y));
      } else throw new Error(`tap failed: ${result}`);
    }
    await sleep(600);
  }

  screenshot(file: string): void {
    simScreenshot(this.opts.device.udid, file);
  }

  // ---- scenarios --------------------------------------------------------------------------------

  async runScenario(steps: ScenarioStep[], onMark?: (m: Mark) => void): Promise<Mark[]> {
    const marks: Mark[] = [];
    const mark = async (label: string) => {
      const m: Mark = { label, at: Date.now(), route: (await this.routeInfo())?.pathname };
      marks.push(m);
      onMark?.(m);
    };
    for (const step of steps) {
      switch (step.type) {
        case 'wait':
          await mark('settle');
          await sleep(step.ms);
          break;
        case 'scroll':
          await mark('scroll');
          await this.scroll(step.direction, step.amount);
          break;
        case 'tap':
          await mark('tap');
          await this.tap(step);
          break;
        case 'back':
          await mark('back');
          await this.back();
          break;
        case 'navigate':
          await mark('navigate');
          await this.navigate(step.href);
          break;
      }
    }
    await mark('end');
    return marks;
  }

  /** Records a trace around `steps`, with marks in the metadata for the analyzer's windows. */
  async record(steps: ScenarioStep[], opts: { categories?: string[]; before?: () => Promise<void>; label?: string } = {}): Promise<{ trace: TraceFile; marks: Mark[] }> {
    let marks: Mark[] = [];
    const trace = await this.client.tracing.record({
      categories: opts.categories,
      until: async () => {
        const start: Mark = { label: 'start', at: Date.now(), route: (await this.routeInfo())?.pathname };
        if (opts.before) await opts.before();
        marks = [start, ...(await this.runScenario(steps))];
      },
    });
    trace.metadata = { ...(trace.metadata ?? {}), marks, label: opts.label, pid: this.pid, metroUrl: this.opts.metroUrl, device: this.opts.device.name };
    return { trace, marks };
  }
}

async function waitForTarget(opts: SessionOptions, timeoutMs: number): Promise<InspectorTarget> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const targets = await listTargets(opts.metroUrl).catch(() => [] as InspectorTarget[]);
    const candidate = pickTarget(targets, { deviceName: opts.device.name, appId: opts.bundleId });
    if (candidate) return candidate;
    await sleep(400);
  }
  throw new Error(`App did not register an inspector page on ${opts.metroUrl} within ${timeoutMs} ms`);
}

async function waitForNoTarget(opts: SessionOptions, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const targets = await listTargets(opts.metroUrl).catch(() => [] as InspectorTarget[]);
    if (!pickTarget(targets, { deviceName: opts.device.name, appId: opts.bundleId })) return;
    await sleep(300);
  }
}

async function waitForRouter(client: DevToolsClient, timeoutMs: number): Promise<RouteInfo> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const ri = await client.expoRouter.routeInfo();
      if (ri && ri.pathname) return ri;
    } catch (e) {
      last = e;
    }
    await sleep(300);
  }
  throw new Error(`Expo Router did not report a route within ${timeoutMs} ms${last ? `: ${String(last)}` : ''}`);
}

/** Finds the largest mounted vertical ScrollView instance through the React DevTools hook and scrolls it. */
const SCROLL_JS = (offset: number) => `(function(){
  try {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__; if (!hook || !hook.renderers) return 'no-devtools-hook';
    var best = null, bestSize = -1;
    hook.renderers.forEach(function(_r, id){ hook.getFiberRoots(id).forEach(function(root){
      var stack = [root.current];
      while (stack.length) { var f = stack.pop(); if (!f) continue;
        var inst = f.stateNode;
        if (f.tag === 1 && inst && typeof inst.scrollTo === 'function' && !(f.memoizedProps && f.memoizedProps.horizontal)) {
          var size = 0, s2 = [f.child]; while (s2.length && size < 5000) { var g = s2.pop(); if (!g) continue; size++; if (g.child) s2.push(g.child); if (g.sibling) s2.push(g.sibling); }
          if (size > bestSize) { bestSize = size; best = inst; }
        }
        if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling);
      }
    }); });
    if (!best) return 'no-scrollview';
    best.scrollTo({ x: 0, y: ${offset}, animated: true });
    return 'ok';
  } catch (e) { return 'error: ' + (e && e.message || e); }
})()`;

const TAP_JS = (t: { testID?: string; label?: string }) => `(function(){
  try {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__; if (!hook || !hook.renderers) return 'no-devtools-hook';
    var testID = ${JSON.stringify(t.testID ?? null)}, label = ${JSON.stringify(t.label ?? null)};
    var found = null;
    hook.renderers.forEach(function(_r, id){ hook.getFiberRoots(id).forEach(function(root){
      var stack = [{ f: root.current, chain: [] }];
      while (stack.length && !found) { var e = stack.pop(); var f = e.f; if (!f) continue;
        var p = f.memoizedProps || {}; var chain = e.chain.concat([f]);
        var textMatch = label && (p.accessibilityLabel === label || p['aria-label'] === label || (typeof p.children === 'string' && p.children.trim() === label));
        if ((testID && p.testID === testID) || textMatch) { found = chain; break; }
        if (f.child) stack.push({ f: f.child, chain: chain }); if (f.sibling) stack.push({ f: f.sibling, chain: e.chain });
      }
    }); });
    if (!found) return 'not-found';
    for (var i = found.length - 1; i >= 0; i--) { var pp = found[i].memoizedProps || {}; if (typeof pp.onPress === 'function') { pp.onPress({ nativeEvent: {} }); return 'ok'; } }
    return 'no-onPress';
  } catch (e) { return 'error: ' + (e && e.message || e); }
})()`;
