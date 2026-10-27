// SPDX-License-Identifier: Apache-2.0
// The synthetic world and rig of the P6-07 report tests: one running sprint with a closed, an open, a stale and an
// unowned item, defects (two near-duplicates), an epic tree, and a rig that registers a report with the siblings the
// caller is granted (the host registers exactly the granted tools, so `grantedTools` follows from the list).
import {
  buildMcpServer,
  createBudget,
  MetadataService,
  type ToolContext,
  type ToolDefinition,
} from '../../src/index.ts';
import { CORE_TOOLS } from '../../src/tools/index.ts';
import snapshotJson from '../fixtures/agility/meta-snapshot.json' with { type: 'json' };
import {
  FakeAgility,
  type FakeAgilityOptions,
  type FakeCall,
  makeContext,
  poison,
  type Row,
} from '../harness/index.ts';
import { rpc } from '../helpers/mcp.ts';

export const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;
export const NOW: number = Date.parse('2026-10-21T12:00:00Z');
const inScope = { Scope: 'Scope:1001', 'Scope.Name': 'Mobile App' };
const sprint42 = { Timebox: 'Timebox:42', 'Timebox.Name': 'Sprint 42' };
const ann = { Owners: ['Member:20'], 'Owners.Name': ['Ann Example'] };

export interface WorldOptions {
  readonly poisoned?: boolean;
  /** No open work at all: every item of the epic and the sprint is done. */
  readonly allDone?: boolean;
}

export function world(options: WorldOptions = {}): NonNullable<FakeAgilityOptions['assets']> {
  const p = (n: number, plain: string) => (options.poisoned === true ? poison(n) : plain);
  const done = options.allDone === true;
  const story = (id: number, status: 1 | 2 | 3, estimate: number | undefined, extra: Row = {}): Row => ({
    _oid: `Story:${id}`,
    AssetType: 'Story',
    Number: `B-0${id}`,
    Name: p(id, `Story number ${id} sign in`),
    AssetState: status === 3 || done ? 128 : 64,
    ...inScope,
    ...sprint42,
    Status: `StoryStatus:${done ? 3 : status}`,
    'Status.Name': ['', 'Not started', 'In progress', 'Done'][done ? 3 : status],
    Estimate: estimate ?? null,
    ChangeDateUTC: '2026-10-20T10:00:00.0000000Z',
    Description: `<p>${p(id + 100, 'As a user I want to sign in so that I can see my account.')}</p>`,
    ...extra,
  });
  const stories = [
    story(1001, 3, 5, {
      ...ann,
      Team: 'Team:5',
      'Team.Name': 'Blue',
      Super: 'Epic:2',
      'Super.Name': 'Checkout',
    }),
    story(1002, 2, 3, {
      ...ann,
      Team: 'Team:5',
      'Team.Name': 'Blue',
      Super: 'Epic:2',
      'Super.Name': 'Checkout',
    }),
    story(1004, 2, 8, {
      Super: 'Epic:2',
      'Super.Name': 'Checkout',
      ChangeDateUTC: '2026-10-10T10:00:00.0000000Z',
    }),
    { ...story(2001, 2, 1), Scope: 'Scope:2000', 'Scope.Name': 'Outside', Name: 'Row from another project' },
  ];
  const defect = (id: number, name: string, extra: Row = {}): Row => ({
    _oid: `Defect:${id}`,
    AssetType: 'Defect',
    Number: `D-0${id}`,
    Name: name,
    AssetState: 64,
    ...inScope,
    Status: 'StoryStatus:1',
    'Status.Name': 'Not started',
    ChangeDateUTC: '2026-10-19T10:00:00.0000000Z',
    ...extra,
  });
  const defects = [
    defect(1101, p(1101, 'Crash on save'), { ...sprint42 }),
    defect(1102, p(1102, 'Crash on save when the network drops'), {
      ChangeDateUTC: '2026-09-01T10:00:00.0000000Z',
    }),
    defect(1103, 'Crash on save when the network drops again', { ...ann }),
    defect(1104, 'Closed defect that is long gone away', { AssetState: 128 }),
    {
      ...defect(2101, 'Defect of another project', {}),
      Scope: 'Scope:2000',
      'Scope.Name': 'Outside',
    },
  ];
  const tasks = [
    {
      _oid: 'Task:1201',
      AssetType: 'Task',
      Number: 'TK-01201',
      Name: 'Wire the form',
      AssetState: 64,
      ...inScope,
      ...sprint42,
      ...ann,
      Parent: 'Story:1002',
      'Status.Name': 'In progress',
      ChangeDateUTC: '2026-10-21T08:00:00.0000000Z',
    },
  ];
  const epic = (id: number, name: string, extra: Row = {}): Row => ({
    _oid: `Epic:${id}`,
    AssetType: 'Epic',
    Number: `E-0000${id}`,
    Name: name,
    AssetState: 64,
    ...inScope,
    'Category.Name': 'Feature',
    Category: 'EpicCategory:1',
    Status: 'EpicStatus:1',
    'Status.Name': 'In Progress',
    ChangeDateUTC: '2026-10-20T10:00:00.0000000Z',
    ...extra,
  });
  const epics = [
    epic(1, p(9001, 'Release 5')),
    epic(2, 'Checkout', { Super: 'Epic:1', 'Super.Number': 'E-00001', 'Super.Name': 'Release 5' }),
    epic(3, 'Empty epic'),
  ];
  const workItems = [...stories, ...defects, ...tasks];
  return {
    Story: stories,
    Defect: defects,
    Task: tasks,
    Test: [],
    PrimaryWorkitem: [...stories, ...defects],
    Workitem: [...workItems, ...epics],
    Epic: epics,
    Scope: [
      { _oid: 'Scope:1001', Name: 'Mobile App', AssetState: 64, ChildrenMeAndDown: ['Scope:1001'] },
      { _oid: 'Scope:2000', Name: 'Outside', AssetState: 64, ChildrenMeAndDown: ['Scope:2000'] },
    ],
    Member: [{ _oid: 'Member:20', Name: p(7, 'Ann Example'), Username: 'ann', IsSelf: true, AssetState: 64 }],
    Team: [{ _oid: 'Team:5', Name: 'Blue', AssetState: 64 }],
    Timebox: [
      {
        _oid: 'Timebox:42',
        Name: p(8, 'Sprint 42'),
        BeginDate: '2026-10-15T00:00:00Z',
        EndDate: '2026-10-29T00:00:00Z',
        AssetState: 64,
        Schedule: 'Schedule:1',
        'Schedule.Name': 'Schedule',
        'Schedule.ScheduledScopes': ['Scope:1001'],
      },
      {
        _oid: 'Timebox:45',
        Name: 'Empty sprint',
        BeginDate: '2026-11-01T00:00:00Z',
        EndDate: '2026-11-15T00:00:00Z',
        AssetState: 64,
        Schedule: 'Schedule:1',
        'Schedule.Name': 'Schedule',
        'Schedule.ScheduledScopes': ['Scope:1001'],
      },
    ],
    StoryStatus: [
      { _oid: 'StoryStatus:1', Name: 'Not started', Order: 1, RollupState: 0 },
      { _oid: 'StoryStatus:2', Name: 'In progress', Order: 2, RollupState: 64 },
      { _oid: 'StoryStatus:3', Name: 'Done', Order: 3, RollupState: 128 },
    ],
    EpicStatus: [{ _oid: 'EpicStatus:1', Name: 'In Progress', Order: 1 }],
    WorkitemPriority: [{ _oid: 'WorkitemPriority:1', Name: 'High', Order: 1 }],
  };
}

