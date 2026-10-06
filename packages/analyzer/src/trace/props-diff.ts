/**
 * Parses the `properties` array React 19.2 attaches to a changed-props render measure
 * (`detail.devtools.properties`). Format, from ReactFabric-dev.js `addObjectDiffToProperties`:
 *
 *   ["Changed Props", ""]
 *   ["– key", oldValue]      removed or changed, previous value
 *   ["+ key", newValue]      added or changed, next value
 *   ["  key", "() => {} Referentially unequal function closure. Consider memoization."]
 *   nested keys are indented with "  " per level; elements print as "<Name … />"; "…" is an elided value.
 */

export type PropChangeKind = 'deep-equal' | 'callback' | 'children' | 'element' | 'changed' | 'unknown';

export interface PropChange {
  key: string;
  kind: PropChangeKind;
  before?: string;
  after?: string;
  note?: string;
}

export interface PropsDiff {
  changes: PropChange[];
  /** Every non-children change is a deeply equal value or an elided placeholder: the render was avoidable with memoisation. */
  deepEqualOnly: boolean;
  /** Only functions changed identity (plus possibly children). */
  callbackOnly: boolean;
  /** Only `children` changed (parent re-rendered and produced new elements). */
  childrenOnly: boolean;
}

const MINUS = '– ';
const PLUS = '+ ';
const NOTE = '  ';

export function parsePropsDiff(properties: unknown): PropsDiff | null {
  if (!Array.isArray(properties)) return null;
  const rows = properties as [string, string][];
  if (rows.length === 0 || rows[0]?.[0] !== 'Changed Props') return null;
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  const notes = new Map<string, string>();
  const order: string[] = [];
  for (const [rawKey, value] of rows.slice(1)) {
    if (typeof rawKey !== 'string') continue;
    if (rawKey.startsWith(MINUS)) {
      const key = rawKey.slice(MINUS.length);
      if (!order.includes(key)) order.push(key);
      before.set(key, String(value));
    } else if (rawKey.startsWith(PLUS)) {
      const key = rawKey.slice(PLUS.length);
      if (!order.includes(key)) order.push(key);
      after.set(key, String(value));
    } else if (rawKey.startsWith(NOTE)) {
      const key = rawKey.slice(NOTE.length);
      if (!order.includes(key)) order.push(key);
      notes.set(key, String(value));
    }
  }
  const changes: PropChange[] = order.map((key) => {
    const top = !key.startsWith(' ');
    const name = key.replace(/^ +/, '');
    const b = before.get(key);
    const a = after.get(key);
    const note = notes.get(key);
    let kind: PropChangeKind = 'changed';
    if (top && name === 'children') kind = 'children';
    else if (note && /function closure/i.test(note)) kind = 'callback';
    else if (b !== undefined && a !== undefined && b === a) kind = b.startsWith('<') ? 'element' : 'deep-equal';
    else if (b === undefined && a === undefined && note) kind = 'unknown';
    return { key: name, kind, before: b, after: a, note };
  });
  const nonChildren = changes.filter((c) => c.kind !== 'children');
  const deepEqualOnly = nonChildren.length > 0 && nonChildren.every((c) => c.kind === 'deep-equal' || c.kind === 'element');
  const callbackOnly = nonChildren.length > 0 && nonChildren.every((c) => c.kind === 'callback' || c.kind === 'deep-equal' || c.kind === 'element') && nonChildren.some((c) => c.kind === 'callback');
  const childrenOnly = nonChildren.length === 0 && changes.length > 0;
  return { changes, deepEqualOnly, callbackOnly, childrenOnly };
}
