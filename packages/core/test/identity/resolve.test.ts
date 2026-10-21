// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  AbError,
  createBudget,
  MetadataService,
  matchName,
  parseAssetRef,
  resolveAsset,
  resolveMember,
  resolveProject,
  resolveSprint,
  resolveStatus,
  resolveTeam,
  type ToolContext,
  toToolErrorResult,
} from '../../src/index.ts';
import snapshotJson from '../fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FakeAgility, type FakeAgilityOptions, makeContext } from '../harness/index.ts';

const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;
const NOW = Date.parse('2026-10-21T12:00:00Z');

// A synthetic world: the workspace allows Scope:1001 and its children; Scope:2000 is outside.
const inProject = { Scope: 'Scope:1001', 'Scope.ParentAndUp': [] };
const inChild = { Scope: 'Scope:1002', 'Scope.ParentAndUp': [{ _oid: 'Scope:1001' }] };
const outside = { Scope: 'Scope:2000', 'Scope.ParentAndUp': [] };
const story = (id: number, where: object) => ({
  _oid: `Story:${id}`,
  AssetType: 'Story',
  Number: `B-0000${id}`,
  Name: `Synthetic story ${id}`,
  AssetState: 64,
  ...where,
});
const STORIES = [story(1, inProject), story(2, inChild), story(3, outside)];
const DEFECT = {
  _oid: 'Defect:7',
  AssetType: 'Defect',
  Number: 'D-00007',
  Name: 'Synthetic defect',
  AssetState: 64,
  ...inProject,
};
const schedule = (oid: string, scopes: string[]) => ({
  Schedule: oid,
  'Schedule.ScheduledScopes': scopes,
  'Schedule.ScheduledScopes.ParentAndUp': [],
});
const sprint = (
  id: number,
  name: string,
  begin: string,
  end: string,
  sched: object,
  teams: string[] = [],
) => ({
  _oid: `Timebox:${id}`,
  Name: name,
  BeginDate: begin,
  EndDate: end,
  AssetState: 64,
  'Workitems.Team': teams,
  ...sched,
});
const S1 = schedule('Schedule:1', ['Scope:1001']);
const S2 = {
  ...schedule('Schedule:2', ['Scope:1002']),
  'Schedule.ScheduledScopes.ParentAndUp': ['Scope:1001'],
};
const ASSETS: NonNullable<FakeAgilityOptions['assets']> = {
  Story: STORIES,
  Workitem: [...STORIES, DEFECT],
  Issue: [
    {
      _oid: 'Issue:1',
      AssetType: 'Issue',
      Number: 'I-00001',
      Name: 'Synthetic issue',
      AssetState: 64,
      ...inProject,
    },
  ],
  Scope: [
    {
      _oid: 'Scope:1001',
      Name: 'Mobile App',
      AssetState: 64,
      ParentAndUp: [],
      ChildrenMeAndDown: ['Scope:1001', 'Scope:1002'],
    },
    {
      _oid: 'Scope:1002',
      Name: 'Mobile App - iOS',
      AssetState: 64,
      ParentAndUp: [{ _oid: 'Scope:1001' }],
      ChildrenMeAndDown: ['Scope:1002'],
    },
    { _oid: 'Scope:2000', Name: 'Other project', AssetState: 64, ParentAndUp: [] },
  ],
  Team: [
    { _oid: 'Team:5', Name: 'Blue', AssetState: 64 },
    { _oid: 'Team:6', Name: 'Blue Team', AssetState: 64 },
  ],
  Member: [
    { _oid: 'Member:20', Name: 'Ann Example', Username: 'ann', IsSelf: true, AssetState: 64 },
    { _oid: 'Member:21', Name: 'Ann Other', Username: 'ann2', IsSelf: false, AssetState: 64 },
    { _oid: 'Member:22', Name: 'Smith, Bo', Username: 'bo', IsSelf: false, AssetState: 64 },
  ],
  Timebox: [
    sprint(1, 'Sprint 41', '2026-10-01T00:00:00Z', '2026-10-15T00:00:00Z', S1, ['Team:5']),
    sprint(2, 'Sprint 42', '2026-10-15T00:00:00Z', '2026-10-29T00:00:00Z', S1, ['Team:5']),
    sprint(3, 'Sprint 43', '2026-10-29T00:00:00Z', '2026-11-12T00:00:00Z', S1),
    sprint(9, 'iOS 7', '2026-10-14T00:00:00Z', '2026-10-28T00:00:00Z', S2, ['Team:6']),
    sprint(
      10,
      'Elsewhere',
      '2026-10-14T00:00:00Z',
      '2026-10-28T00:00:00Z',
      schedule('Schedule:3', ['Scope:2000']),
    ),
  ],
  StoryStatus: [
    { _oid: 'StoryStatus:1', Name: 'In Progress', Order: 1, Inactive: false, RollupState: 64 },
    { _oid: 'StoryStatus:2', Name: 'Done', Order: 2, Inactive: false, RollupState: 128 },
  ],
};

