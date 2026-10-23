// SPDX-License-Identifier: Apache-2.0
// The admin panel's escaping guard (P4-03, THREAT_MODEL T13): it must fail on every way around JSX auto-escaping, pass the
// real sources, and ignore comments that only talk about the forbidden things.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSource as checkRuntime, webSourceDirs } from '../check-runtime-imports.ts';
import { checkAll, checkSource } from '../check-ui-escaping.ts';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('checkSource', () => {
  it.each([
    ['raw(value)', 'return raw(value);'],
    ['raw with a space', 'return raw (value);'],
    ['dangerouslySetInnerHTML', '<div dangerouslySetInnerHTML={{ __html: v }} />'],
    ['the hono/html helpers', "import { html } from 'hono/html';"],
    ['the hono/html helpers, double quotes', 'import { raw } from "hono/html";'],
    ['an html template with interpolation', 'const x = html`<b>${name}</b>`;'],
    ['an html template spanning lines', 'const x = html`\n<b>${name}</b>`;'],
    ['jsxTemplate', 'jsxTemplate`<p>${x}</p>`'],
    ['innerHTML', 'el.innerHTML = value;'],
    ['outerHTML', 'el.outerHTML = value;'],
    ['insertAdjacentHTML', "el.insertAdjacentHTML('beforeend', v);"],
    ['document.write', 'document.write(v);'],
    ['eval', 'eval(code);'],
    ['new Function', "new Function('return 1')"],
    ['a string timer', "setTimeout('run()', 10);"],
  ])('fails on %s', (_name, source) => {
    expect(checkSource('x.tsx', source)).toHaveLength(1);
  });

  it('accepts plain JSX, a function timer and an html word that is not a template', () => {
    for (const ok of [
      'return <p>{value}</p>;',
      'setTimeout(() => done(), 10);',
      'const html = render(node); return html;',
      'const x = `plain ${template}`;',
      'el.textContent = value;',
    ]) {
      expect(checkSource('x.tsx', ok), ok).toEqual([]);
    }
  });

  it('ignores comments that name the forbidden things, and reports real line numbers', () => {
    const source = [
      '// never use raw( here',
      '/* dangerouslySetInnerHTML',
      ' is forbidden */',
      'x = raw(v);',
    ].join('\n');
    const found = checkSource('x.tsx', source);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(4);
  });
});

describe('checkAll', () => {
  it('passes the real sources (admin-ui, its script asset and the HTTP app)', () => {
    expect(checkAll()).toEqual([]);
  });

  it('finds a planted violation in a scanned directory, and skips generated files', () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-ui-escaping-'));
    roots.push(root);
    mkdirSync(join(root, 'ui', 'screens'), { recursive: true });
    writeFileSync(join(root, 'ui', 'ok.tsx'), 'export const a = <p>{x}</p>;\n');
    writeFileSync(join(root, 'ui', 'screens', 'bad.tsx'), 'export const a = <p>{raw(x)}</p>;\n');
    writeFileSync(join(root, 'ui', 'assets.generated.ts'), 'const body = "el.innerHTML = x";\n');
    const found = checkAll(root, ['ui']);
    expect(found.map((v) => v.file)).toEqual([join('ui', 'screens', 'bad.tsx')]);
  });
});

describe('the web-runtime guard covers the panel (ADR-0004)', () => {
  it('scans packages/admin-ui/src, and fails on a Node import or global in a .tsx file', () => {
    const root = join(import.meta.dirname, '..', '..');
    expect(webSourceDirs(root).map((d) => d.replaceAll('\\', '/'))).toContain(
      join(root, 'packages', 'admin-ui', 'src').replaceAll('\\', '/'),
    );
    expect(checkRuntime('screens/x.tsx', "import { readFileSync } from 'node:fs';")).toHaveLength(1);
    expect(checkRuntime('screens/x.tsx', 'const k = process.env.KEY;')).toHaveLength(1);
    expect(checkRuntime('screens/x.tsx', 'const b = Buffer.from("x");')).toHaveLength(1);
  });
});

describe('the panel talks to the server only through the admin API (P4-03, L-095)', () => {
  it('imports nothing but hono and its own files: no storage, auth or core package', () => {
    const dir = join(import.meta.dirname, '..', '..', 'packages', 'admin-ui', 'src');
    const files = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)],
      );
    const imports = files(dir)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .flatMap((f) =>
        [...readFileSync(f, 'utf8').matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map(
          (m) => m[1] as string,
        ),
      );
    expect(imports.length).toBeGreaterThan(10);
    for (const spec of imports) expect(spec, spec).toMatch(/^(\.{1,2}\/|hono(\/|$))/);
  });
});
