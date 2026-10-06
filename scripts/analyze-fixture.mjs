import fs from 'node:fs';
import { analyze, renderTable } from '../packages/analyzer/dist/index.js';
import { Symbolicator } from '../packages/devtools/dist/index.js';
const [traceFile, mapFile] = process.argv.slice(2);
const trace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
let symbolicate;
if (mapFile) {
  const sym = new Symbolicator(async () => null, { rootDir: '/Users/himanshukushwah/Documents/GitHub/mobile' });
  const raw = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  const bundleUrl = trace.traceEvents.find((e) => e.name === 'ProfileChunk')?.args.data.cpuProfile.nodes.find((n) => n.callFrame.url?.includes('bundle'))?.callFrame.url;
  sym.addMap(bundleUrl, raw);
  symbolicate = (frames) => sym.frames(frames);
}
const t0 = Date.now();
const out = await analyze({ trace, symbolicate, appRoot: '/Users/himanshukushwah/Documents/GitHub/mobile', context: { route: process.argv[4] ?? '/timelines' } });
console.log(renderTable(out, 25));
console.log(`\n${out.findings.length} findings in ${Date.now() - t0} ms; kinds:`, Object.fromEntries(out.findings.reduce((m, f) => m.set(f.kind, (m.get(f.kind) ?? 0) + 1), new Map())));
fs.writeFileSync(process.argv[5] ?? '/tmp/findings.json', JSON.stringify(out, null, 2));
