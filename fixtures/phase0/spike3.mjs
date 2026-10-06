import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const WS = createRequire(import.meta.url)('/Users/himanshukushwah/Documents/GitHub/mobile/node_modules/ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sim = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']).toString());
const booted = Object.values(sim.devices).flat().find((d) => d.state === 'Booted');
log('booted simulator:', booted.name, booted.udid);
const appPid = () => { try { return execFileSync('xcrun', ['simctl', 'spawn', 'booted', 'launchctl', 'list']).toString().split('\n').find((l) => l.includes('com.mymeli.mobile'))?.trim().split(/\s+/)[0]; } catch { return null; } };
const listTargets = async () => (await (await fetch('http://localhost:8081/json')).json());
const pickSim = (ts) => ts.find((t) => t.deviceName === booted.name && t.reactNative?.capabilities) ?? ts.find((t) => t.title.includes(booted.name));
const openUrl = (u) => execFileSync('xcrun', ['simctl', 'openurl', 'booted', u], { stdio: 'pipe' });
const out = { booted: booted.name, steps: {} };
const rec = (k, v) => { out.steps[k] = v; log(`[${k}]`, JSON.stringify(v).slice(0, 700)); };

async function connect(t) {
  const ws = new WS(t.webSocketDebuggerUrl, { headers: { Origin: 'http://127.0.0.1:8081' } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0; const pending = new Map(); const events = [];
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } else if (m.method) events.push(m); });
  const send = (method, params = {}, to = 60000) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(method + ' timeout')); } }, to); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true }, 8000); return r.result?.value; };
  return { ws, send, evaluate, events, close: () => ws.close() };
}
const ROUTE_PROBE = `(function(){ try {
  var mods = __r.getModules(); var found = null;
  for (var k in mods) { var m = mods[k]; var n = m && m.verboseName; if (n && /expo-router\\/build\\/global-state\\/router-store\\.js$/.test(n)) { found = m; break; } }
  if (!found) return JSON.stringify({ error: 'router-store module not found' });
  var ex = found.publicModule && found.publicModule.exports; var store = ex && ex.store;
  var info = store && (typeof store.getRouteInfo === 'function' ? store.getRouteInfo() : store.routeInfo);
  return JSON.stringify({ exportKeys: ex ? Object.keys(ex) : null, storeKeys: store ? Object.keys(store).slice(0, 40) : null, routeInfo: info ? { pathname: info.pathname, segments: info.segments, params: info.params } : null });
} catch (e) { return JSON.stringify({ error: String(e) }); } })()`;

let targets = await listTargets();
rec('targets', targets.map((t) => ({ id: t.id, deviceName: t.deviceName, title: t.title })));
let target = pickSim(targets); rec('pickedSimTarget', { id: target?.id, deviceName: target?.deviceName, pid: appPid() });
let cdp = await connect(target);
const probe = async () => { try { return JSON.parse(await cdp.evaluate(ROUTE_PROBE)); } catch (e) { return { error: e.message }; } };
rec('routeProbe.initial', await probe());

// Deep link formats
const formats = ['mymeli://notifications', 'mymeli:///notifications', 'mymeli://--/notifications', 'mymeli://(authenticated)/(tabs)/notifications', 'mymeli://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081&__fixpoint_skip=1'];
const dl = {};
for (const f of formats.slice(0, 4)) {
  const before = (await probe()).routeInfo?.pathname;
  openUrl(f); await sleep(2500);
  const after = await probe();
  dl[f] = { before, after: after.routeInfo?.pathname ?? after.error, targetsNow: (await listTargets()).length };
  log('deeplink', f, '→', JSON.stringify(dl[f]));
  // return home
  openUrl('mymeli://search'); await sleep(1500);
}
rec('deepLinkFormats', dl);
const working = Object.entries(dl).find(([, v]) => v.after && v.after.includes('notifications'))?.[0];
rec('workingDeepLink', { working });

// Simulator-only fixtures: cpuprofile during navigation, heap snapshot
try {
  await cdp.send('Profiler.start');
  openUrl(working ?? 'mymeli://notifications'); await sleep(1500);
  const { profile } = await cdp.send('Profiler.stop');
  fs.writeFileSync('out/sim-profile.cpuprofile', JSON.stringify(profile));
  const js = profile.nodes.find((n) => n.callFrame.url && n.callFrame.url.includes('bundle'));
  rec('sim.cpuprofile', { nodes: profile.nodes.length, samples: profile.samples.length, durationMs: (profile.endTime - profile.startTime) / 1000, sampleJsNode: js?.callFrame });
  openUrl('mymeli://search'); await sleep(1500);
} catch (e) { rec('sim.cpuprofile', { error: e.message }); }
try {
  const chunks = []; const h = (m) => { if (m.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(m.params.chunk); };
  cdp.ws.on('message', (d) => { const m = JSON.parse(d.toString()); h(m); });
  const t0 = Date.now(); await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 180000); await sleep(1000);
  const text = chunks.join(''); fs.writeFileSync('out/sim-heap.heapsnapshot', text);
  const s = JSON.parse(text);
  rec('sim.heapsnapshot', { bytes: text.length, ms: Date.now() - t0, nodeCount: s.snapshot.node_count, edgeCount: s.snapshot.edge_count, pidAfter: appPid() });
} catch (e) { rec('sim.heapsnapshot', { error: e.message }); }
rec('routeProbe.beforeSwitch', await probe());
cdp.close();

// Dev-client Metro switch deep link (same Metro): observe process + target changes
const pidBefore = appPid(); const tBefore = (await listTargets()).map((t) => t.id);
const switchUrl = 'mymeli://expo-development-client/?url=' + encodeURIComponent('http://127.0.0.1:8081');
openUrl(switchUrl);
const timeline = [];
for (let i = 0; i < 40; i++) { await sleep(500); const ts = (await listTargets()).map((t) => t.id); const pid = appPid(); const last = timeline[timeline.length - 1]; const entry = { t: (i + 1) * 0.5, pid, targets: ts.join(',') }; if (!last || last.pid !== entry.pid || last.targets !== entry.targets) timeline.push(entry); }
rec('devClientSwitch', { url: switchUrl, pidBefore, targetsBefore: tBefore, timeline, pidAfter: appPid(), processSurvived: appPid() === pidBefore });
execFileSync('xcrun', ['simctl', 'io', 'booted', 'screenshot', 'out/after-switch.png'], { stdio: 'pipe' });
try { targets = await listTargets(); target = pickSim(targets); cdp = await connect(target); rec('routeProbe.afterSwitch', await probe()); cdp.close(); } catch (e) { rec('routeProbe.afterSwitch', { error: e.message }); }
fs.writeFileSync('out/spike3-summary.json', JSON.stringify(out, null, 2));
log('done');
