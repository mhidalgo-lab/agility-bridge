// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anchorsOf,
  checkDocLinks,
  isPage,
  linksOf,
  pageUrl,
  rewriteHref,
  rewriteLinks,
  slugOf,
  sync,
  toPage,
} from '../docs-site.ts';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ab-docs-site-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('anchorsOf', () => {
  it('slugs headings like GitHub, numbers duplicates and ignores code fences', () => {
    const md = '# A title\n## 5. Cloudflare Workers platform\n## Same\n## Same\n```\n## in code\n```\n';
    expect([...anchorsOf(md)]).toEqual(['a-title', '5-cloudflare-workers-platform', 'same', 'same-1']);
  });
});

describe('linksOf', () => {
  it('finds links that span lines and skips code', () => {
    const md =
      'See [the admin\npanel](admin.md#x) and `[no](code.md)`.\n```\n[no](fence.md)\n```\n[ref]: ref.md\n';
    expect(linksOf(md)).toEqual([
      { line: 2, href: 'admin.md#x' },
      { line: 6, href: 'ref.md' },
    ]);
  });
});

describe('checkDocLinks', () => {
  const base = {
    'docs/a.md': '# A\n\n## Part\n',
    'README.md': '# readme\n',
  };

  it('accepts links to files, folders, anchors and files outside docs/', () => {
    const root = repo({
      ...base,
      'docs/guide/b.md':
        '# B\n[a](../a.md#part) [self](#top) [root](../../README.md) [dir](../guide/)\n## Top\n',
    });
    expect(checkDocLinks(root)).toEqual([]);
  });

  it('reports a missing file and a missing anchor with the line', () => {
    const root = repo({
      ...base,
      'docs/guide/b.md': '# B\n[gone](nope.md)\n[bad](../a.md#missing)\n',
    });
    const problems = checkDocLinks(root).map((p) => `${p.file}:${p.line} ${p.message.split(' (')[0]}`);
    expect(problems).toEqual([
      'docs/guide/b.md:2 broken link "nope.md"',
      'docs/guide/b.md:3 broken anchor "../a.md#missing"',
    ]);
  });

  it('reports a link that leaves the repository', () => {
    const root = repo({ ...base, 'docs/b.md': '# B\n[x](../../outside.md)\n' });
    expect(checkDocLinks(root)).toHaveLength(1);
  });
});

describe('site pages', () => {
  it('excludes the planning folders and templates', () => {
    expect(isPage('guide/cli.md')).toBe(true);
    expect(isPage('ARCHITECTURE.md')).toBe(true);
    expect(isPage('tasks/phase-1/P1-01.md')).toBe(false);
    expect(isPage('pending-decisions/phase-8.md')).toBe(false);
    expect(isPage('tasks/_template.md')).toBe(false);
  });

  it('derives slugs the way Starlight does', () => {
    expect(slugOf('THREAT_MODEL.md')).toBe('threat_model');
    expect(slugOf('adr/README.md')).toBe('adr');
    expect(slugOf('guide/Quickstart-local.md')).toBe('guide/quickstart-local');
    expect(pageUrl('/agility-bridge', 'guide/cli')).toBe('/agility-bridge/guide/cli/');
  });

  // Created per test: the afterEach hook removes the temporary folders.
  let root = '';
  beforeEach(() => {
    root = repo({
      'docs/guide/a.md': '# A\n',
      'docs/tasks/T.md': '# T\n',
      'packages/core/src/x.ts': '',
      'packages/core/README.md': '# core\n',
    });
  });

  it('rewrites links to pages, excluded docs, files and folders', () => {
    const b = '/base';
    expect(rewriteHref('guide/b.md', 'a.md#x', root, b)).toBe('/base/guide/a/#x');
    expect(rewriteHref('guide/b.md', '../tasks/T.md', root, b)).toBe(
      'https://github.com/mhidalgo-lab/agility-bridge/blob/main/docs/tasks/T.md',
    );
    expect(rewriteHref('guide/b.md', '../../packages/core/src/x.ts', root, b)).toBe(
      'https://github.com/mhidalgo-lab/agility-bridge/blob/main/packages/core/src/x.ts',
    );
    expect(rewriteHref('guide/b.md', '../../packages/core', root, b)).toBe(
      'https://github.com/mhidalgo-lab/agility-bridge/tree/main/packages/core',
    );
    expect(rewriteHref('guide/b.md', 'https://example.com/a.md', root, b)).toBe('https://example.com/a.md');
    expect(rewriteHref('guide/b.md', '#local', root, '/base')).toBe('/base/guide/b/#local');
  });

  it('rewrites links outside code only', () => {
    const md = '[a](a.md) `[a](a.md)`\n```\n[a](a.md)\n```\n';
    expect(rewriteLinks('guide/b.md', md, root, '/base')).toBe(
      '[a](/base/guide/a/) `[a](a.md)`\n```\n[a](a.md)\n```\n',
    );
  });

  it('turns the first heading into the title and adds the edit link', () => {
    const page = toPage('guide/b.md', '<!-- generated -->\n\n# Tools: "all"\n\nBody [a](a.md).\n', root, '');
    expect(page).toBe(
      [
        '---',
        'title: "Tools: \\"all\\""',
        'editUrl: https://github.com/mhidalgo-lab/agility-bridge/edit/main/docs/guide/b.md',
        '---',
        '<!-- generated -->',
        '',
        '',
        'Body [a](/guide/a/).',
        '',
      ].join('\n'),
    );
    expect(() => toPage('x.md', 'no heading', root, '')).toThrow(/no top-level heading/);
  });

  it('writes the included pages and the landing page', () => {
    const r = repo({
      'docs/guide/a.md': '# A\n',
      'docs/adr/README.md': '# ADRs\n',
      'docs/tasks/T.md': '# T\n',
      'site/landing.md': '---\ntitle: Home\n---\n[go](/guide/a/)\n',
    });
    const out = join(r, 'site/src/content/docs');
    sync(r, out, '/b');
    expect(readFileSync(join(out, 'index.md'), 'utf8')).toContain('[go](/b/guide/a/)');
    expect(readFileSync(join(out, 'adr/index.md'), 'utf8')).toContain('title: "ADRs"');
    expect(() => readFileSync(join(out, 'tasks/t.md'))).toThrow();
  });
});
