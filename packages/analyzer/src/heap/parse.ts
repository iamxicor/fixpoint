import type { HeapSnapshot } from '@fixpoint/devtools';

/**
 * Per-constructor aggregate of a V8-format heap snapshot. Only `nodes` and `strings` are read, so a
 * 200 MB Hermes snapshot can be reduced without materialising the edge array.
 */
export interface HeapAggregate {
  nodeCount: number;
  totalSelfSize: number;
  byConstructor: Map<string, { count: number; selfSize: number; type: string }>;
}

export function aggregateSnapshot(input: HeapSnapshot | string): HeapAggregate {
  if (typeof input === 'string') return aggregateFromText(input);
  const meta = input.snapshot.meta;
  const fields = meta.node_fields;
  const typeIdx = fields.indexOf('type');
  const nameIdx = fields.indexOf('name');
  const sizeIdx = fields.indexOf('self_size');
  const types = (meta.node_types[typeIdx] as string[]) ?? [];
  return aggregate(input.nodes, fields.length, typeIdx, nameIdx, sizeIdx, types, input.strings);
}

function aggregate(nodes: ArrayLike<number>, stride: number, typeIdx: number, nameIdx: number, sizeIdx: number, types: string[], strings: string[]): HeapAggregate {
  const by = new Map<string, { count: number; selfSize: number; type: string }>();
  let total = 0;
  const n = Math.floor(nodes.length / stride);
  for (let i = 0; i < n; i++) {
    const base = i * stride;
    const type = types[nodes[base + typeIdx]!] ?? 'unknown';
    const name = strings[nodes[base + nameIdx]!] ?? '';
    const size = nodes[base + sizeIdx]! | 0;
    total += size;
    const key = `${type}:${name}`;
    const e = by.get(key);
    if (e) {
      e.count++;
      e.selfSize += size;
    } else by.set(key, { count: 1, selfSize: size, type });
  }
  return { nodeCount: n, totalSelfSize: total, byConstructor: by };
}

/** Streams `snapshot.meta`, `nodes` and `strings` out of the raw JSON text without parsing `edges`. */
export function aggregateFromText(text: string): HeapAggregate {
  const metaStart = text.indexOf('"snapshot"');
  const metaObj = extractObject(text, text.indexOf('{', metaStart));
  const snapshot = JSON.parse(metaObj) as HeapSnapshot['snapshot'];
  const fields = snapshot.meta.node_fields;
  const typeIdx = fields.indexOf('type');
  const nameIdx = fields.indexOf('name');
  const sizeIdx = fields.indexOf('self_size');
  const types = (snapshot.meta.node_types[typeIdx] as string[]) ?? [];
  const nodes = readIntArray(text, '"nodes"');
  const strings = readStringArray(text, '"strings"');
  return aggregate(nodes, fields.length, typeIdx, nameIdx, sizeIdx, types, strings);
}

function extractObject(text: string, start: number): string {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('unterminated object in heap snapshot');
}

function readIntArray(text: string, key: string): Int32Array {
  const k = text.indexOf(key);
  if (k < 0) throw new Error(`${key} not found in heap snapshot`);
  const start = text.indexOf('[', k);
  const end = text.indexOf(']', start);
  const slice = text.slice(start + 1, end);
  if (slice.trim() === '') return new Int32Array(0);
  // Count commas first to allocate once.
  let count = 1;
  for (let i = 0; i < slice.length; i++) if (slice.charCodeAt(i) === 44) count++;
  const out = new Int32Array(count);
  let n = 0;
  let acc = 0;
  let seen = false;
  for (let i = 0; i < slice.length; i++) {
    const c = slice.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      acc = acc * 10 + (c - 48);
      seen = true;
    } else if (c === 44) {
      out[n++] = acc;
      acc = 0;
      seen = false;
    }
  }
  if (seen || n < count) out[n++] = acc;
  return n === count ? out : out.subarray(0, n);
}

function readStringArray(text: string, key: string): string[] {
  const k = text.lastIndexOf(key);
  if (k < 0) throw new Error(`${key} not found in heap snapshot`);
  const start = text.indexOf('[', k);
  // The strings array is the last array in the file; parse it with JSON.parse on its exact span.
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as string[];
    }
  }
  throw new Error('unterminated strings array in heap snapshot');
}

export interface HeapGrowthRow {
  constructor: string;
  type: string;
  countBefore: number;
  countAfter: number;
  delta: number;
  bytesDelta: number;
}

export function diffAggregates(before: HeapAggregate, after: HeapAggregate): HeapGrowthRow[] {
  const rows: HeapGrowthRow[] = [];
  for (const [key, a] of after.byConstructor) {
    const b = before.byConstructor.get(key);
    const delta = a.count - (b?.count ?? 0);
    if (delta === 0) continue;
    const [type, ...rest] = key.split(':');
    rows.push({ constructor: rest.join(':') || '(anonymous)', type: type ?? 'unknown', countBefore: b?.count ?? 0, countAfter: a.count, delta, bytesDelta: a.selfSize - (b?.selfSize ?? 0) });
  }
  return rows.sort((x, y) => y.delta - x.delta);
}
