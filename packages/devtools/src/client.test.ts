import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { CdpConnection } from './cdp.js';
import { DevToolsClient } from './client.js';
import type { InspectorTarget } from './types.js';

/**
 * A fake Fusebox page behind a fake Metro inspector proxy. It reproduces the two behaviours that
 * bit the spike: Expo terminates sockets whose Origin host is not 127.0.0.1, and the Debugger domain
 * must be disabled before Tracing.start.
 */
function fakePage(ws: WebSocket) {
  let debuggerEnabled = false;
  let tracing = false;
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  ws.on('message', (data) => {
    const { id, method, params } = JSON.parse(data.toString());
    const ok = (result: unknown = {}) => send({ id, result });
    const err = (code: number, message: string) => send({ id, error: { code, message } });
    switch (method) {
      case 'Runtime.evaluate': {
        const expr: string = params.expression;
        if (expr === '1+1') return ok({ result: { type: 'number', value: 2 } });
        if (expr.includes('router-store')) return ok({ result: { type: 'object', value: { pathname: '/search', segments: ['(tabs)', 'search'], params: {} } } });
        if (expr.includes('imperative-api') && expr.includes('navigate')) return ok({ result: { type: 'boolean', value: true } });
        if (expr.includes('boom')) return ok({ result: { type: 'undefined' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } } });
        if (expr.includes('rnStartupTiming')) return ok({ result: { type: 'object', value: { startTime: 1, endTime: 2 } } });
        return ok({ result: { type: 'undefined' } });
      }
      case 'Runtime.getHeapUsage':
        return ok({ totalSize: 100, usedSize: 50 });
      case 'Debugger.enable':
        debuggerEnabled = true;
        ok({ debuggerId: 'x' });
        send({ method: 'Debugger.scriptParsed', params: { scriptId: '6', url: 'http://127.0.0.1:8081/entry.bundle?platform=ios', sourceMapURL: 'http://127.0.0.1:8081/entry.map?platform=ios' } });
        send({ method: 'Debugger.scriptParsed', params: { scriptId: '2', url: '' } });
        return;
      case 'Debugger.disable':
        debuggerEnabled = false;
        return ok();
      case 'Tracing.start':
        if (debuggerEnabled) return err(-32603, 'Debugger domain is expected to be disabled before starting Tracing');
        if (tracing) return err(-32600, 'Tracing has already been started');
        if (typeof params.categories !== 'string') return err(-32602, 'categories must be a string');
        tracing = true;
        return ok();
      case 'Tracing.end':
        tracing = false;
        ok();
        send({ method: 'Tracing.dataCollected', params: { value: [{ name: 'TracingStartedInPage', cat: 'disabled-by-default-devtools.timeline', ph: 'I', ts: 1 }] } });
        send({ method: 'Tracing.dataCollected', params: { value: [{ name: 'TimeStamp', cat: 'devtools.timeline', ph: 'I', ts: 2, args: { data: { track: 'Components ⚛', name: 'Row' } } }] } });
        send({ method: 'Tracing.tracingComplete', params: { dataLossOccurred: false } });
        return;
      case 'Profiler.start':
        return ok();
      case 'Profiler.stop':
        return ok({ profile: { nodes: [{ id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 } }], startTime: 0, endTime: 1000, samples: [1], timeDeltas: [1000] } });
      case 'Profiler.enable':
      case 'HeapProfiler.enable':
        return err(-32601, `Unsupported method '${method}'`);
      case 'HeapProfiler.collectGarbage':
        return ok();
      case 'HeapProfiler.takeHeapSnapshot': {
        const snap = JSON.stringify({ snapshot: { meta: { node_fields: [], node_types: [], edge_fields: [], edge_types: [] }, node_count: 0, edge_count: 0 }, nodes: [], edges: [], strings: [] });
        send({ method: 'HeapProfiler.addHeapSnapshotChunk', params: { chunk: snap.slice(0, 20) } });
        send({ method: 'HeapProfiler.addHeapSnapshotChunk', params: { chunk: snap.slice(20) } });
        return ok();
      }
      default:
        return err(-32601, `Unsupported method '${method}'`);
    }
  });
}

let wss: WebSocketServer;
let port: number;
let target: InspectorTarget;

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once('listening', r));
  port = (wss.address() as AddressInfo).port;
  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (!origin) return ws.close(1008, 'no origin');
    if (new URL(origin).hostname !== '127.0.0.1') return ws.terminate(); // Expo CLI behaviour
    fakePage(ws);
  });
  target = {
    id: 'dev-1',
    title: 'app (iPhone 17)',
    description: 'React Native Bridgeless [C++ connection]',
    type: 'node',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?device=dev&page=1`,
    deviceName: 'iPhone 17',
    reactNative: { capabilities: { supportsMultipleDebuggers: true } },
  };
});

afterAll(() => wss.close());

describe('CdpConnection', () => {
  it('correlates replies, surfaces errors, and delivers notifications', async () => {
    const cdp = new CdpConnection(target.webSocketDebuggerUrl);
    await cdp.connect({ origin: `http://127.0.0.1:${port}` });
    const r = await cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true });
    expect(r.result.value).toBe(2);
    await expect(cdp.send('Profiler.enable')).rejects.toThrow(/Unsupported method/);
    const parsed = cdp.waitFor('Debugger.scriptParsed');
    await cdp.send('Debugger.enable');
    expect((await parsed).scriptId).toBe('6');
    cdp.close();
  });
});

describe('DevToolsClient', () => {
  it('falls back to a working Origin when the first candidate is terminated', async () => {
    const client = await DevToolsClient.connectTo(target, { metroUrl: `http://localhost:${port}`, probeTimeoutMs: 500 });
    expect(client.origin).toBe(`http://127.0.0.1:${port}`);
    client.disconnect();
  });

  it('records a trace after disabling the Debugger domain', async () => {
    const client = await DevToolsClient.connectTo(target, { origin: `http://127.0.0.1:${port}` });
    await client.cdp.send('Debugger.enable');
    const trace = await client.tracing.record({ durationMs: 10 });
    expect(trace.traceEvents.map((e) => e.name)).toEqual(['TracingStartedInPage', 'TimeStamp']);
    expect(trace.metadata).toMatchObject({ chunks: 2, dataLossOccurred: false });
    client.disconnect();
  });

  it('exposes profiler, heap, scripts, runtime and router helpers', async () => {
    const client = await DevToolsClient.connectTo(target, { origin: `http://127.0.0.1:${port}` });
    const profile = await client.profiler.record({ durationMs: 5 });
    expect(profile.samples).toEqual([1]);
    const snap = await client.heap.snapshot({ graceMs: 20 });
    expect(snap.parse().snapshot.node_count).toBe(0);
    expect(await client.runtime.heapUsage()).toEqual({ totalSize: 100, usedSize: 50 });
    const scripts = await client.scripts(20);
    expect(scripts).toEqual([{ scriptId: '6', url: 'http://127.0.0.1:8081/entry.bundle?platform=ios', sourceMapURL: 'http://127.0.0.1:8081/entry.map?platform=ios' }]);
    expect(await client.expoRouter.routeInfo()).toMatchObject({ pathname: '/search' });
    await client.expoRouter.navigate('/notifications');
    expect(await client.runtime.startupTiming()).toEqual({ startTime: 1, endTime: 2 });
    await expect(client.runtime.evaluate('throw new Error("boom")')).rejects.toThrow(/boom/);
    client.disconnect();
  });
});