function setup(over: Partial<ToolContext> = {}, fake = new FakeAgility({ meta: SNAPSHOT, assets: ASSETS })) {
  const ctx = makeContext({
    fetch: fake.fetch,
    metadata: new MetadataService(),
    budget: createBudget(200),
    projects: { allowed: ['Scope:1001'], includeChildren: true },
    clock: { now: () => NOW },
    ...over,
  });
  return { ctx, fake };
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

describe('parseAssetRef', () => {
  it.each([
    ['B-01234', { kind: 'number', number: 'B-01234', prefix: 'B' }],
    [' s-01054 ', { kind: 'number', number: 'S-01054', prefix: 'S' }],
    ['TK-00012', { kind: 'number', number: 'TK-00012', prefix: 'TK' }],
    ['Story:1234', { kind: 'oid', oid: 'Story:1234', assetType: 'Story', id: 1234 }],
    ['Story:1234:5678', { kind: 'oid', oid: 'Story:1234', assetType: 'Story', id: 1234, moment: 5678 }],
  ])('%s', (text, ref) => expect(parseAssetRef(text)).toEqual(ref));

  it.each(['B 01234', 'Story', "Story:1'", '-1', 'ABCDE-1', 'Story:1:2:3', ''])('refuses %j', (text) =>
    expect(() => parseAssetRef(text)).toThrow(/not an asset number or OID token/),
  );
});

describe('resolveAsset', () => {
  it('resolves a number through the prefix hint, inside the workspace', async () => {
    const { ctx } = setup();
    expect(await resolveAsset(ctx, 'B-00001')).toMatchObject({
      oid: 'Story:1',
      assetType: 'Story',
      number: 'B-00001',
    });
    expect((await resolveAsset(ctx, 'b-00002')).oid).toBe('Story:2');
  });

  it('resolves numbers of types the prefix map does not know across Workitem, and hinted non-workitems directly', async () => {
    const { ctx, fake } = setup();
    expect(await resolveAsset(ctx, 'D-00007')).toMatchObject({ oid: 'Defect:7', assetType: 'Defect' });
    expect(
      fake.calls.some((c) => c.path === 'query.v1' && (c.body as { from?: string }).from === 'Workitem'),
    ).toBe(true);
    expect(await resolveAsset(ctx, 'I-00001')).toMatchObject({ oid: 'Issue:1', assetType: 'Issue' });
  });

  it('resolves OID tokens and drops the moment', async () => {
    const { ctx } = setup();
    expect((await resolveAsset(ctx, 'Story:1:555')).oid).toBe('Story:1');
  });

  it('answers an asset outside the workspace exactly like a missing one', async () => {
    const { ctx } = setup();
    const outsideError = await failure(resolveAsset(ctx, 'B-00003'));
    const missingError = await failure(resolveAsset(ctx, 'B-00009'));
    expect(outsideError.code).toBe('AB_NOT_FOUND');
    expect(outsideError.message.replace('B-00003', 'X')).toBe(missingError.message.replace('B-00009', 'X'));
    expect((await failure(resolveAsset(ctx, 'Story:3'))).code).toBe('AB_NOT_FOUND');
    expect((await failure(resolveAsset(ctx, 'Spaceship:1'))).code).toBe('AB_NOT_FOUND');
    expect(outsideError.message).toMatch(/not found or is not visible/);
  });

  it('drops rows the upstream should not have returned (L-064) and denied types', async () => {
    const hostile = new FakeAgility({
      meta: SNAPSHOT,
      assets: ASSETS,
      override: (_req, call) => {
        const body = call.body as { from?: string } | undefined;
        if (call.path === 'query.v1' && !Array.isArray(call.body) && body?.from === 'Story') {
          return new Response(JSON.stringify([[STORIES[2]]]), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return undefined;
      },
    });
    expect((await failure(resolveAsset(setup({}, hostile).ctx, 'B-00001'))).code).toBe('AB_NOT_FOUND');
    expect(
      (await failure(resolveAsset(setup({ assetTypes: { deny: ['Defect'] } }).ctx, 'D-00007'))).code,
    ).toBe('AB_NOT_FOUND');
  });

  it('refuses before any request when the identifier is malformed', async () => {
    const { ctx, fake } = setup();
    expect((await failure(resolveAsset(ctx, "B-1'|ID!='"))).code).toBe('AB_INPUT_INVALID');
    expect(fake.requests).toBe(0);
  });
});

describe('name resolution (L-036)', () => {
  it('resolves projects inside the workspace only', async () => {
    const { ctx } = setup();
    expect((await resolveProject(ctx, 'Mobile App')).oid).toBe('Scope:1001');
    expect((await resolveProject(ctx, 'mobile app - ios')).oid).toBe('Scope:1002');
    expect((await failure(resolveProject(ctx, 'Other project'))).code).toBe('AB_NOT_FOUND');
    expect((await resolveProject(ctx, 'Scope:1002')).name).toBe('Mobile App - iOS');
  });

  it('prefers an exact name, and never picks a fuzzy match', async () => {
    const { ctx } = setup();
    expect((await resolveTeam(ctx, 'Blue')).oid).toBe('Team:5');
    const fuzzy = await failure(resolveTeam(ctx, 'Bleu'));
    expect(fuzzy.code).toBe('AB_AMBIGUOUS');
    expect((fuzzy.details as { candidates: Array<{ oid: string }> }).candidates[0]?.oid).toBe('Team:5');
    const text = (
      toToolErrorResult(fuzzy, 'r', { renderUntrusted: (t) => `<<${t}>>` }).content[0] as { text: string }
    ).text;
    expect(text).toMatch(/<<Details: .*Blue.*>>/);
  });

  it('resolves members by me, username and names with commas', async () => {
    const { ctx } = setup();
    expect((await resolveMember(ctx, 'me')).oid).toBe('Member:20');
    expect((await resolveMember(ctx, 'ann2')).oid).toBe('Member:21');
    expect((await resolveMember(ctx, 'Smith, Bo')).oid).toBe('Member:22');
    expect((await resolveMember(ctx, 'Ann')).oid).toBe('Member:20');
    expect((await failure(resolveMember(ctx, 'Ann Exampel'))).code).toBe('AB_AMBIGUOUS');
  });

  it('resolves statuses from the instance list', async () => {
    const { ctx } = setup();
    expect((await resolveStatus(ctx, 'Story', 'done')).oid).toBe('StoryStatus:2');
    expect((await failure(resolveStatus(ctx, 'Story', 'Blocked'))).code).toBe('AB_NOT_FOUND');
  });

  it('matchName ranks candidates without auto-picking', () => {
    expect(
      matchName('Sprnt 42', [
        { oid: 'a', name: 'Sprint 42' },
        { oid: 'b', name: 'Retrospective' },
      ]),
    ).toMatchObject({
      kind: 'none',
      candidates: [{ oid: 'a' }],
    });
  });
});

describe('sprints', () => {
  it('finds overlapping current sprints ambiguous, and narrows by project or team', async () => {
    const { ctx } = setup();
    const both = await failure(resolveSprint(ctx, 'current'));
    expect(both.code).toBe('AB_AMBIGUOUS');
    expect(JSON.stringify(both.details)).not.toContain('Elsewhere');
    expect((await resolveSprint(ctx, 'current', { project: 'Scope:1001' })).name).toBe('Sprint 42');
    expect((await resolveSprint(ctx, 'current', { team: 'Team:6' })).name).toBe('iOS 7');
  });

  it('finds previous and next per schedule', async () => {
    const { ctx } = setup();
    expect((await resolveSprint(ctx, 'previous', { project: 'Scope:1001' })).name).toBe('Sprint 41');
    expect((await resolveSprint(ctx, 'next', { project: 'Scope:1001' })).name).toBe('Sprint 43');
  });

  it('says when there is no current sprint', async () => {
    const { ctx } = setup({ clock: { now: () => Date.parse('2027-03-01T00:00:00Z') } });
    expect((await failure(resolveSprint(ctx, 'current'))).message).toMatch(/no current sprint/);
  });

  it('resolves a sprint by name inside the workspace', async () => {
    const { ctx } = setup();
    expect((await resolveSprint(ctx, 'Sprint 43')).oid).toBe('Timebox:3');
    expect((await failure(resolveSprint(ctx, 'Elsewhere'))).code).toBe('AB_NOT_FOUND');
  });
});
