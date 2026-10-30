// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildMcpServer, defineTool } from '../../src/index.ts';
import { addLinks, assetLink, LINK_BUDGET_CHARS, linkNote } from '../../src/output/links.ts';
import { makeContext } from '../helpers/context.ts';
import { rpc } from '../helpers/mcp.ts';

const BASE = 'https://agility.example.com/SyntheticInstance';

describe('assetLink', () => {
  it('builds the link from the pinned base and the OID or number', () => {
    expect(assetLink(BASE, { assetType: 'Story', oid: 'Story:1234', number: 'B-01234' })).toBe(
      `${BASE}/assetdetail.v1?oid=Story:1234`,
    );
    expect(assetLink(BASE, { assetType: 'Story', number: 'B-01234' })).toBe(
      `${BASE}/assetdetail.v1?number=B-01234`,
    );
    expect(assetLink(`${BASE}/`, { assetType: 'Defect', oid: 'Defect:7' })).toBe(
      `${BASE}/assetdetail.v1?oid=Defect:7`,
    );
  });

  it.each([
    ['an OID with a host', { assetType: 'Story', oid: 'Story:1@evil.example' }],
    ['an OID with a path', { assetType: 'Story', oid: 'Story:1/../../x' }],
    ['an OID with a query', { assetType: 'Story', oid: 'Story:1?x=1' }],
    ['an OID with a fragment', { assetType: 'Story', oid: 'Story:1#x' }],
    ['an OID of another type', { assetType: 'Story', oid: 'Member:20' }],
    ['a number with a space', { assetType: 'Story', number: 'B-1 2' }],
    ['a number with a slash', { assetType: 'Story', number: 'B-1/x' }],
    ['a number with a newline', { assetType: 'Story', number: 'B-1\n' }],
    ['an asset type with a slash', { assetType: 'Story/x', number: 'B-1' }],
    ['no identity', { assetType: 'Story' }],
    ['no asset type', { oid: 'Story:1' }],
    ['non-string values', { assetType: 'Story', oid: 5, number: {} }],
  ])('gives no link for %s', (_name, identity) => {
    expect(assetLink(BASE, identity)).toBeUndefined();
  });

  it('gives no link when the pinned base is not a plain origin', () => {
    for (const base of [
      'not a url',
      'ftp://x.example/a',
      `${BASE}?q=1`,
      `${BASE}#f`,
      'https://u:p@x.example/a',
    ])
      expect(assetLink(base, { assetType: 'Story', number: 'B-1' })).toBeUndefined();
    expect(linkNote('not a url')).toBeUndefined();
  });
});

type Row = Record<string, unknown>;

describe('addLinks', () => {
  it('links asset rows at any depth and leaves everything else alone', () => {
    const link = { name: 'Spec', url: 'https://evil.example/x' };
    const input = {
      items: [
        {
          number: 'B-1',
          assetType: 'Story',
          oid: 'Story:1',
          name: 'x',
          project: { oid: 'Scope:5', name: 'P' },
        },
        { assetType: 'Defect', number: 'D-2', url: 'https://agility-text.example/' },
        { assetType: 'Story', name: 'no identity' },
      ] as Row[],
      children: { rows: [{ assetType: 'Task', oid: 'Task:9', name: 't' }] as Row[] },
      links: [link],
    };
    const { value, linked } = addLinks(BASE, input);
    expect(linked).toBe(2);
    expect(value.items[0]?.['url']).toBe(`${BASE}/assetdetail.v1?oid=Story:1`);
    expect(value.items[0]?.['project']).toEqual({ oid: 'Scope:5', name: 'P' });
    expect(value.items[1]?.['url']).toBe('https://agility-text.example/');
    expect(value.items[2]).not.toHaveProperty('url');
    expect(value.children.rows[0]?.['url']).toBe(`${BASE}/assetdetail.v1?oid=Task:9`);
    expect(value.links[0]).toBe(link);
    expect(input.items[0]).not.toHaveProperty('url');
  });

  it('returns the same value when nothing is linked', () => {
    const input = { items: [{ name: 'x' }], notes: ['a'] };
    const out = addLinks(BASE, input);
    expect(out.value).toBe(input);
    expect(out.linked).toBe(0);
  });

  it('keeps every url on the pinned origin whatever the rows hold', () => {
    const hostile = [
      'Story:1',
      'Story:1.evil.example',
      'Story:1@evil.example',
      'B-1',
      '//evil.example',
      'B-1%0d',
    ];
    const items: Row[] = hostile.flatMap((v) => [
      { assetType: 'Story', oid: v },
      { assetType: 'Story', number: v },
    ]);
    const { value } = addLinks(BASE, { items });
    for (const item of value.items) {
      if (item['url'] === undefined) continue;
      const u = new URL(String(item['url']));
      expect(u.origin).toBe('https://agility.example.com');
      expect(u.pathname).toBe('/SyntheticInstance/assetdetail.v1');
      expect(u.hash).toBe('');
    }
  });
});

