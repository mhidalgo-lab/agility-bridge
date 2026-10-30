// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildMcpServer, defineTool } from '../../src/index.ts';
import { addLinks, assetLink, linkNote } from '../../src/output/links.ts';
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
