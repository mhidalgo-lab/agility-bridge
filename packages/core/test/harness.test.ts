// SPDX-License-Identifier: Apache-2.0
// Tests of the harness itself (P1-12): the fake answers like Agility, the probe catches every way a tool can leak
// upstream text (proved with deliberately broken tools), the cost check catches a tool that lies, and the property
// runner is seeded.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  agilityClient,
  assetState,
  defineTool,
  formatRows,
  shapeList,
  type ToolContext,
  type ToolDefinition,
  untrusted,
} from '../src/index.ts';
import {
  FakeAgility,
  FakeAgilityError,
  FORGED_ROWS,
  findLeaks,
  foreignScopeRow,
  MALFORMED_BODIES,
  makeContext,
  measureCost,
  outsideEnvelopes,
  permissionLimitedRow,
  poisonedRows,
  probeTool,
  propertyParams,
} from './harness/index.ts';

type StoryRow = Record<string, unknown>;

async function fetchStories(ctx: ToolContext, pages = 1): Promise<StoryRow[]> {
  const client = agilityClient(ctx);
  const out: StoryRow[] = [];
  for (let p = 0; p < pages; p++) {
    const res = await client.query<StoryRow[][]>({
      from: 'Story',
      select: [
        'Number',
        'Name',
        'Description',
        'Status.Name',
        'Scope',
        'Scope.Name',
        'AssetState',
        { from: 'Owners', select: ['Name', 'Email'] },
      ],
      sort: ['ID'],
      page: { start: p * 25, size: 25 },
    });
    if (!Array.isArray(res.data) || !Array.isArray(res.data[0])) throw new Error('unexpected shape');
    out.push(...res.data[0]);
  }
  return out;
}

const toItem = (r: StoryRow) => ({
  number: r['Number'],
  assetType: 'Story',
  oid: r['_oid'],
  state: assetState(r['AssetState']),
  project: { oid: r['Scope'], name: r['Scope.Name'] },
  name: r['Name'],
  status: r['Status.Name'],
  description: r['Description'],
  owners: r['Owners'],
});

const base = {
  title: 'Probe stories',
  description: 'List synthetic stories for the harness tests (test only).',
  kind: 'read' as const,
  group: 'core',
  inputSchema: z.object({}),
};

/** Does everything right: all output through the shaper, Agility text in summaries marked untrusted. */
const goodTool = defineTool({
  ...base,
  name: 'probe_good',
  cost: 1,
  handler: async (_input, ctx) => {
    const rows = await fetchStories(ctx);
    const first = rows[0];
    return shapeList(ctx, {
      summary: ['Found ', String(rows.length), ' stories in ', untrusted(first?.['Scope.Name']), '.'],
      notes: [['First status: ', untrusted(first?.['Status.Name'])]],
      source: 'stories',
      rows: rows.map(toItem),
      richText: ['description'],
    });
  },
});

const brokenTools: Array<[string, ToolDefinition]> = [
  [
    'raw text',
    defineTool({
      ...base,
      name: 'probe_raw_text',
      cost: 1,
      handler: async (_i, ctx) => ({
        text: (await fetchStories(ctx)).map((r) => String(r['Name'])).join('\n'),
      }),
    }),
  ],
  [
    'a project name in a plain note',
    defineTool({
      ...base,
      name: 'probe_plain_note',
      cost: 1,
      handler: async (_i, ctx) => {
        const rows = await fetchStories(ctx);
        return shapeList(ctx, {
          summary: 'Stories.',
          notes: [`Project ${String(rows[0]?.['Scope.Name'])}`],
          source: 'stories',
          rows: rows.map(toItem),
        });
      },
    }),
  ],
  [
    'raw rows in structuredContent',
    defineTool({
      ...base,
      name: 'probe_raw_structured',
      cost: 1,
      handler: async (_i, ctx) => {
        const rows = await fetchStories(ctx);
        const out = shapeList(ctx, { summary: 'Stories.', source: 'stories', rows: rows.map(toItem) });
        return { ...out, structured: { items: rows } };
      },
    }),
  ],
];

const fakeWith = (rows: StoryRow[], extra: ConstructorParameters<typeof FakeAgility>[0] = {}) =>
  new FakeAgility({ assets: { Story: rows }, ...extra });
const ctxFor = (fake: FakeAgility) => makeContext({ fetch: fake.fetch });

