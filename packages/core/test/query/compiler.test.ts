// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AbError,
  agilityClient,
  compileQuery,
  createBudget,
  DEFAULT_LIMITS,
  type FilterInput,
  MetadataService,
  type QueryInput,
  type ToolContext,
} from '../../src/index.ts';
import snapshotJson from '../fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FakeAgility, makeContext, propertyParams } from '../harness/index.ts';

const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;
const service = new MetadataService();
const fake = new FakeAgility({
  meta: SNAPSHOT,
  assets: {
    Scope: [
      { _oid: 'Scope:1001', ChildrenMeAndDown: [{ _oid: 'Scope:1001' }, { _oid: 'Scope:1002' }] },
      { _oid: 'Scope:1002', ChildrenMeAndDown: [{ _oid: 'Scope:1002' }] },
    ],
  },
});

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return makeContext({
    fetch: fake.fetch,
    metadata: service,
    budget: createBudget(200),
    projects: { allowed: ['Scope:1001'], includeChildren: true },
    clock: { now: () => Date.parse('2026-10-21T12:00:00Z') },
    ...over,
  });
}

async function failure(p: Promise<unknown>): Promise<AbError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AbError) return e;
    throw e;
  }
  throw new Error('expected a failure');
}

const compile = (input: QueryInput, c = ctx(), allowGlobal = false) =>
  compileQuery(c, input, { allowGlobal });

describe('compileQuery', () => {
  it('reads, filters and sorts a plain date attribute through its UTC sibling (P1-19)', async () => {
    const q = await compile({
      assetType: 'Story',
      fields: ['Number', 'ChangeDate'],
      filters: [{ field: 'ChangeDate', op: 'ge', value: '2026-10-01T16:00:00Z' }],
      sort: [{ field: 'ChangeDate', direction: 'desc' }],
    });
    const body = JSON.stringify(q.body);
    expect(q.keys['ChangeDate']).toBe('ChangeDateUTC');
    expect((q.body['select'] as string[]).includes('ChangeDate')).toBe(false);
    expect(body).toContain('ChangeDateUTC>=');
    expect(q.body['sort']).toContain('-ChangeDateUTC');
    expect(Object.values(q.body['with'] as Record<string, unknown>)).toContain('2026-10-01T16:00:00.000Z');
  });

  it('selects one column when both date variants are asked for', async () => {
    const q = await compile({ assetType: 'Story', fields: ['ChangeDate', 'ChangeDateUTC'] });
    expect((q.body['select'] as string[]).filter((f) => f === 'ChangeDateUTC')).toHaveLength(1);
  });

  it('compiles a typical read with bound values and server-owned predicates', async () => {
    const q = await compile({
      assetType: 'Story',
      fields: ['Number', 'Name', 'Status.Name', 'Owners.Name', 'Children.@Count'],
      filters: [
        { field: 'Status.Name', op: 'in', value: ['In Progress', 'Done'] },
        { field: 'Estimate', op: 'ge', value: 3 },
        { field: 'Name', op: 'contains', value: "O'Brien | (urgent)" },
        { field: 'Timebox', op: 'is_set' },
      ],
      anyOf: [
        [{ field: 'Owners', op: 'eq', value: 'Member:20' }],
        [{ field: 'Team', op: 'eq', value: 'Team:5' }],
      ],
      sort: [{ field: 'Estimate', direction: 'desc' }],
      limit: 10,
    });
    expect(q.body).toMatchInlineSnapshot(`
      {
        "filter": [
          "Scope=$ab_scope",
          "AssetState=$ab_state",
          "Status.Name=$v1",
          "Estimate>=$v2",
          "Name~=$v3",
          "Timebox!=""",
          "((Owners=$v4)|(Team=$v5))",
        ],
        "from": "Story",
        "page": {
          "size": 11,
          "start": 0,
        },
        "select": [
          "Number",
          "Name",
          "Status.Name",
          "Owners.Name",
          "Children[AssetState!='Dead'].@Count",
          "Scope",
        ],
        "sort": [
          "-Estimate",
          "ID",
        ],
        "with": {
          "$ab_scope": [
            "Scope:1001",
            "Scope:1002",
          ],
          "$ab_state": [
            "0",
            "64",
          ],
          "$v1": [
            "In Progress",
            "Done",
          ],
          "$v2": "3",
          "$v3": "O'Brien | (urgent)",
          "$v4": "Member:20",
          "$v5": "Team:5",
        },
      }
    `);
    expect(Object.values(q.masked['with'] as Record<string, unknown>).every((v) => v === '…')).toBe(true);
    expect(JSON.stringify(q.masked)).not.toContain('Brien');
  });

  it('defaults to the type’s default tier, sort by ID and limit + 1', async () => {
    const q = await compile(
      { assetType: 'Defect' },
      ctx({ projects: { allowed: [], includeChildren: true } }),
    );
    expect(q.body['sort']).toEqual(['ID']);
    expect(q.body['page']).toEqual({ start: 0, size: DEFAULT_LIMITS.defaultRows + 1 });
    expect(q.fields).toContain('Status.Name');
    expect(q.body['filter']).toEqual(['AssetState=$ab_state']);
  });

  it('includes closed assets only when asked and never dead ones; types without AssetState use IsDeleted', async () => {
    const closed = await compile({ assetType: 'Story', fields: ['Name'], includeClosed: true });
    expect((closed.body['with'] as Record<string, unknown>)['$ab_state']).toEqual(['0', '64', '128']);
    const effort = await compile({ assetType: 'Actual', fields: ['Value', 'Workitem.Number'] });
    expect(effort.body['filter']).toContain('IsDeleted=$ab_deleted');
    const sums = await compile({ assetType: 'Story', fields: ['Actuals.Value.@Sum'] });
    expect(sums.body['select']).toEqual(["Actuals[IsDeleted='false'].Value.@Sum", 'Scope']);
    expect(sums.recheck).toEqual(['Scope']);
    expect(sums.scopes).toEqual(['Scope:1001', 'Scope:1002']);
  });
});

