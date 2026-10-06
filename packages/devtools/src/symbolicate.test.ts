import { describe, expect, it } from 'vitest';
import { SourceMapGenerator } from 'source-map';
import { Symbolicator, isCompilerTemporary, normalizeBundleUrl } from './symbolicate.js';

const BUNDLE = 'http://127.0.0.1:8081/app/entry.bundle//&platform=ios&dev=true';

function buildMap() {
  const gen = new SourceMapGenerator({ file: 'entry.bundle' });
  const source = '/Users/me/app/components/Row.tsx';
  const content = [
    'export function Row(props) {',
    '  const handlePress = useCallback(() => props.onPress(props.id), [props]);',
    '  const style = { padding: 8 };',
    '  return <Pressable onPress={handlePress} style={style} />;',
    '}',
  ].join('\n');
  gen.setSourceContent(source, content);
  // generated line 10 col 5 → original line 2 col 2 (`const handlePress`), no name (compiler temp)
  gen.addMapping({ generated: { line: 10, column: 5 }, original: { line: 2, column: 2 }, source });
  // generated line 11 col 3 → original line 1 col 16 with a name
  gen.addMapping({ generated: { line: 11, column: 3 }, original: { line: 1, column: 16 }, source, name: 'Row' });
  // generated line 12 col 9 → original line 2 col 22 (inside the callback) no name
  gen.addMapping({ generated: { line: 12, column: 9 }, original: { line: 2, column: 22 }, source });
  return gen.toJSON();
}

describe('Symbolicator', () => {
  it('resolves positions and strips React Compiler temporaries back to the declared identifier', async () => {
    const sym = new Symbolicator(async () => null, { rootDir: '/Users/me/app' });
    sym.addMap(BUNDLE, buildMap());
    const frames = await sym.frames([
      { functionName: 't0', scriptId: '6', url: BUNDLE, lineNumber: 10, columnNumber: 5 },
      { functionName: 'Row', scriptId: '6', url: BUNDLE, lineNumber: 11, columnNumber: 3 },
      { functionName: 't3', scriptId: '6', url: BUNDLE, lineNumber: 12, columnNumber: 9 },
      { functionName: 'native', scriptId: '7', url: 'NativeRequest.__native_constructor__', lineNumber: 1, columnNumber: 0 },
    ]);
    expect(frames[0]).toMatchObject({ symbol: 'handlePress', file: 'components/Row.tsx', line: 2 });
    expect(frames[1]).toMatchObject({ symbol: 'Row', file: 'components/Row.tsx', line: 1, column: 16 });
    expect(frames[2]).toMatchObject({ symbol: 'handlePress', line: 2 });
    expect(frames[3]).toMatchObject({ symbol: 'native', file: null });
  });

  it('loads maps lazily per bundle URL and caches misses', async () => {
    let calls = 0;
    const sym = new Symbolicator(async () => {
      calls++;
      return null;
    });
    const frame = { functionName: 'x', scriptId: '1', url: 'http://h/a.bundle?p=1', lineNumber: 1, columnNumber: 0 };
    await sym.frame(frame);
    await sym.frame(frame);
    expect(calls).toBe(1);
  });

  it('recognises compiler temporaries and normalises bundle URLs', () => {
    expect(isCompilerTemporary('t0')).toBe(true);
    expect(isCompilerTemporary('t12')).toBe(true);
    expect(isCompilerTemporary('tick')).toBe(false);
    expect(normalizeBundleUrl(BUNDLE)).toBe('http://127.0.0.1:8081/app/entry.bundle?platform=ios&dev=true');
  });
});