describe('poisoned-string probe', () => {
  it('finds no leak in a tool that uses the shaper', async () => {
    const { leaks, result } = await probeTool(goodTool, ctxFor(fakeWith(poisonedRows('Story', 6))));
    expect(result['isError']).toBeUndefined();
    expect(leaks.map((l) => l.detail)).toEqual([]);
  });

  it.each(brokenTools)('catches a tool that leaks through %s', async (_how, tool) => {
    const { leaks } = await probeTool(tool, ctxFor(fakeWith(poisonedRows('Story', 6))));
    expect(leaks.length).toBeGreaterThan(0);
  });

  it('finds no leak in error results built from hostile responses', async () => {
    for (const m of MALFORMED_BODIES) {
      const fake = fakeWith([], {
        override: () => new Response(m.body, { headers: { 'content-type': m.contentType } }),
      });
      const { result, leaks } = await probeTool(goodTool, ctxFor(fake));
      expect(result['isError'], m.name).toBe(true);
      expect(leaks, m.name).toEqual([]);
    }
  });

  it('reports a malformed or unclosed envelope', () => {
    expect(
      outsideEnvelopes('<untrusted-data id="abababababababab" source="x">\nCANARY-1').malformed,
    ).not.toEqual([]);
    expect(findLeaks({ content: [{ type: 'text', text: 'CANARY-7 outside' }] })).toHaveLength(1);
  });

  it('keeps nulls out of permission-limited rows and keeps forged ids as data', async () => {
    const rows = [
      permissionLimitedRow('Story', 1001),
      ...FORGED_ROWS.map((r) => ({ ...r, Scope: 'Scope:1', AssetState: 64 })),
    ];
    const { result, leaks } = await probeTool(goodTool, ctxFor(fakeWith(rows)));
    expect(leaks).toEqual([]);
    expect(JSON.stringify(result['structuredContent'])).not.toContain('null');
  });
});

describe('fake Agility', () => {
  const rows = [
    { _oid: 'Story:3', Number: 'B-03', Name: 'c', Scope: 'Scope:1' },
    { _oid: 'Story:1', Number: 'B-01', Name: 'a', Scope: 'Scope:1' },
    { _oid: 'Story:2', Number: 'B-02', Name: 'b', Scope: 'Scope:2' },
    foreignScopeRow('Story', 4),
  ];

  it('filters with bound values, sorts by ID and pages', async () => {
    const fake = fakeWith(rows);
    const res = await agilityClient(ctxFor(fake)).query<StoryRow[][]>({
      from: 'Story',
      select: ['Number'],
      filter: ['Scope=$s'],
      with: { $s: 'Scope:1' },
      sort: ['ID'],
      page: { start: 0, size: 1 },
    });
    expect(res.data).toEqual([[{ _oid: 'Story:1', Number: 'B-01' }]]);
    expect(fake.calls).toEqual([expect.objectContaining({ method: 'POST', path: 'query.v1' })]);
  });

  it('splits a scalar bound value at commas, like Agility (L-162)', async () => {
    const res = await agilityClient(ctxFor(fakeWith(rows))).query<StoryRow[][]>({
      from: 'Story',
      select: ['Number'],
      filter: ['Number=$n'],
      with: { $n: 'zz,B-02' },
    });
    expect(res.data[0]).toHaveLength(1);
  });

  it('can ignore filters, like an upstream that drops the scope restriction', async () => {
    const res = await agilityClient(ctxFor(fakeWith(rows, { filters: 'ignore-filters' }))).query<
      StoryRow[][]
    >({
      from: 'Story',
      filter: ['Scope=$s'],
      with: { $s: 'Scope:1' },
    });
    expect(res.data[0]).toHaveLength(4);
  });

  it('fails loudly on filters and endpoints it does not understand', async () => {
    const fake = fakeWith(rows);
    await expect(
      fake.fetch(
        new Request(`${fake.baseUrl}/query.v1`, {
          method: 'POST',
          body: JSON.stringify({ from: 'Story', filter: ["Name.Contains('x')"] }),
        }),
      ),
    ).rejects.toThrow(FakeAgilityError);
    await expect(
      fake.fetch(new Request(`${fake.baseUrl}/api/asset`, { method: 'POST', body: '{}' })),
    ).rejects.toThrow(FakeAgilityError);
  });
});

describe('worst-case cost', () => {
  it('measures the requests of one call against the declared cost', async () => {
    const fake = fakeWith(poisonedRows('Story', 3));
    expect(await measureCost(goodTool, fake, makeContext)).toMatchObject({
      requests: 1,
      declared: 1,
      withinCost: true,
    });
  });

  it('catches a tool whose cost is too low', async () => {
    const liar = defineTool({
      ...base,
      name: 'probe_liar',
      cost: 1,
      handler: async (_i, ctx) =>
        shapeList(ctx, { summary: 's', source: 's', rows: (await fetchStories(ctx, 3)).map(toItem) }),
    });
    expect((await measureCost(liar, fakeWith([]), makeContext)).withinCost).toBe(false);
  });
});

describe('seeded properties', () => {
  it('formatted rows are exactly the rows shown, for any strings', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            number: fc.string({ maxLength: 12 }),
            name: fc.string({ unit: 'binary', maxLength: 200 }),
          }),
          { maxLength: 30 },
        ),
        fc.integer({ min: 200, max: 6_000 }),
        (rows, maxBlockChars) => {
          const f = formatRows(rows, { format: 'table', maxBlockChars });
          const lines = f.body.split('\n');
          if (rows.length === 0) return f.body === '(no rows)';
          return f.rows.length === 0
            ? f.droppedRows === rows.length
            : lines.length === f.rows.length + 2 && f.body.length <= maxBlockChars;
        },
      ),
      // The property does not depend on the size of the input: 100 runs of up to 30 rows cover it (it took 3 s at 200
      // runs of 60 rows of 400 characters, most of a 5 s budget).
      propertyParams(100),
    );
  });
});
