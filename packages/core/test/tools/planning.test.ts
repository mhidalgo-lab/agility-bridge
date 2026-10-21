// SPDX-License-Identifier: Apache-2.0
// P1-10 planning and people tools: team workflows, members from assignments, sprints by timing, emails off by default.
import { describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  createBudget,
  DEFAULT_LIMITS,
  MetadataService,
  type ToolContext,
  type ToolDefinition,
} from '../../src/index.ts';
import { listMembers } from '../../src/tools/planning/members.ts';
import { listSprints } from '../../src/tools/planning/sprints.ts';
import { getTeam, listTeams } from '../../src/tools/planning/teams.ts';
import snapshotJson from '../fixtures/agility/meta-snapshot.json' with { type: 'json' };
import {
  FakeAgility,
  type FakeAgilityOptions,
  makeContext,
  measureCost,
  poison,
  probeTool,
} from '../harness/index.ts';
import { rpc } from '../helpers/mcp.ts';

const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;
const NOW = Date.parse('2026-10-21T12:00:00Z');
const sched = (oid: string, scopes: string[]) => ({
  Schedule: oid,
  'Schedule.Name': `Synthetic ${oid}`,
  'Schedule.ScheduledScopes': scopes,
});
const sprint = (
  id: number,
  name: string,
  begin: string,
  end: string,
  schedule: object,
  teams: string[] = [],
) => ({
  _oid: `Timebox:${id}`,
  Name: name,
  BeginDate: begin,
  EndDate: end,
  AssetState: id === 41 ? 128 : 64,
  'Workitems.Team': teams,
  ...schedule,
});

function world(poisoned = false): NonNullable<FakeAgilityOptions['assets']> {
  const p = (n: number, plain: string) => (poisoned ? poison(n) : plain);
  const s1 = sched('Schedule:1', ['Scope:1001']);
  const work = (id: number, owners: Array<[string, string]>, team: string) => ({
    _oid: `Story:${id}`,
    AssetType: 'Story',
    AssetState: 64,
    Scope: 'Scope:1001',
    Team: team,
    Owners: owners.map(([o]) => o),
    'Owners.Name': owners.map(([, n]) => n),
  });
  return {
    Team: [
      { _oid: 'Team:5', Name: p(1, 'Blue'), AssetState: 64 },
      { _oid: 'Team:6', Name: 'Green', AssetState: 64 },
    ],
    PrimaryWorkitem: [
      work(1, [['Member:20', p(2, 'Ann Example')]], 'Team:5'),
      work(
        2,
        [
          ['Member:20', p(2, 'Ann Example')],
          ['Member:21', 'Bo Example'],
        ],
        'Team:5',
      ),
      work(3, [['Member:22', 'Cy Outside']], 'Team:6'),
      { ...work(4, [['Member:23', 'Dee Hidden']], 'Team:5'), Scope: 'Scope:2000' },
    ],
    StoryStatus: [
      { _oid: 'StoryStatus:1', Name: 'In Progress', Order: 1, RollupState: 64 },
      {
        _oid: 'StoryStatus:9',
        Name: p(3, 'Blue review'),
        Order: 2,
        RollupState: 64,
        Team: { _oid: 'Team:5' },
      },
    ],
    TaskStatus: [{ _oid: 'TaskStatus:1', Name: 'Open', Order: 1 }],
    Timebox: [
      sprint(41, 'Sprint 41', '2026-10-01T00:00:00Z', '2026-10-15T00:00:00Z', s1, ['Team:5']),
      sprint(42, p(4, 'Sprint 42'), '2026-10-15T00:00:00Z', '2026-10-29T00:00:00Z', s1, ['Team:5']),
      sprint(43, 'Sprint 43', '2026-10-29T00:00:00Z', '2026-11-12T00:00:00Z', s1),
      sprint(
        99,
        'Elsewhere',
        '2026-10-15T00:00:00Z',
        '2026-10-29T00:00:00Z',
        sched('Schedule:9', ['Scope:2000']),
      ),
    ],
    Scope: [
      {
        _oid: 'Scope:1001',
        Name: 'Mobile App',
        AssetState: 64,
        ChildrenMeAndDown: ['Scope:1001'],
        Members: ['Member:20', 'Member:21'],
      },
      {
        _oid: 'Scope:2000',
        Name: 'Outside',
        AssetState: 64,
        ChildrenMeAndDown: ['Scope:2000'],
        Members: ['Member:22'],
      },
    ],
    Member: [
      {
        _oid: 'Member:20',
        Name: p(2, 'Ann Example'),
        Username: 'ann',
        Email: 'ann@example.com',
        AssetState: 64,
      },
      { _oid: 'Member:21', Name: 'Bo Example', Username: 'bo', Email: 'bo@example.com', AssetState: 64 },
      { _oid: 'Member:22', Name: 'Cy Outside', Username: 'cy', Email: 'cy@example.com', AssetState: 64 },
    ],
  };
}

function setup(poisoned = false) {
  const fake = new FakeAgility({ meta: SNAPSHOT, assets: world(poisoned) });
  const ctx = (o: Partial<ToolContext> = {}) =>
    makeContext({
      fetch: fake.fetch,
      metadata: new MetadataService(),
      budget: createBudget(100),
      projects: { allowed: ['Scope:1001'], includeChildren: true },
      clock: { now: () => NOW },
      ...o,
    });
  return { fake, ctx };
}

