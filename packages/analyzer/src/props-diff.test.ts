import { describe, expect, it } from 'vitest';
import { parsePropsDiff } from './trace/props-diff.js';

const NB = ' ';

describe('parsePropsDiff', () => {
  it('classifies deeply equal values, callbacks, children and elements', () => {
    const d = parsePropsDiff([
      ['Changed Props', ''],
      [`–${NB}style`, '{"padding":8}'],
      [`+${NB}style`, '{"padding":8}'],
      [`${NB}${NB}onPress`, '() => {} Referentially unequal function closure. Consider memoization.'],
      [`–${NB}children`, '…'],
      [`+${NB}children`, '…'],
      [`–${NB}icon`, '<Icon … />'],
      [`+${NB}icon`, '<Icon … />'],
    ])!;
    expect(d.changes.map((c) => [c.key, c.kind])).toEqual([
      ['style', 'deep-equal'],
      ['onPress', 'callback'],
      ['children', 'children'],
      ['icon', 'element'],
    ]);
    expect(d.deepEqualOnly).toBe(false);
    expect(d.callbackOnly).toBe(true);
    expect(d.childrenOnly).toBe(false);
  });

  it('flags a diff where only equal values changed identity as deeply equal', () => {
    const d = parsePropsDiff([
      ['Changed Props', ''],
      [`–${NB}data`, '[1,2,3]'],
      [`+${NB}data`, '[1,2,3]'],
    ])!;
    expect(d.deepEqualOnly).toBe(true);
    expect(d.callbackOnly).toBe(false);
  });

  it('flags children-only diffs and real changes', () => {
    expect(parsePropsDiff([['Changed Props', ''], [`–${NB}children`, '…'], [`+${NB}children`, '…']])?.childrenOnly).toBe(true);
    const real = parsePropsDiff([['Changed Props', ''], [`–${NB}count`, '1'], [`+${NB}count`, '2']])!;
    expect(real.changes[0]?.kind).toBe('changed');
    expect(real.deepEqualOnly).toBe(false);
  });

  it('returns null for anything that is not a props diff', () => {
    expect(parsePropsDiff([['Component name', 'X']])).toBeNull();
    expect(parsePropsDiff(undefined)).toBeNull();
  });
});