describe('values reach Agility only through `with` (L-057, L-139, L-162)', () => {
  // The P0-06 `with` cases: one literal each, or refused when Agility would split them.
  const P0_06_VALUES = [
    'zz-no-such-number',
    "zz'",
    "zz'|Number!='",
    'zz"|Number!="',
    "zz')|(Number!='",
    'zz;Number!=""',
    'zz[Owners]',
    '$other',
    'Ünïcödé 名前',
    'x'.repeat(1_000),
    'zz|B-01234',
  ];

  it.each(P0_06_VALUES)('binds %s as one value', async (value) => {
    const q = await compile({
      assetType: 'Story',
      fields: ['Number'],
      filters: [{ field: 'Number', op: 'eq', value }],
    });
    expect(q.body['filter']).toContain('Number=$v1');
    expect((q.body['with'] as Record<string, unknown>)['$v1']).toBe(value);
  });

  it.each([
    ['a comma (Agility would split it into a list)', 'zz,B-01234'],
    ['a newline', 'zz\nNumber!=""'],
    ['a NUL', `zz${String.fromCodePoint(0)}`],
    ['10,001 characters', 'x'.repeat(1_001)],
    ['an empty string', ''],
  ])('refuses a scalar with %s', async (_why, value) => {
    expect(
      (
        await failure(
          compile({
            assetType: 'Story',
            fields: ['Number'],
            filters: [{ field: 'Number', op: 'eq', value }],
          }),
        )
      ).code,
    ).toBe('AB_INPUT_INVALID');
  });

  it('property: filter tokens are exactly the server tokens plus one token over $v1, whatever the value', async () => {
    const OP = { eq: '=', ne: '!=', contains: '~=', in: '=' } as const;
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string({ minLength: 1, maxLength: 60 }),
          fc.string({ unit: 'binary', minLength: 1, maxLength: 60 }),
        ),
        fc.constantFrom<'eq' | 'ne' | 'contains' | 'in'>('eq', 'ne', 'contains', 'in'),
        async (value, op) => {
          let q: Awaited<ReturnType<typeof compileQuery>>;
          try {
            q = await compile({
              assetType: 'Story',
              fields: ['Number', 'Name'],
              filters: [{ field: 'Name', op, value: op === 'in' ? [value, `${value}x`] : value }],
            });
          } catch (e) {
            // Refused values (commas, control characters, too long) are fine; anything else is a bug.
            return (
              e instanceof AbError &&
              e.code === 'AB_INPUT_INVALID' &&
              // biome-ignore lint/suspicious/noControlCharactersInRegex: values with control characters must be refused.
              /[,\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(value)
            );
          }
          const filter = q.body['filter'] as string[];
          const bound = (q.body['with'] as Record<string, unknown>)['$v1'];
          return (
            JSON.stringify(filter) ===
              JSON.stringify(['Scope=$ab_scope', 'AssetState=$ab_state', `Name${OP[op]}$v1`]) &&
            JSON.stringify(q.body['select']) === '["Number","Name","Scope"]' &&
            JSON.stringify(bound) === JSON.stringify(op === 'in' ? [value, `${value}x`] : value)
          );
        },
      ),
      propertyParams(300),
    );
    // Hundreds of async runs: generous when the whole suite shares the CPU (the default 5 s flaked under load).
  }, 30_000);

  it('property: arbitrary field names are refused unless they are valid paths', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 40 }), async (field) => {
        try {
          const q = await compile({ assetType: 'Story', fields: [field] });
          return (q.body['select'] as string[])[0] === field;
        } catch (e) {
          return e instanceof AbError && e.code === 'AB_INPUT_INVALID';
        }
      }),
      propertyParams(200),
    );
  }, 30_000);
});

