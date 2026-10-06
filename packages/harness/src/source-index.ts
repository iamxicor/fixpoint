import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import type { CompilerBailout, Location } from '@fixpoint/analyzer';

export const SOURCE_DIRS_DEFAULT = ['app', 'src', 'components', 'hooks', 'screens', 'features', 'lib', 'utils', 'stores', 'store', 'providers', 'melements', 'melements-v2', 'melements-components', 'challenges'];
const SOURCE_EXT = /\.(tsx?|jsx?)$/;
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__mocks__', 'ios', 'android', '.expo', 'dist', 'build', '.git']);

export function listSourceFiles(appRoot: string, dirs = SOURCE_DIRS_DEFAULT): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith('.') || SKIP_DIRS.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (SOURCE_EXT.test(e) && !/\.(test|spec|d|stories)\.[tj]sx?$/.test(e)) out.push(relative(appRoot, p));
    }
  };
  for (const d of dirs) walk(join(appRoot, d));
  return out.sort();
}

const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Z][A-Za-z0-9_$]*)|(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:React\.)?(?:memo|forwardRef|observer|styled[\w.]*|withRestyle)?\s*\(?\s*(?:\(|function|async|<)?)/;
const HOOK = /^(?:export\s+)?(?:async\s+)?(?:function\s+(use[A-Z][A-Za-z0-9_$]*)|(?:const|let|var)\s+(use[A-Z][A-Za-z0-9_$]*)\s*=)/;

/** Maps component and hook names to `file:line` by scanning declarations. Later files do not override earlier app/ matches. */
export function indexComponents(appRoot: string, files = listSourceFiles(appRoot)): Record<string, Location> {
  const out: Record<string, Location> = {};
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(appRoot, file), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = DECL.exec(line) ?? HOOK.exec(line);
      if (!m) continue;
      const name = m[1] ?? m[2];
      if (!name || out[name]) continue;
      out[name] = { file, line: i + 1, column: 0, symbol: name };
    }
  }
  return out;
}

/**
 * Runs babel-plugin-react-compiler from the app's own node_modules over the app source and collects
 * `CompileError` events. No app file is modified.
 */
export function collectCompilerBailouts(appRoot: string, files = listSourceFiles(appRoot)): { bailouts: CompilerBailout[]; compiled: number; errors: string[] } {
  const req = createRequire(join(appRoot, 'package.json'));
  let babel: any;
  let pluginName: string;
  try {
    babel = req('@babel/core');
    pluginName = req.resolve('babel-plugin-react-compiler');
  } catch (e) {
    return { bailouts: [], compiled: 0, errors: [`React Compiler not available in ${appRoot}: ${(e as Error).message}`] };
  }
  const presetTs = tryResolve(req, '@babel/preset-typescript');
  const jsx = tryResolve(req, '@babel/plugin-transform-react-jsx');
  const bailouts: CompilerBailout[] = [];
  const errors: string[] = [];
  let compiled = 0;
  for (const file of files) {
    if (!/\.(tsx|jsx)$/.test(file) && !/\.(ts|js)$/.test(file)) continue;
    const abs = join(appRoot, file);
    const events: any[] = [];
    try {
      babel.transformSync(readFileSync(abs, 'utf8'), {
        filename: abs,
        configFile: false,
        babelrc: false,
        presets: presetTs ? [[presetTs, { isTSX: /\.tsx$/.test(file), allExtensions: true }]] : [],
        plugins: [[pluginName, { logger: { logEvent: (_f: string, e: any) => events.push(e) } }], ...(jsx ? [[jsx, {}]] : [])],
        code: false,
      });
      compiled++;
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message.split('\n')[0]}`);
      continue;
    }
    const seen = new Set<string>();
    for (const e of events) {
      if (e?.kind !== 'CompileError') continue;
      const fnLine = e.fnLoc?.start?.line ?? null;
      const detail = e.detail?.options?.details?.[0];
      const key = `${fnLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bailouts.push({ file, line: fnLine, column: e.fnLoc?.start?.column ?? null, fn: functionNameAt(abs, fnLine), reason: String(e.detail?.options?.reason ?? e.detail?.reason ?? 'compiler bailout'), detail: detail?.message ?? null });
    }
  }
  return { bailouts, compiled, errors };
}

function tryResolve(req: NodeJS.Require, id: string): string | null {
  try {
    return req.resolve(id);
  } catch {
    return null;
  }
}

function functionNameAt(absFile: string, line: number | null): string | null {
  if (!line) return null;
  try {
    const lines = readFileSync(absFile, 'utf8').split('\n');
    for (let i = line - 1; i >= Math.max(0, line - 4); i--) {
      const m = DECL.exec(lines[i] ?? '') ?? HOOK.exec(lines[i] ?? '') ?? /(?:function\s+|const\s+|let\s+)([A-Za-z_$][\w$]*)/.exec(lines[i] ?? '');
      const name = m?.[1] ?? m?.[2];
      if (name) return name;
    }
  } catch {
    // ignore
  }
  return null;
}
