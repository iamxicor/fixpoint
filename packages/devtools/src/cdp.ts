import WebSocket from 'ws';

export class CdpError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number | undefined,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
  }
}

export interface CdpNotification {
  method: string;
  params: any;
}

export interface CdpConnectOptions {
  /**
   * Value for the `Origin` header. Metro's inspector proxy rejects sockets without one (HTTP 401) and
   * Expo CLI terminates sockets whose Origin host differs from its server base URL (close 1006).
   */
  origin: string;
  /** Milliseconds to wait for the socket to open. */
  connectTimeoutMs?: number;
}

type Pending = { resolve: (r: any) => void; reject: (e: Error) => void; method: string; timer: NodeJS.Timeout };

/**
 * Minimal Chrome DevTools Protocol connection over a `ws` socket: request/response correlation,
 * notifications, and a message log that can be written to disk as evidence.
 */
export class CdpConnection {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private listeners: ((n: CdpNotification) => void)[] = [];
  readonly log: { dir: '>' | '<' | '!'; at: number; method?: string; id?: number; payload?: unknown }[] = [];
  closed: { code: number; reason: string } | null = null;

  constructor(readonly url: string) {}

  async connect(opts: CdpConnectOptions): Promise<void> {
    const ws = new WebSocket(this.url, {
      headers: { Origin: opts.origin },
      perMessageDeflate: false,
      maxPayload: 0,
    });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout to ${this.url}`)), opts.connectTimeoutMs ?? 10_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`CDP socket error for ${this.url}: ${(e as Error).message}`));
      });
      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`CDP upgrade refused for ${this.url}: HTTP ${res.statusCode}`));
      });
    });
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.log.push({ dir: '!', at: Date.now(), payload: { close: code, reason: reason.toString() } });
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new CdpError(p.method, undefined, `socket closed (${code}) before reply`));
        this.pending.delete(id);
      }
    });
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private onMessage(text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      this.log.push({ dir: '<', at: Date.now(), id: msg.id, method: p.method, payload: msg.error ?? summarize(msg.result) });
      if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message));
      else p.resolve(msg.result);
    } else if (typeof msg.method === 'string') {
      for (const l of [...this.listeners]) l({ method: msg.method, params: msg.params });
    }
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (!this.isOpen) return Promise.reject(new CdpError(method, undefined, 'socket is not open'));
    const id = ++this.nextId;
    this.log.push({ dir: '>', at: Date.now(), id, method, payload: params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(method, undefined, `no reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  on(listener: (n: CdpNotification) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  waitFor<T = any>(method: string, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${method} (${timeoutMs} ms)`));
      }, timeoutMs);
      const off = this.on((n) => {
        if (n.method === method) {
          clearTimeout(timer);
          off();
          resolve(n.params as T);
        }
      });
    });
  }

  close(): void {
    this.ws?.close();
  }
}

function summarize(result: unknown): unknown {
  const text = JSON.stringify(result);
  return text && text.length > 2_000 ? `<${text.length} bytes>` : result;
}