describe('the scope predicate cannot be widened (L-059)', () => {
  it('keeps the scope entry separate from any caller OR', async () => {
    const q = await compile({
      assetType: 'Story',
      fields: ['Number'],
      anyOf: [
        [{ field: 'Scope', op: 'ne', value: 'Scope:1001' }],
        [{ field: 'Number', op: 'eq', value: "x')|(Scope!='" }],
        [{ field: 'Scope.Name', op: 'contains', value: 'a' }],
      ],
    });
    const filter = q.body['filter'] as string[];
    expect(filter[0]).toBe('Scope=$ab_scope');
    expect((q.body['with'] as Record<string, unknown>)['$ab_scope']).toEqual(['Scope:1001', 'Scope:1002']);
    // The caller's alternatives live in one parenthesised entry; query.v1 ANDs entries (verified live, P1-04).
    expect(filter.at(-1)).toBe('((Scope!=$v1)|(Number=$v2)|(Scope.Name~=$v3))');
    expect(filter.filter((f) => f.includes('$ab_scope'))).toHaveLength(1);
  });

  it('refuses multi-query and raw-token attempts in every input', async () => {
    const attempts: QueryInput[] = [
      { assetType: 'Story","select":["*"]},{"from":"Member', fields: ['Name'] },
      { assetType: 'Story', fields: ["Name']|Scope!=['"] },
      { assetType: 'Story', fields: ["Owners[Scope!='']"] },
      { assetType: 'Story', fields: ['Name'], sort: [{ field: 'Name;Scope' }] },
      { assetType: 'Story', fields: ['Name'], filters: [{ field: 'Scope|ID', op: 'eq', value: 'Scope:1' }] },
      {
        assetType: 'Story',
        fields: ['Name'],
        filters: [{ field: 'Name', op: 'eq|' as FilterInput['op'], value: 'x' }],
      },
      {
        assetType: 'Story',
        fields: ['Name'],
        filters: [{ field: 'Scope', op: 'eq', value: "Scope:1'|ID!='" }],
      },
    ];
    for (const input of attempts) expect((await failure(compile(input))).code).toBe('AB_INPUT_INVALID');
  });

  it('never takes the scope from the input: an empty workspace list adds no predicate, a bad one is a server fault', async () => {
    const all = await compile(
      { assetType: 'Story', fields: ['Name'] },
      ctx({ projects: { allowed: [], includeChildren: true } }),
    );
    expect(all.body['filter']).toEqual(['AssetState=$ab_state']);
    expect(
      (
        await failure(
          compile(
            { assetType: 'Story', fields: ['Name'] },
            ctx({ projects: { allowed: ["Scope:1'"], includeChildren: false } }),
          ),
        )
      ).code,
    ).toBe('AB_INTERNAL');
  });
});