const call = (tool: ToolDefinition, ctx: ToolContext, args: Record<string, unknown> = {}) =>
  rpc(() => buildMcpServer({ tools: [tool], ctx }), 'tools/call', { name: tool.name, arguments: args });
const text = (r: Record<string, unknown>) => (r['content'] as Array<{ text: string }>)[0]?.text ?? '';
const s = (r: Record<string, unknown>) =>
  r['structuredContent'] as Record<string, unknown> & { items: Array<Record<string, unknown>> };

describe('teams', () => {
  it('lists teams by name', async () => {
    const { ctx } = setup();
    expect(s(await call(listTeams, ctx())).items.map((t) => t['name'])).toEqual(['Blue', 'Green']);
    expect(s(await call(listTeams, ctx(), { contains: 'Gre' })).items.map((t) => t['oid'])).toEqual([
      'Team:6',
    ]);
  });

  it('shows a team’s own workflow, current sprint and members derived from assignments inside the workspace', async () => {
    const { ctx } = setup();
    const r = await call(getTeam, ctx(), { team: 'Blue' });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(s(r)).toMatchObject({
      team: { oid: 'Team:5', name: 'Blue' },
      currentSprint: { oid: 'Timebox:42', name: 'Sprint 42' },
      membersSource: 'assignments',
      members: [
        { oid: 'Member:20', name: 'Ann Example', openItems: 2 },
        { oid: 'Member:21', name: 'Bo Example', openItems: 1 },
      ],
      statuses: [{ assetType: 'Story', oid: 'StoryStatus:9', name: 'Blue review' }],
    });
    expect(JSON.stringify(r)).not.toContain('Dee Hidden');
    expect(text(r)).toContain('derived from assignments');
  });

  it('says when a team has no workflow of its own and no current sprint', async () => {
    const { ctx } = setup();
    const r = await call(getTeam, ctx(), { team: 'Green' });
    expect(text(r)).toContain('no workflow of its own');
    expect(text(r)).toContain('no current sprint');
  });
});

describe('list_sprints', () => {
  it('lists the workspace’s sprints newest first with their timing', async () => {
    const { ctx } = setup();
    const r = await call(listSprints, ctx());
    expect(s(r).items.map((i) => [i['name'], i['timing']])).toEqual([
      ['Sprint 43', 'future'],
      ['Sprint 42', 'current'],
      ['Sprint 41', 'past'],
    ]);
    expect(s(r).items[2]).toMatchObject({
      state: 'closed',
      beginDate: '2026-10-01T00:00:00.000Z',
      schedule: { oid: 'Schedule:1' },
    });
  });

  it.each([
    [{ timing: 'current' }, ['Sprint 42']],
    [{ timing: 'past' }, ['Sprint 41']],
    [{ timing: 'future' }, ['Sprint 43']],
    [{ team: 'Blue' }, ['Sprint 42', 'Sprint 41']],
    [{ project: 'Mobile App', timing: 'current' }, ['Sprint 42']],
  ])('filters %o', async (args, names) => {
    const { ctx } = setup();
    expect(s(await call(listSprints, ctx(), args)).items.map((i) => i['name'])).toEqual(names);
  });
});

describe('list_members', () => {
  it('lists members of the workspace’s projects, without emails by default', async () => {
    const { ctx } = setup();
    const r = await call(listMembers, ctx());
    expect(s(r).items.map((m) => m['oid'])).toEqual(['Member:20', 'Member:21']);
    expect(JSON.stringify(r)).not.toContain('@example.com');
  });

  it('includes emails only with the workspace switch', async () => {
    const { ctx } = setup();
    const r = await call(listMembers, ctx({ limits: { ...DEFAULT_LIMITS, memberEmails: true } }), {
      contains: 'Bo',
    });
    expect(s(r).items).toEqual([expect.objectContaining({ oid: 'Member:21', email: 'bo@example.com' })]);
  });

  it('lists every member when the workspace has no project restriction', async () => {
    const { ctx } = setup();
    expect(
      s(await call(listMembers, ctx({ projects: { allowed: [], includeChildren: true } }))).items,
    ).toHaveLength(3);
  });
});

describe('untrusted text and costs', () => {
  const cases: Array<[ToolDefinition, Record<string, unknown>]> = [
    [listTeams, {}],
    [getTeam, { team: 'Team:5' }],
    [listSprints, { team: 'Team:5' }],
    [listMembers, {}],
  ];
  it.each(cases)('%s keeps Agility text inside the envelope', async (tool, args) => {
    const { ctx } = setup(true);
    const { leaks, result } = await probeTool(tool, ctx(), args);
    expect(result['isError'], text(result)).toBeUndefined();
    expect(leaks).toEqual([]);
  });
  it.each(cases)('%s stays within its declared cost on a cold cache', async (tool, args) => {
    const { ctx, fake } = setup();
    const m = await measureCost(tool, fake, (o) => ctx(o), args);
    expect(m.withinCost, `${m.requests} > ${m.declared}`).toBe(true);
  });
});