/** The sprint as it was at its begin date: the third story joined later, one was not yet done. */
export function history(options: WorldOptions = {}): FakeAgilityOptions['history'] {
  const w = world(options);
  const rows = [...(w['PrimaryWorkitem'] ?? [])];
  const at = (oids: string[]) => rows.filter((r) => oids.includes(String(r['_oid'])));
  return {
    PrimaryWorkitem: [
      { at: '2026-10-15T00:00:00Z', rows: at(['Story:1001', 'Story:1002', 'Defect:1101']) },
      { at: '2026-10-16T00:00:00Z', rows },
    ],
  };
}

export interface Rig {
  readonly fake: FakeAgility;
  /** Agility request bodies seen, as text. */
  readonly bodies: string[];
  ctx(over?: Partial<ToolContext>): ToolContext;
  /** Calls `report` with exactly `granted` registered (the report itself included when listed). */
  call(
    report: string,
    args: Record<string, unknown>,
    over?: { readonly granted?: readonly string[]; readonly ctx?: Partial<ToolContext> },
  ): Promise<Record<string, unknown>>;
}

export const toolByName = (name: string): ToolDefinition => {
  const t = CORE_TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};

/** What a report needs, by report name (the siblings its sections read through). */
export const SIBLINGS: Readonly<Record<string, readonly string[]>> = {
  sprint_health: ['get_sprint', 'search_work_items'],
  standup_summary: ['search_work_items'],
  release_readiness: ['get_portfolio_tree'],
  defect_triage: ['search_work_items'],
  work_item_quality: ['get_work_item'],
};

export function rig(
  options: WorldOptions & {
    readonly fake?: Partial<FakeAgilityOptions>;
    readonly override?: (
      req: Request,
      call: FakeCall,
    ) => Response | undefined | Promise<Response | undefined>;
  } = {},
): Rig {
  const bodies: string[] = [];
  const fake = new FakeAgility({
    meta: SNAPSHOT,
    assets: world(options),
    ...(options.fake?.history === undefined
      ? { history: history(options) as NonNullable<FakeAgilityOptions['history']> }
      : {}),
    override: async (req, call) => {
      bodies.push(JSON.stringify(call.body ?? ''));
      return options.override?.(req, call);
    },
    ...options.fake,
  });
  const ctx = (o: Partial<ToolContext> = {}): ToolContext =>
    makeContext({
      fetch: fake.fetch,
      metadata: new MetadataService(),
      budget: createBudget(200),
      projects: { allowed: ['Scope:1001'], includeChildren: true },
      clock: { now: () => NOW },
      ...o,
    });
  return {
    fake,
    bodies,
    ctx,
    call: (report, args, over = {}) => {
      const names = over.granted ?? [report, ...(SIBLINGS[report] ?? [])];
      const tools = names.map(toolByName);
      const context = ctx(over.ctx);
      return rpc(() => buildMcpServer({ tools, ctx: context }), 'tools/call', {
        name: report,
        arguments: args,
      });
    },
  };
}

export const text = (r: Record<string, unknown>): string =>
  (r['content'] as Array<{ text: string }>)[0]?.text ?? '';
// biome-ignore lint/suspicious/noExplicitAny: structured output is asserted field by field.
export const s = (r: Record<string, unknown>): any => r['structuredContent'];
