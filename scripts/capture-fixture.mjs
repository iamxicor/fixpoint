// Captures a richer trace fixture from the live reference app with the devtools package.
// Timeline: t0 trace start → navigate /timelines → 6 s (external scroll happens here) → /notifications → 2.5 s → back → 1.5 s → end.
import fs from 'node:fs';
import { DevToolsClient } from '../packages/devtools/dist/index.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.argv[2] ?? 'fixtures/phase0/trace-tabs-scroll-ios-sim.json';
const client = await DevToolsClient.connect({ metroUrl: 'http://localhost:8081', deviceName: 'iPhone 17' });
console.log('connected', client.target.id, 'origin', client.origin, 'route', JSON.stringify(await client.expoRouter.routeInfo()));
const marks = [];
const mark = async (label) => { marks.push({ label, at: Date.now(), route: (await client.expoRouter.routeInfo())?.pathname }); console.log(new Date().toISOString().slice(11, 23), label, marks.at(-1).route); };
const trace = await client.tracing.record({
  until: async () => {
    await mark('start');
    await client.expoRouter.navigate('/timelines'); await client.expoRouter.waitForPathname('/timelines'); await mark('timelines');
    await sleep(6000); await mark('after-scroll-window');
    await client.expoRouter.navigate('/notifications'); await client.expoRouter.waitForPathname('/notifications'); await mark('notifications');
    await sleep(2500);
    await client.expoRouter.back(); await sleep(1500); await mark('back');
    await client.expoRouter.navigate('/search'); await sleep(1000); await mark('home');
  },
});
trace.metadata = { ...trace.metadata, marks, capturedAt: new Date().toISOString(), app: 'reference app, iOS Simulator iPhone 17, dev build' };
fs.writeFileSync(out, JSON.stringify(trace));
const names = {}; for (const e of trace.traceEvents) names[e.name] = (names[e.name] ?? 0) + 1;
console.log('events', trace.traceEvents.length, JSON.stringify(names));
client.disconnect();