describe('scope strategy classes', () => {
  it.each([
    ['Story', false, 'Scope=$ab_scope', ['Scope:1001', 'Scope:1002']],
    ['Task', true, 'Scope=$ab_scope', ['Scope:1001']],
    ['Attachment', true, 'Asset:Workitem.Scope=$ab_scope', ['Scope:1001']],
    ['Link', false, 'Asset:Workitem.Scope=$ab_scope', ['Scope:1001', 'Scope:1002']],
    ['Scope', false, 'ID=$ab_scope', ['Scope:1001', 'Scope:1002']],
    ['Scope', true, 'ID=$ab_scope', ['Scope:1001']],
    ['Timebox', true, 'Schedule.ScheduledScopes=$ab_scope', ['Scope:1001']],
  ])('%s (direct children only: %s)', async (assetType, onlyDirect, token) => {
    const q = await compile(
      { assetType, fields: ['Name'] },
      ctx({ projects: { allowed: ['Scope:1001'], includeChildren: !onlyDirect } }),
    );
    expect((q.body['filter'] as string[])[0]).toBe(token);
  });

  it('needs an explicit allowance for global types', async () => {
    expect((await failure(compile({ assetType: 'Member', fields: ['Name'] }))).code).toBe(
      'AB_AUTH_FORBIDDEN',
    );
    const q = await compile({ assetType: 'Member', fields: ['Name'] }, ctx(), true);
    expect((q.body['filter'] as string[]).some((f) => f.includes('$ab_scope'))).toBe(false);
  });

  it.each(['Role', 'Schedule', 'PrimaryWorkitem'])('refuses the denied type %s', async (assetType) => {
    expect((await failure(compile({ assetType, fields: ['ID'] }, ctx(), true))).code).toBe(
      'AB_AUTH_FORBIDDEN',
    );
  });

  it('refuses unknown types and types outside the workspace lists', async () => {
    expect((await failure(compile({ assetType: 'Spaceship', fields: ['Name'] }))).code).toBe(
      'AB_INPUT_INVALID',
    );
    expect(
      (
        await failure(
          compile({ assetType: 'Defect', fields: ['Name'] }, ctx({ assetTypes: { deny: ['Defect'] } })),
        )
      ).code,
    ).toBe('AB_AUTH_FORBIDDEN');
    expect(
      (
        await failure(
          compile(
            { assetType: 'Defect', fields: ['Name'] },
            ctx({ assetTypes: { allow: ['Story'], deny: [] } }),
          ),
        )
      ).code,
    ).toBe('AB_AUTH_FORBIDDEN');
  });
});

