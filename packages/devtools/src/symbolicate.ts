import { SourceMapConsumer, type RawSourceMap } from 'source-map';
import type { CallFrame, SymbolicatedFrame } from './types.js';
import { sourceMapUrlForBundle } from './metro.js';

/** React Compiler names hoisted temporaries `t0`, `t1`, … and memo-cache slots `$[n]`. */
export function isCompilerTemporary(name: string | undefined | null): boolean {
  return !!name && /^t\d+$/.test(name);
}

export interface SymbolicateOptions {
  /** Strip this prefix from original file paths (normally the app root). */
  rootDir?: string;
}

export type MapLoader = (bundleUrl: string) => Promise<RawSourceMap | null>;

/**
 * Symbolicates bundle frames with Metro source maps. One consumer per bundle URL: with
 * `lazy=true` each lazily loaded bundle has its own map (verified in Phase 0).
 */
export class Symbolicator {
  private readonly consumers = new Map<string, SourceMapConsumer | null>();
  private readonly raws = new Map<string, RawSourceMap>();

  constructor(
    private readonly loader: MapLoader,
    private readonly opts: SymbolicateOptions = {},
  ) {}

  /** Preload a map for a bundle URL from an already-parsed object (used by tests and offline analysis). */
  addMap(bundleUrl: string, raw: RawSourceMap): void {
    this.raws.set(normalizeBundleUrl(bundleUrl), raw);
    this.consumers.set(normalizeBundleUrl(bundleUrl), new SourceMapConsumer(raw));
  }

  async consumerFor(bundleUrl: string): Promise<SourceMapConsumer | null> {
    const key = normalizeBundleUrl(bundleUrl);
    if (this.consumers.has(key)) return this.consumers.get(key)!;
    const raw = this.raws.get(key) ?? (await this.loader(bundleUrl));
    const consumer = raw ? new SourceMapConsumer(raw) : null;
    if (raw) this.raws.set(key, raw);
    this.consumers.set(key, consumer);
    return consumer;
  }

  async frame(frame: CallFrame): Promise<SymbolicatedFrame> {
    const base: SymbolicatedFrame = {
      functionName: frame.functionName,
      symbol: frame.functionName || '(anonymous)',
      file: null,
      line: null,
      column: null,
      generated: { url: frame.url, line: frame.lineNumber, column: frame.columnNumber },
    };
    if (!frame.url || !/\.bundle/.test(frame.url) || !(frame.lineNumber >= 1)) return base;
    const consumer = await this.consumerFor(frame.url);
    if (!consumer) return base;
    // Hermes reports 1-based lines and 0-based columns, which is exactly what source-map expects.
    const pos = consumer.originalPositionFor({ line: frame.lineNumber, column: frame.columnNumber });
    if (!pos.source) return base;
    const file = this.relativize(pos.source);
    let symbol = frame.functionName;
    if (!symbol || isCompilerTemporary(symbol)) {
      symbol = pos.name ?? inferIdentifier(consumer, pos.source, pos.line, pos.column) ?? (symbol || '(anonymous)');
    }
    return { ...base, symbol, file, line: pos.line, column: pos.column };
  }

  async frames(frames: CallFrame[]): Promise<SymbolicatedFrame[]> {
    const out: SymbolicatedFrame[] = [];
    for (const f of frames) out.push(await this.frame(f));
    return out;
  }

  private relativize(source: string): string {
    const root = this.opts.rootDir;
    if (root && source.startsWith(root)) return source.slice(root.length).replace(/^\/+/, '');
    return source;
  }
}

/**
 * When the map has no `name` for a position (common for React Compiler output), read the original
 * source line and take the identifier being declared or called there, e.g. `const handlePress = …`.
 */
function inferIdentifier(consumer: SourceMapConsumer, source: string, line: number | null, column: number | null): string | null {
  if (line == null) return null;
  let content: string | null = null;
  try {
    content = consumer.sourceContentFor(source, true);
  } catch {
    content = null;
  }
  if (!content) return null;
  const text = content.split('\n')[line - 1];
  if (!text) return null;
  const after = text.slice(column ?? 0);
  const declAt = /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/.exec(after);
  if (declAt) return declAt[1]!;
  const before = text.slice(0, column ?? text.length);
  const decl = /(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)\s*(?:=|\()?[^=]*$/.exec(before);
  if (decl) return decl[1]!;
  const prop = /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*$/.exec(before);
  if (prop) return prop[1]!;
  const call = /([A-Za-z_$][\w$]*)\s*\(\s*$/.exec(before);
  if (call && !/^(if|for|while|switch|return)$/.test(call[1]!)) return call[1]!;
  return null;
}

/** Bundle URLs carry a `//&` artefact in Hermes frames; the map URL ignores it. */
export function normalizeBundleUrl(url: string): string {
  return url.replace(/\.bundle\/\/&?/, '.bundle?').replace(/\?&/, '?');
}

/** Default loader: fetch `<bundle>.map` from Metro. */
export function fetchMapLoader(fetchImpl: typeof fetch = fetch): MapLoader {
  return async (bundleUrl) => {
    const mapUrl = sourceMapUrlForBundle(normalizeBundleUrl(bundleUrl));
    if (!mapUrl) return null;
    const res = await fetchImpl(mapUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    return (await res.json()) as RawSourceMap;
  };
}
