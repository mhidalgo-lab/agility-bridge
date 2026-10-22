// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  AbError,
  createBudget,
  DEFAULT_LIMITS,
  MetadataService,
  type MetadataServiceOptions,
  metadataDrift,
  metadataFor,
  parseAssetType,
  type ToolContext,
} from '../../src/index.ts';
import snapshotJson from '../fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FakeAgility, type FakeAgilityOptions, makeContext } from '../harness/index.ts';

const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;

function setup(
  options: { fake?: FakeAgilityOptions; service?: MetadataServiceOptions; budget?: number } = {},
) {
  const fake = new FakeAgility({ meta: SNAPSHOT, ...options.fake });
  const service = new MetadataService(options.service);
  const ctx = (over: Partial<ToolContext> = {}) =>
    makeContext({
      fetch: fake.fetch,
      metadata: service,
      budget: createBudget(options.budget ?? 100),
      ...over,
    });
  return { fake, service, ctx };
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

describe('parseAssetType', () => {
  it('parses the committed snapshot', () => {
    for (const body of Object.values(SNAPSHOT)) {
      const t = parseAssetType(body);
      expect(t.attributes.size).toBeGreaterThan(0);
    }
    const story = parseAssetType(SNAPSHOT['Story']);
    expect(story).toMatchObject({ name: 'Story', base: 'PrimaryWorkitem', abstract: false });
    expect(story.attributes.get('Owners')).toMatchObject({
      kind: 'Relation',
      multi: true,
      relatedType: 'Member',
      custom: false,
    });
    expect(story.attributes.get('Custom_SyntheticNote')).toMatchObject({ kind: 'LongText', custom: true });
    expect(story.attributes.get('Name')).toMatchObject({ required: true, readOnly: false });
    expect([...story.operations]).toContain('QuickClose');
  });

  it('keeps only identifiers: display names and invalid names are dropped (A12)', () => {
    const story = parseAssetType(SNAPSHOT['Story']);
    expect(JSON.stringify([...story.attributes.values()])).not.toMatch(
      /Ignore previous|<script|Synthetic display/i,
    );
    expect(story.attributes.has('Bad name<script>')).toBe(false);
  });

  it('refuses a body that is not an asset type', () => {
    expect(() => parseAssetType({ Name: '../etc' })).toThrow(/metadata that could not be read/);
    expect(() => parseAssetType('x')).toThrow(/metadata that could not be read/);
  });
});

describe('resolvePath', () => {
  it.each([
    ['Story', 'Name', 'Text', false],
    ['Story', 'Status.Name', 'Text', false],
    ['Story', 'Owners.Name', 'Text', true],
    ['Story', 'Scope.Parent.Name', 'Text', false],
    ['Task', 'Parent:Story.Estimate', 'Numeric', false],
    ['Scope', 'Workitems:Defect.FoundBy', 'Text', true],
    ['Story', 'Children.@Count', 'Numeric', false],
    ['Story', 'Actuals.Value.@Sum', 'Numeric', false],
    ['Story', 'Custom_SyntheticRisk.Name', 'Text', false],
  ])('%s.%s → %s', async (type, path, kind, multi) => {
    const { ctx } = setup();
    expect(await metadataFor(ctx()).resolvePath(type, path)).toMatchObject({ path, kind, multi });
  });

  it.each([
    ['Story', 'Nope', /no attribute "Nope"/],
    ['Story', 'Name.Length', /not a relation/],
    ['Story', 'Status:Scope.Name', /not a kind of StoryStatus/],
    ['Task', 'Parent:Epic.Name', /not a kind of PrimaryWorkitem/],
    ['Story', "Children[AssetState!='Dead'].Name", /not a valid segment/],
    ['Story', 'Owners.@Sum', /needs a numeric attribute/],
    ['Story', 'Name.@Count', /aggregations need a multi-value relation/],
    ['Story', '@Drop', /not an allowed aggregation/],
    ['Story', 'Scope.Parent.Parent.Parent.Parent.Name', /at most 5 segments/],
    ['Story', 'A:B:C', /not a valid segment/],
  ])('refuses %s %s', async (type, path, message) => {
    const { ctx } = setup();
    const e = await failure(metadataFor(ctx()).resolvePath(type, path));
    expect(e.code).toBe('AB_INPUT_INVALID');
    expect(e.message).toMatch(message);
  });

  it('refuses an unknown asset type and remembers the answer', async () => {
    const { ctx, fake } = setup();
    expect((await failure(metadataFor(ctx()).assetType('Spaceship'))).message).toMatch(
      /Unknown asset type "Spaceship"/,
    );
    await failure(metadataFor(ctx()).assetType('Spaceship'));
    expect(fake.calls.filter((c) => c.path === 'meta.v1/Spaceship')).toHaveLength(1);
    expect((await failure(metadataFor(ctx()).assetType('../x'))).code).toBe('AB_INPUT_INVALID');
  });
});

describe('cache and budget', () => {
  it('charges the call that loads a type and reuses it in later calls', async () => {
    const { ctx, fake } = setup();
    const first = ctx();
    await metadataFor(first).resolvePath('Story', 'Status.Name');
    expect(first.budget.used).toBe(2);
    const second = ctx();
    await metadataFor(second).resolvePath('Story', 'Status.Name');
    expect(second.budget.used).toBe(0);
    expect(fake.requests).toBe(2);
  });

  it('loads a type once for concurrent calls', async () => {
    const { ctx, fake } = setup();
    await Promise.all([1, 2, 3].map(() => metadataFor(ctx()).assetType('Story')));
    expect(fake.requests).toBe(1);
  });

  it('with shareInflight: false (Workers, L-096) each call loads on its own, then completed values are shared', async () => {
    const { ctx, fake } = setup({ service: { shareInflight: false } });
    await Promise.all([1, 2, 3].map(() => metadataFor(ctx()).assetType('Story')));
    expect(fake.requests).toBe(3);
    await metadataFor(ctx()).assetType('Story');
    expect(fake.requests).toBe(3);
  });

  it('fetches again after the TTL, and a new schema fingerprint drops what was derived', async () => {
    let now = 0;
    let stamp = '1';
    const { ctx, fake } = setup({
      service: { ttlMs: 1_000, clock: { now: () => now } },
      fake: {
        override: async (req, call) => {
          if (!call.path.startsWith('meta.v1/')) return undefined;
          const body = SNAPSHOT[call.path.slice(8)];
          void req;
          return new Response(JSON.stringify(body), {
            headers: { 'content-type': 'application/json', etag: `"26.0.3.2.${stamp}"` },
          });
        },
      },
    });
    await metadataFor(ctx()).assetType('Story');
    await metadataFor(ctx()).assetType('Task');
    now = 500;
    await metadataFor(ctx()).assetType('Story');
    expect(fake.requests).toBe(2);
    now = 1_500;
    stamp = '2';
    const md = metadataFor(ctx());
    await md.assetType('Story');
    expect(md.fingerprint).toBe('"26.0.3.2.2"');
    now = 1_600;
    await metadataFor(ctx()).assetType('Task');
    expect(fake.requests).toBe(4);
  });

  it('runs out of budget with AB_BUDGET_EXHAUSTED, not a partial model', async () => {
    const { ctx } = setup({ budget: 1 });
    expect((await failure(metadataFor(ctx()).resolvePath('Story', 'Status.Name'))).code).toBe(
      'AB_BUDGET_EXHAUSTED',
    );
  });

  it('needs a configured service', () => {
    expect(() => metadataFor(makeContext())).toThrow(/No metadata service/);
  });
});

describe('number prefixes (L-141)', () => {
  const assets = {
    Story: [{ _oid: 'Story:1054', Number: 'S-01054' }],
    Defect: [{ _oid: 'Defect:12', Number: 'D-00012' }],
    Task: [{ _oid: 'Task:7', Number: 'TK-00007' }],
    Theme: [{ _oid: 'Theme:3', Number: 'FG-00003' }],
    Epic: [{ _oid: 'Epic:9', Number: 'not a number' }],
  };

  it('samples one number per type in one request', async () => {
    const { ctx, fake } = setup({ fake: { assets } });
    const c = ctx();
    const prefixes = await metadataFor(c).numberPrefixes();
    expect(Object.fromEntries(prefixes)).toEqual({ Story: 'S', Defect: 'D', Task: 'TK', Theme: 'FG' });
    expect(c.budget.used).toBe(1);
    expect(await metadataFor(ctx()).typesForPrefix('s')).toEqual(['Story']);
    expect(fake.requests).toBe(1);
  });

  it('applies configuration overrides per instance (B- or S- stories)', async () => {
    const { ctx } = setup({
      fake: { assets },
      service: { prefixOverrides: { env: { Story: 'B', Bogus: 'lower' } } },
    });
    const prefixes = await metadataFor(ctx()).numberPrefixes();
    expect(prefixes.get('Story')).toBe('B');
    expect(prefixes.has('Bogus')).toBe(false);
  });

  it('falls back to the types the instance has when Agility refuses an unknown one', async () => {
    const { ctx, fake } = setup({
      fake: {
        assets,
        override: (_req, call) => {
          const queries = call.body as Array<{ from: string }> | undefined;
          if (call.path === 'query.v1' && queries?.some((q) => SNAPSHOT[q.from] === undefined)) {
            return new Response(
              JSON.stringify({
                error: 'Bad request',
                exceptions: [{ type: 'X', message: 'Unknown AssetType' }],
              }),
              {
                status: 400,
                headers: { 'content-type': 'application/json' },
              },
            );
          }
          return undefined;
        },
      },
    });
    const prefixes = await metadataFor(ctx()).numberPrefixes();
    expect(prefixes.get('Story')).toBe('S');
    const queries = fake.calls.filter((c) => c.path === 'query.v1');
    expect(queries).toHaveLength(2);
  });
});

describe('statuses (L-142)', () => {
  it('reads the status list in order with rollup categories, teams and inactive flags', async () => {
    const { ctx } = setup({
      fake: {
        assets: {
          StoryStatus: [
            { _oid: 'StoryStatus:2', Name: 'Done', Order: 3, Inactive: false, RollupState: 128, Team: null },
            {
              _oid: 'StoryStatus:1',
              Name: 'In Progress',
              Order: 2,
              Inactive: false,
              RollupState: 64,
              Team: { _oid: 'Team:5' },
            },
            { _oid: 'StoryStatus:3', Name: 'Old', Order: 1, Inactive: true, RollupState: 0, Team: null },
          ],
        },
      },
    });
    expect(await metadataFor(ctx()).statuses('Story')).toEqual([
      { oid: 'StoryStatus:3', name: 'Old', order: 1, inactive: true, category: 'not_started' },
      {
        oid: 'StoryStatus:1',
        name: 'In Progress',
        order: 2,
        inactive: false,
        category: 'in_progress',
        team: 'Team:5',
      },
      { oid: 'StoryStatus:2', name: 'Done', order: 3, inactive: false, category: 'completed' },
    ]);
  });

  it('has no category where the list type has no rollup (TaskStatus) and no list without Status', async () => {
    const { ctx, fake } = setup({
      fake: { assets: { TaskStatus: [{ _oid: 'TaskStatus:1', Name: 'Open', Order: 1 }] } },
    });
    expect(await metadataFor(ctx()).statuses('Task')).toEqual([
      { oid: 'TaskStatus:1', name: 'Open', order: 1, inactive: false },
    ]);
    const body = fake.calls.find((c) => c.path === 'query.v1')?.body as { select: string[] } | undefined;
    const select = body?.select ?? [];
    expect(select).not.toContain('RollupState');
    expect(await metadataFor(ctx()).statuses('Member')).toEqual([]);
  });
});

describe('field tiers', () => {
  it('computes minimal, default and full tiers from the type', async () => {
    const { ctx } = setup();
    const tiers = await metadataFor(ctx()).fieldTiers('Story');
    expect(tiers.minimal).toEqual(['Number', 'Name', 'AssetType', 'AssetState', 'Scope', 'Scope.Name']);
    expect(tiers.default).toEqual([
      ...tiers.minimal,
      'Status.Name',
      'Owners.Name',
      'Timebox.Name',
      'Team.Name',
      'Estimate',
      'Super.Number',
      'Parent.Number',
      'ChangeDateUTC',
    ]);
    expect(tiers.full).toEqual(
      expect.arrayContaining([
        'Description',
        'CreateDateUTC',
        'DetailEstimate',
        'Custom_SyntheticNote',
        'Custom_SyntheticRisk.Name',
      ]),
    );
    const task = await metadataFor(ctx()).fieldTiers('Task');
    expect(task.default).not.toContain('Estimate');
    expect(task.full).toEqual(expect.arrayContaining(['DetailEstimate', 'ToDo']));
  });

  it('caps the full tier at limits.maxFields and validates overrides', async () => {
    const { ctx } = setup({ service: { tierOverrides: { Defect: { minimal: ['Number', 'Nope'] } } } });
    const capped = await metadataFor(ctx({ limits: { ...DEFAULT_LIMITS, maxFields: 8 } })).fieldTiers(
      'Story',
    );
    expect(capped.full).toHaveLength(8);
    expect((await failure(metadataFor(ctx()).fieldTiers('Defect'))).message).toMatch(/no attribute "Nope"/);
  });
});

describe('scope strategy (ARCHITECTURE §6.3)', () => {
  it.each([
    ['Story', { kind: 'direct', path: 'Scope' }],
    ['Defect', { kind: 'direct', path: 'Scope' }],
    ['Task', { kind: 'direct', path: 'Scope' }],
    ['Epic', { kind: 'direct', path: 'Scope' }],
    ['Issue', { kind: 'direct', path: 'Scope' }],
    ['Actual', { kind: 'direct', path: 'Scope' }],
    ['Attachment', { kind: 'derived', path: 'Asset:Workitem.Scope' }],
    ['Link', { kind: 'derived', path: 'Asset:Workitem.Scope' }],
    ['Expression', { kind: 'derived', path: 'Mentions:Workitem.Scope' }],
    ['Scope', { kind: 'workspace_bounded', via: 'self' }],
    ['Timebox', { kind: 'workspace_bounded', via: 'schedule' }],
    ['Member', { kind: 'global' }],
    ['Team', { kind: 'global' }],
    ['StoryStatus', { kind: 'global' }],
    ['EpicCategory', { kind: 'global' }],
    ['Role', { kind: 'denied' }],
    ['Schedule', { kind: 'denied' }],
    ['PrimaryWorkitem', { kind: 'denied' }],
    ['Spaceship', { kind: 'denied' }],
  ])('%s → %o', async (type, strategy) => {
    const { ctx } = setup();
    expect(await metadataFor(ctx()).scopeStrategy(type)).toEqual(strategy);
  });
});

describe('metadataDrift', () => {
  it('reports product differences only', () => {
    const expected = parseAssetType(SNAPSHOT['Story']);
    expect(metadataDrift(expected, expected)).toEqual([]);
    const changed = structuredClone(SNAPSHOT['Story']) as {
      Attributes: Record<string, Record<string, unknown>>;
      Base: unknown;
    };
    delete changed.Attributes['Story.Estimate'];
    changed.Attributes['Story.Owners'] = { ...changed.Attributes['Story.Owners'], IsMultivalue: false };
    delete changed.Attributes['Story.Custom_SyntheticNote'];
    changed.Base = { nameref: 'Workitem' };
    expect(metadataDrift(expected, parseAssetType(changed))).toEqual([
      'Story: base PrimaryWorkitem → Workitem',
      'Story.Owners: multi-value true → false',
      'Story.Estimate: missing',
    ]);
    expect(metadataDrift(expected, undefined)).toEqual(['Story: asset type missing']);
  });
});