describe('limits (L-058, L-060)', () => {
  const tight = {
    ...DEFAULT_LIMITS,
    maxFields: 2,
    maxNestingDepth: 1,
    maxAggregations: 1,
    maxAnyOfGroups: 1,
    maxRows: 5,
    maxAsOfAgeDays: 30,
  };
  it.each<[string, QueryInput, string, string]>([
    [
      'fields',
      { assetType: 'Story', fields: ['Name', 'Number', 'Estimate'], limit: 1 },
      'maxFields',
      'fields',
    ],
    [
      'nesting',
      { assetType: 'Story', fields: ['Scope.Parent.Name'], limit: 1 },
      'maxNestingDepth',
      'relation hops',
    ],
    [
      'nesting in filters',
      {
        assetType: 'Story',
        fields: ['Name'],
        filters: [{ field: 'Scope.Parent.Name', op: 'eq', value: 'x' }],
      },
      'maxNestingDepth',
      'relation hops',
    ],
    [
      'aggregations',
      { assetType: 'Story', fields: ['Children.@Count', 'Owners.@Count'] },
      'maxAggregations',
      'aggregations',
    ],
    [
      'any_of groups',
      {
        assetType: 'Story',
        fields: ['Name'],
        anyOf: [[{ field: 'Name', op: 'eq', value: 'a' }], [{ field: 'Name', op: 'eq', value: 'b' }]],
      },
      'maxAnyOfGroups',
      'groups',
    ],
    ['rows', { assetType: 'Story', fields: ['Name'], limit: 6 }, 'maxRows', 'rows'],
    [
      'as_of age',
      { assetType: 'Story', fields: ['Name'], limit: 1, asOf: '2026-01-01T00:00:00Z' },
      'maxAsOfAgeDays',
      'days',
    ],
  ])('%s → AB_LIMIT_QUERY', async (_n, input, limit, unit) => {
    const e = await failure(compile(input, ctx({ limits: tight })));
    expect(e.code).toBe('AB_LIMIT_QUERY');
    expect(e.details).toMatchObject({ limit, unit });
    expect(e.message).toContain(limit);
  });

  it('bounds as_of and compiles it to asof', async () => {
    const q = await compile({ assetType: 'Story', fields: ['Name'], asOf: '2026-10-01' });
    expect(q.body['asof']).toBe('2026-10-01T00:00:00.000Z');
    expect(
      (await failure(compile({ assetType: 'Story', fields: ['Name'], asOf: '2026-12-01' }))).message,
    ).toMatch(/future/);
    expect(
      (await failure(compile({ assetType: 'Story', fields: ['Name'], asOf: '2026-10-01T10:00:00' }))).code,
    ).toBe('AB_INPUT_INVALID');
  });

  it('refuses sorting by multi-value paths and out-of-range offsets', async () => {
    expect(
      (await failure(compile({ assetType: 'Story', fields: ['Name'], sort: [{ field: 'Owners.Name' }] })))
        .code,
    ).toBe('AB_INPUT_INVALID');
    expect((await failure(compile({ assetType: 'Story', fields: ['Name'], offset: -1 }))).code).toBe(
      'AB_INPUT_INVALID',
    );
  });
});

describe('filter before cap (L-034)', () => {
  it('pages over the filtered rows, so matches beyond the first page of the type are found', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      _oid: `Story:${1000 + i}`,
      Number: `B-0${1000 + i}`,
      AssetState: 64,
      'Status.Name': i >= 55 ? 'Blocked' : 'Open',
    }));
    const local = new FakeAgility({ meta: SNAPSHOT, assets: { Story: rows } });
    const c = ctx({
      fetch: local.fetch,
      metadata: new MetadataService(),
      projects: { allowed: [], includeChildren: true },
    });
    const q = await compileQuery(c, {
      assetType: 'Story',
      fields: ['Number'],
      filters: [{ field: 'Status.Name', op: 'eq', value: 'Blocked' }],
      limit: 3,
    });
    const res = await agilityClient(c).query<Array<Array<{ Number: string }>>>(q.body);
    expect(res.data[0]?.map((r) => r.Number)).toEqual(['B-01055', 'B-01056', 'B-01057', 'B-01058']);
  });
});
