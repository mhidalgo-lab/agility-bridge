// SPDX-License-Identifier: Apache-2.0
// ADR-0004: packages marked `"agilityBridge": { "runtime": "web" }` may only use web-standard APIs.
// Fails on Node built-in imports (`node:*` or bare builtin names) and common Node globals.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')));
const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
const GLOBAL_RE =
  /\b(process\.(?:env|argv|exit|exitCode|cwd|platform|nextTick|stdout|stderr|stdin)|Buffer\.|__dirname|__filename|require\()/g;

export interface Violation {
  file: string;
  line: number;
  message: string;
}

export function checkSource(file: string, source: string): Violation[] {
  const out: Violation[] = [];
  const lineOf = (index: number): number => source.slice(0, index).split('\n').length;
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? '';
    const bare = spec.split('/')[0] ?? '';
    if (spec.startsWith('node:') || BUILTINS.has(bare) || BUILTINS.has(spec)) {
      out.push({
        file,
        line: lineOf(m.index),
        message: `Node built-in import "${spec}" not allowed (ADR-0004)`,
      });
    }
  }
  for (const m of source.matchAll(GLOBAL_RE)) {
    out.push({ file, line: lineOf(m.index), message: `Node global "${m[1]}" not allowed (ADR-0004)` });
  }
  return out;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files; // no src directory yet
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) files.push(p);
  }
  return files;
}

/** Source directories of the workspace packages that declare the web runtime. */
export function webSourceDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const group of ['packages', 'apps']) {
    let names: string[];
    try {
      names = readdirSync(join(root, group));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, group, name, 'package.json'), 'utf8')) as {
          agilityBridge?: { runtime?: string };
        };
        if (pkg.agilityBridge?.runtime === 'web') dirs.push(join(root, group, name, 'src'));
      } catch {
        // not a package
      }
    }
  }
  return dirs;
}

export function findViolations(root: string): Violation[] {
  return webSourceDirs(root).flatMap((dir) =>
    walk(dir).flatMap((f) => checkSource(relative(root, f), readFileSync(f, 'utf8'))),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = findViolations(fileURLToPath(new URL('..', import.meta.url)));
  for (const v of violations) console.error(`✗ ${v.file}:${v.line} ${v.message}`);
  process.exit(violations.length === 0 ? 0 : 1);
}
