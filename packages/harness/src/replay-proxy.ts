import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import type { ReplayMode } from './config.js';

export interface ReplayProxyOptions {
  upstream: string;
  dir: string;
  mode: ReplayMode;
  port?: number;
  /** Header names dropped from the key and from stored requests. */
  ignoreHeaders?: string[];
}

export interface StoredExchange {
  key: string;
  request: { method: string; path: string; bodySha1: string | null };
  response: { status: number; headers: Record<string, string>; bodyBase64: string };
  recordedAt: string;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'content-length', 'content-encoding']);

export function exchangeKey(method: string, path: string, body: Buffer | null): string {
  const bodySha1 = body && body.length ? createHash('sha1').update(body).digest('hex') : '';
  return createHash('sha1').update(`${method.toUpperCase()} ${path} ${bodySha1}`).digest('hex');
}

/**
 * Record-and-replay HTTP proxy in front of the app's API.
 *
 * - record: forward to upstream, store every response keyed by method + path + body hash.
 * - replay: serve stored responses only. Nothing is forwarded. A mutation without a recording
 *   gets a 200 `{}` stub; a read without a recording gets 404 with `x-fixpoint-replay: miss`.
 * - off: forward everything, store nothing.
 */
export class ReplayProxy {
  private server: http.Server | null = null;
  readonly stats = { hits: 0, misses: 0, recorded: 0, forwarded: 0, stubbed: 0 };
  port = 0;

  constructor(readonly opts: ReplayProxyOptions) {
    mkdirSync(opts.dir, { recursive: true });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<string> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port ?? 0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : this.opts.port ?? 0;
    return this.url;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private file(key: string): string {
    return join(this.opts.dir, `${key}.json`);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : null;
    const method = (req.method ?? 'GET').toUpperCase();
    const path = req.url ?? '/';
    const key = exchangeKey(method, path, body);
    const mode = this.opts.mode;
    if (mode === 'replay') {
      const stored = this.load(key);
      if (stored) {
        this.stats.hits++;
        return this.reply(res, stored.response, 'hit');
      }
      this.stats.misses++;
      if (MUTATING.has(method)) {
        this.stats.stubbed++;
        return this.reply(res, { status: 200, headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from('{}').toString('base64') }, 'stub');
      }
      return this.reply(res, { status: 404, headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(JSON.stringify({ error: 'fixpoint replay miss', method, path })).toString('base64') }, 'miss');
    }
    // record or off: forward
    try {
      const upstream = await this.forward(method, path, req.headers, body);
      this.stats.forwarded++;
      if (mode === 'record') {
        this.stats.recorded++;
        const stored: StoredExchange = { key, request: { method, path, bodySha1: body && body.length ? createHash('sha1').update(body).digest('hex') : null }, response: upstream, recordedAt: new Date().toISOString() };
        writeFileSync(this.file(key), JSON.stringify(stored));
      }
      return this.reply(res, upstream, mode === 'record' ? 'recorded' : 'forwarded');
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json', 'x-fixpoint-replay': 'upstream-error' });
      res.end(JSON.stringify({ error: 'fixpoint proxy upstream error', message: (e as Error).message }));
    }
  }

  private load(key: string): StoredExchange | null {
    const f = this.file(key);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8')) as StoredExchange;
  }

  private async forward(method: string, path: string, headers: http.IncomingHttpHeaders, body: Buffer | null): Promise<StoredExchange['response']> {
    const target = new URL(path, this.opts.upstream);
    const h = new Headers();
    for (const [k, v] of Object.entries(headers)) {
      if (!v || HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === 'host') continue;
      if (this.opts.ignoreHeaders?.includes(k.toLowerCase())) continue;
      h.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    h.set('host', target.host);
    h.set('accept-encoding', 'identity');
    const resp = await fetch(target, { method, headers: h, body: body && body.length && method !== 'GET' && method !== 'HEAD' ? body : undefined, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    const buf = Buffer.from(await resp.arrayBuffer());
    const outHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
    });
    return { status: resp.status, headers: outHeaders, bodyBase64: buf.toString('base64') };
  }

  private reply(res: http.ServerResponse, r: StoredExchange['response'], tag: string): void {
    const body = Buffer.from(r.bodyBase64, 'base64');
    res.writeHead(r.status, { ...r.headers, 'content-length': String(body.length), 'x-fixpoint-replay': tag });
    res.end(body);
  }
}
