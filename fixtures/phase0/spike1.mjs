#!/usr/bin/env node
// Fixpoint Phase 0 feasibility spike. Node >= 22 (global WebSocket). No dependencies.
// Usage: node spike.mjs [deeplink] [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
// Metro's inspector proxy only accepts debugger sockets whose Origin hostname is localhost/127.0.0.1
// (dev-middleware InspectorProxy.js verifyClient). Node's built-in WebSocket cannot set headers, so use `ws`.
const WS_PKG = process.env.WS_PKG ?? '/Users/himanshukushwah/Documents/GitHub/mobile/node_modules/ws';
const WebSocketImpl = createRequire(import.meta.url)(WS_PKG);

const METRO = process.env.METRO ?? 'http://localhost:8081';
const DEEPLINK = process.argv[2] ?? 'mymeli://notifications';
const DEEPLINK2 = process.argv[3] ?? 'mymeli://user';
const OUT = process.argv[4] ?? path.join(process.cwd(), 'out');
fs.mkdirSync(OUT, { recursive: true });

const summary = { metro: METRO, deeplink: DEEPLINK, startedAt: new Date().toISOString(), steps: {} };
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const record = (step, data) => { summary.steps[step] = data; log(`[${step}]`, JSON.stringify(data).slice(0, 600)); };

async function listTargets() {
  const out = {};
  for (const p of ['/json', '/json/list']) {
    try { const r = await fetch(METRO + p); out[p] = { status: r.status, body: await r.json() }; }
    catch (e) { out[p] = { error: String(e) }; }
  }
  return out;
}

function pickTarget(targets) {
  const list = targets['/json']?.body ?? targets['/json/list']?.body ?? [];
  const fusebox = list.filter((t) => t.reactNative?.capabilities);
  return fusebox.find((t) => /Hermes|Bridgeless/i.test(`${t.title} ${t.description}`)) ?? fusebox[0] ?? list[0];
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = []; this.log = []; }
  connect() {
    return new Promise((resolve, reject) => {
      // Expo CLI terminates debugger sockets whose Origin host != its serverBaseUrl host (observed: 127.0.0.1:8081,
      // even though /json reports localhost). dev-middleware additionally requires hostname localhost|127.0.0.1.
      const origin = process.env.ORIGIN ?? 'http://127.0.0.1:8081';
      this.ws = new WebSocketImpl(this.url, { headers: { Origin: origin }, perMessageDeflate: false, maxPayload: 0 });
      this.ws.on('open', () => resolve());
      this.ws.on('close', (c, r) => { this.closed = { code: c, reason: r?.toString() }; log('ws closed', c, r?.toString()); });
      this.ws.on('error', (e) => reject(new Error('ws error ' + (e.message ?? ''))));
      this.ws.on('unexpected-response', (_req, res) => reject(new Error(`ws unexpected response ${res.statusCode}`)));
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, method } = this.pending.get(msg.id); this.pending.delete(msg.id);
          this.log.push({ dir: '<', id: msg.id, method, result: msg.error ?? (JSON.stringify(msg.result).length > 2000 ? '<large>' : msg.result) });
          if (msg.error) reject(Object.assign(new Error(`${method}: ${msg.error.message}`), { cdp: msg.error })); else resolve(msg.result);
        } else if (msg.method) { for (const l of [...this.listeners]) l(msg); }
      });
    });
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    this.log.push({ dir: '>', id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: timeout ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); }, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((l) => l !== fn); }; }
  waitFor(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error(`waitFor ${method}: timeout`)); }, timeoutMs);
      const off = this.on((m) => { if (m.method === method) { clearTimeout(t); off(); resolve(m.params); } });
    });
  }
  close() { this.ws?.close(); }
}

async function tryStep(name, fn) {
  try { const r = await fn(); record(name, { ok: true, ...(r ?? {}) }); return r ?? {}; }
  catch (e) { record(name, { ok: false, error: e.message, cdp: e.cdp }); return null; }
}

function openUrl(url) { execFileSync('xcrun', ['simctl', 'openurl', 'booted', url], { stdio: 'pipe' }); }

// Categories React Native's TracingAgent understands (TracingCategory.h). Unknown tokens are ignored.
const CATEGORIES = [
  '-*',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-devtools.timeline.frame',
].join(',');

const top = (o, n = 25) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);