describe('deep links stay cheap and bounded (P8-40)', () => {
  const rows = (n: number): Row[] =>
    Array.from({ length: n }, (_, i) => ({
      assetType: 'Story',
      oid: `Story:${100_000 + i}`,
      number: `B-${100_000 + i}`,
    }));

  it('parses the base once for a whole result, not once per row', () => {
    const Real = URL;
    let parsed = 0;
    vi.stubGlobal(
      'URL',
      class extends Real {
        constructor(...args: ConstructorParameters<typeof URL>) {
          parsed++;
          super(...args);
        }
      },
    );
    try {
      const { linked } = addLinks(BASE, { items: rows(200) });
      expect(linked).toBe(200);
      expect(parsed).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the characters links add under the cap, and says how many rows got none', () => {
    const { value, linked, omitted } = addLinks(BASE, { items: rows(1_000) });
    expect(linked + omitted).toBe(1_000);
    expect(omitted).toBeGreaterThan(0);
    const urls = value.items.flatMap((i) => (typeof i['url'] === 'string' ? [i['url']] : []));
    expect(urls).toHaveLength(linked);
    // What the links add to the serialised result, byte for byte: each is `,"url":"<link>"`.
    const bytes = JSON.stringify(value).length - JSON.stringify({ items: rows(1_000) }).length;
    expect(bytes).toBeLessThanOrEqual(LINK_BUDGET_CHARS);
    // The rows that fit are the first ones, and every link is still the strict pinned form.
    expect(value.items[0]?.['url']).toBe(`${BASE}/assetdetail.v1?oid=Story:100000`);
    expect(value.items[linked]).not.toHaveProperty('url');
    for (const u of urls)
      expect(u).toMatch(
        /^https:\/\/agility\.example\.com\/SyntheticInstance\/assetdetail\.v1\?oid=Story:\d+$/,
      );
    expect(linkNote(BASE, omitted)).toContain(`${omitted} more row(s) have no url`);
    expect(linkNote(BASE)).not.toContain('more row');
  });

  it('links every row of an ordinary result', () => {
    const { linked, omitted } = addLinks(BASE, { items: rows(100) });
    expect({ linked, omitted }).toEqual({ linked: 100, omitted: 0 });
  });

  it('a Link asset keeps its own url and costs no budget', () => {
    const items = [{ assetType: 'Link', oid: 'Link:1', url: 'https://x.example/' }, ...rows(1)];
    const { value, linked } = addLinks(BASE, { items }, 100);
    expect(value.items[0]?.['url']).toBe('https://x.example/');
    expect(linked).toBe(1);
  });
});

describe('deep links through the server', () => {
  const rows = defineTool({
    name: 'rows_test',
    title: 'Rows',
    description: 'Return two asset rows and one non-asset object (test tool).',
    kind: 'read',
    group: 'core',
    cost: 0,
    inputSchema: z.object({}),
    handler: async () => ({
      text: 'Two rows.',
      structured: { items: [{ assetType: 'Story', oid: 'Story:1', number: 'B-1' }, { oid: 'Scope:3' }] },
    }),
  });
  const many = defineTool({
    name: 'many_test',
    title: 'Many',
    description: 'Return a thousand asset rows (test tool).',
    kind: 'read',
    group: 'core',
    cost: 0,
    inputSchema: z.object({}),
    handler: async () => ({
      text: 'Rows.',
      structured: {
        items: Array.from({ length: 1_000 }, (_, i) => ({ assetType: 'Story', oid: `Story:${100_000 + i}` })),
      },
    }),
  });
  const none = defineTool({
    name: 'none_test',
    title: 'None',
    description: 'Return no asset rows (test tool).',
    kind: 'read',
    group: 'core',
    cost: 0,
    inputSchema: z.object({}),
    handler: async () => ({ text: 'Nothing.', structured: { items: [] } }),
  });

  it('adds at most the link budget to a thousand rows and says so in the one note', async () => {
    const ctx = makeContext();
    const res = await rpc(() => buildMcpServer({ tools: [many], ctx }), 'tools/call', {
      name: 'many_test',
      arguments: {},
    });
    const items = (res['structuredContent'] as { items: Array<Record<string, unknown>> }).items;
    const linked = items.filter((i) => 'url' in i).length;
    expect(linked).toBeGreaterThan(100);
    expect(linked).toBeLessThan(1_000);
    const added = JSON.stringify(items).length - JSON.stringify(items.map(({ url: _u, ...r }) => r)).length;
    expect(added).toBeLessThanOrEqual(LINK_BUDGET_CHARS);
    const text = (res['content'] as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain(`${1_000 - linked} more row(s) have no url`);
    expect(text.split('\n')).toHaveLength(2);
  });

  it('adds url and one fixed note, only when something was linked', async () => {
    const ctx = makeContext();
    const call = (name: string) =>
      rpc(() => buildMcpServer({ tools: [rows, none], ctx }), 'tools/call', { name, arguments: {} });
    const hit = await call('rows_test');
    const sc = hit['structuredContent'] as { items: Array<Record<string, unknown>> };
    expect(sc.items[0]?.['url']).toBe(`${BASE}/assetdetail.v1?oid=Story:1`);
    expect(sc.items[1]).toEqual({ oid: 'Scope:3' });
    const text = (hit['content'] as Array<{ text: string }>)[0]?.text ?? '';
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain(`${BASE}/assetdetail.v1?number=<number>`);
    const miss = await call('none_test');
    expect((miss['content'] as Array<{ text: string }>)[0]?.text).toBe('Nothing.');
  });
});
