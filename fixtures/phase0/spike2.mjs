import fs from 'node:fs';
import { createRequire } from 'node:module';
const WS = createRequire(import.meta.url)('/Users/himanshukushwah/Documents/GitHub/mobile/node_modules/ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await (await fetch('http://localhost:8081/json')).json();
const out = {};
for (const t of targets) {
  const r = { title: t.title, id: t.id };
  out[t.id] = r;
  const ws = new WS(t.webSocketDebuggerUrl, { headers: { Origin: 'http://127.0.0.1:8081' } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0; const pending = new Map(); const chunks = [];
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } else if (m.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(m.params.chunk); });
  const send = (method, params = {}, to = 60000) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(method + ' timeout')); } }, to); ws.send(JSON.stringify({ id: i, method, params })); });
  const step = async (name, fn) => { try { r[name] = { ok: true, ...(await fn()) }; } catch (e) { r[name] = { ok: false, error: e.message }; } console.log(t.id, name, JSON.stringify(r[name]).slice(0, 300)); };
  await step('ping', async () => { const t0 = Date.now(); const x = await send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, 4000); return { value: x.result.value, ms: Date.now() - t0 }; });
  if (!r.ping.ok) { ws.close(); continue; }
  await step('Profiler.start/stop (no enable)', async () => {
    await send('Profiler.start');
    await sleep(1200);
    const { profile } = await send('Profiler.stop');
    fs.writeFileSync('out/profile.cpuprofile', JSON.stringify(profile));
    const js = profile.nodes.filter(n => n.callFrame.url).slice(0, 2);
    return { nodes: profile.nodes.length, samples: profile.samples.length, timeDeltas: profile.timeDeltas?.length, durationMs: (profile.endTime - profile.startTime) / 1000, sampleNodes: js };
  });
  await step('Profiler.setSamplingInterval', async () => { await send('Profiler.setSamplingInterval', { interval: 100 }); return {}; });
  await step('HeapProfiler.collectGarbage', async () => { await send('HeapProfiler.collectGarbage'); return {}; });
  await step('Runtime.getHeapUsage', async () => send('Runtime.getHeapUsage'));
  await step('HeapProfiler.takeHeapSnapshot (no enable)', async () => {
    chunks.length = 0; const t0 = Date.now();
    const res = await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 180000);
    await sleep(1000);
    const text = chunks.join(''); fs.writeFileSync('out/heap.heapsnapshot', text);
    let meta = {}; try { const s = JSON.parse(text); meta = { nodeCount: s.snapshot.node_count, edgeCount: s.snapshot.edge_count, nodeFields: s.snapshot.meta.node_fields, nodeTypes0: s.snapshot.meta.node_types[0].slice(0, 12), strings: s.strings.length, hasTraceInfo: !!s.trace_function_infos?.length, hasLocations: !!s.locations?.length }; } catch (e) { meta = { parseError: e.message }; }
    return { result: res, chunks: chunks.length, bytes: text.length, ms: Date.now() - t0, ...meta };
  });
  await step('HeapProfiler.startSampling/stopSampling', async () => { await send('HeapProfiler.startSampling', { samplingInterval: 32768 }); await sleep(800); const r2 = await send('HeapProfiler.stopSampling'); return { headKeys: Object.keys(r2.profile ?? {}), samples: r2.profile?.samples?.length }; });
  ws.close();
}
fs.writeFileSync('out/spike2-summary.json', JSON.stringify(out, null, 2));