async function main() {
  const targets = await listTargets();
  const target = pickTarget(targets);
  record('listTargets', {
    endpoints: Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, v.status ?? v.error])),
    count: (targets['/json']?.body ?? []).length,
    picked: target && { id: target.id, title: target.title, description: target.description, ws: target.webSocketDebuggerUrl, capabilities: target.reactNative?.capabilities },
  });
  fs.writeFileSync(path.join(OUT, 'targets.json'), JSON.stringify(targets, null, 2));
  if (!target) throw new Error('no inspector target');

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  record('connect', { url: target.webSocketDebuggerUrl });
  const eventsSeen = {};
  cdp.on((m) => { eventsSeen[m.method] = (eventsSeen[m.method] ?? 0) + 1; });

  // --- 2. Runtime.enable / Debugger.enable → scriptParsed → sourceMapURL
  const scripts = [];
  const offScripts = cdp.on((m) => { if (m.method === 'Debugger.scriptParsed') scripts.push({ scriptId: m.params.scriptId, url: m.params.url, sourceMapURL: m.params.sourceMapURL, hasSourceURL: m.params.hasSourceURL }); });
  await tryStep('Runtime.enable', () => cdp.send('Runtime.enable'));
  await tryStep('Debugger.enable', async () => { const r = await cdp.send('Debugger.enable'); await sleep(1500); return { debuggerId: r?.debuggerId, scriptsParsed: scripts.length, sample: scripts.slice(0, 3) }; });
  offScripts();
  fs.writeFileSync(path.join(OUT, 'scripts.json'), JSON.stringify(scripts, null, 2));
  await tryStep('sourceMapFetch', async () => {
    const s = scripts.find((s) => s.sourceMapURL);
    if (!s) return { found: false };
    const t0 = Date.now();
    const r = await fetch(s.sourceMapURL);
    const text = await r.text();
    const sm = JSON.parse(text);
    fs.writeFileSync(path.join(OUT, 'bundle.map.json'), text);
    return { found: true, url: s.sourceMapURL, status: r.status, bytes: text.length, ms: Date.now() - t0, version: sm.version, sources: sm.sources?.length, names: sm.names?.length, x_facebook_sources: !!sm.x_facebook_sources, sampleSources: sm.sources?.filter((x) => x.includes('/app/')).slice(0, 3) };
  });
  // Tracing.start is rejected while the Debugger domain is enabled (TracingAgent.cpp).
  await tryStep('Debugger.disable', () => cdp.send('Debugger.disable'));

  // --- 3. Tracing
  const traceEvents = [];
  let chunks = 0;
  const offTrace = cdp.on((m) => { if (m.method === 'Tracing.dataCollected') { chunks++; traceEvents.push(...(m.params.value ?? [])); } });
  const started = await tryStep('Tracing.start', () => cdp.send('Tracing.start', { categories: CATEGORIES, options: 'sampling-frequency=10000', transferMode: 'ReportEvents' }));
  if (started) {
    const t0 = Date.now();
    await sleep(300);
    openUrl(DEEPLINK);
    await sleep(2000);
    const complete = cdp.waitFor('Tracing.tracingComplete', 60000);
    await tryStep('Tracing.end', () => cdp.send('Tracing.end'));
    await tryStep('Tracing.tracingComplete', async () => { const p = await complete; return { params: p, chunks, events: traceEvents.length, wallMs: Date.now() - t0 }; });
    offTrace();
    fs.writeFileSync(path.join(OUT, 'trace.json'), JSON.stringify({ traceEvents }));

    // --- 4. Analyse
    const byCat = {}, byName = {}, tracks = {}, trackGroups = {}, userTimingNames = {};
    let profileChunks = 0, samples = 0, profiles = 0;
    for (const e of traceEvents) {
      byCat[e.cat] = (byCat[e.cat] ?? 0) + 1;
      byName[e.name] = (byName[e.name] ?? 0) + 1;
      if (e.name === 'TimeStamp') { const d = e.args?.data ?? {}; if (d.track) tracks[d.track] = (tracks[d.track] ?? 0) + 1; if (d.trackGroup) trackGroups[d.trackGroup] = (trackGroups[d.trackGroup] ?? 0) + 1; }
      if (e.cat === 'blink.user_timing' && (e.ph === 'b' || e.ph === 'I')) userTimingNames[e.name] = (userTimingNames[e.name] ?? 0) + 1;
      if (e.name === 'ProfileChunk') { profileChunks++; samples += e.args?.data?.cpuProfile?.samples?.length ?? 0; }
      if (e.name === 'Profile') profiles++;
    }
    const componentsTrack = Object.keys(tracks).find((t) => t.startsWith('Components'));
    const schedulerGroup = Object.keys(trackGroups).find((t) => t.startsWith('Scheduler'));
    const componentSample = traceEvents.filter((e) => e.name === 'TimeStamp' && e.args?.data?.track === componentsTrack).slice(0, 6).map((e) => e.args.data);
    const schedulerSample = traceEvents.filter((e) => e.name === 'TimeStamp' && e.args?.data?.trackGroup === schedulerGroup).slice(0, 6).map((e) => e.args.data);
    const metadataSample = traceEvents.filter((e) => e.ph === 'M').slice(0, 8);
    record('traceAnalysis', { byCat, topNames: top(byName), tracks, trackGroups, userTimingTop: top(userTimingNames, 15), profiles, profileChunks, samples, metadataSample });
    record('assertReactTracks', { componentsTrack, schedulerGroup, componentsTrackPresent: !!componentsTrack, schedulerGroupPresent: !!schedulerGroup, samplingProfilePresent: profileChunks > 0, componentSample, schedulerSample });
  }

  // --- 5. Profiler domain
  await tryStep('Profiler', async () => {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
    openUrl(DEEPLINK2);
    await sleep(1500);
    const { profile } = await cdp.send('Profiler.stop');
    await cdp.send('Profiler.disable');
    fs.writeFileSync(path.join(OUT, 'profile.cpuprofile'), JSON.stringify(profile));
    const hits = {};
    for (const n of profile.nodes ?? []) { const k = `${n.callFrame.functionName || '(anonymous)'} ${path.basename((n.callFrame.url || '').split('?')[0])}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`; hits[k] = (hits[k] ?? 0) + (n.hitCount ?? 0); }
    return { nodes: profile.nodes?.length, samples: profile.samples?.length, durationMs: (profile.endTime - profile.startTime) / 1000, topSelf: top(hits, 12) };
  });

  // --- 6. HeapProfiler
  await tryStep('HeapProfiler.takeHeapSnapshot', async () => {
    await cdp.send('HeapProfiler.enable');
    let n = 0, bytes = 0; const parts = [];
    const off = cdp.on((m) => { if (m.method === 'HeapProfiler.addHeapSnapshotChunk') { n++; bytes += m.params.chunk.length; parts.push(m.params.chunk); } });
    const t0 = Date.now();
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 180000);
    await sleep(800);
    off();
    const text = parts.join('');
    fs.writeFileSync(path.join(OUT, 'heap.heapsnapshot'), text);
    let meta;
    try { const snap = JSON.parse(text); meta = { nodeCount: snap.snapshot?.node_count, edgeCount: snap.snapshot?.edge_count, nodeFields: snap.snapshot?.meta?.node_fields, stringsCount: snap.strings?.length }; }
    catch (e) { meta = { parseError: e.message }; }
    await cdp.send('HeapProfiler.disable');
    return { chunks: n, bytes, ms: Date.now() - t0, ...meta };
  });

  // --- 7. Runtime.evaluate probes
  await tryStep('Runtime.evaluate', async () => {
    const expr = `(function(){
      var st = (typeof performance !== 'undefined' && performance.rnStartupTiming) || null;
      var s = st ? { startTime: st.startTime, endTime: st.endTime, initializeRuntimeStart: st.initializeRuntimeStart, initializeRuntimeEnd: st.initializeRuntimeEnd, executeJavaScriptBundleEntryPointStart: st.executeJavaScriptBundleEntryPointStart, executeJavaScriptBundleEntryPointEnd: st.executeJavaScriptBundleEntryPointEnd } : null;
      return JSON.stringify({
        hermes: typeof HermesInternal !== 'undefined' ? (HermesInternal.getRuntimeProperties ? HermesInternal.getRuntimeProperties() : true) : false,
        consoleTimeStamp: typeof console.timeStamp,
        performanceMeasure: typeof performance !== 'undefined' ? typeof performance.measure : 'no-performance',
        rnStartupTiming: s,
        memory: (typeof performance !== 'undefined' && performance.memory) ? { jsHeapSizeLimit: performance.memory.jsHeapSizeLimit, totalJSHeapSize: performance.memory.totalJSHeapSize, usedJSHeapSize: performance.memory.usedJSHeapSize } : null,
        reactDevToolsHook: typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined' ? Object.keys(__REACT_DEVTOOLS_GLOBAL_HOOK__).slice(0,25) : null,
        dev: typeof __DEV__ !== 'undefined' ? __DEV__ : null,
        bridgeless: typeof globalThis.RN$Bridgeless !== 'undefined' ? globalThis.RN$Bridgeless : null,
        requireKeys: typeof __r === 'function' ? Object.keys(__r).slice(0,10) : null
      });
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return { value: JSON.parse(r.result.value) };
  });

  record('eventsSeen', eventsSeen);
  fs.writeFileSync(path.join(OUT, 'cdp-log.json'), JSON.stringify(cdp.log, null, 2));
  fs.writeFileSync(path.join(OUT, 'spike-summary.json'), JSON.stringify(summary, null, 2));
  cdp.close();
  log('done →', OUT);
}

main().catch((e) => { console.error('FATAL', e); fs.writeFileSync(path.join(OUT, 'spike-summary.json'), JSON.stringify(summary, null, 2)); process.exit(1); });
