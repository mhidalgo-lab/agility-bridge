// SPDX-License-Identifier: Apache-2.0
// A local, synthetic Agility for trying clients without a real instance (P1-14): the fake from the test harness behind
// an HTTP server on 127.0.0.1, with a few invented projects, stories, defects, tasks and a member. Nothing real.
// Run: node scripts/fixture-agility.ts [port]   then point AB_AGILITY_URL at the printed URL (any token works).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import snapshot from '../packages/core/test/fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FakeAgility } from '../packages/core/test/harness/index.ts';

const scope = { Scope: 'Scope:1001', 'Scope.Name': 'Synthetic Mobile App' };
const sprint = { Timebox: 'Timebox:42', 'Timebox.Name': 'Synthetic Sprint 42' };
const me = { Owners: ['Member:20'], 'Owners.Name': ['Synthetic Member'] };
const story = (id: number, name: string, status: string) => ({
  _oid: `Story:${id}`,
  AssetType: 'Story',
  Number: `B-0${id}`,
  Name: name,
  AssetState: 64,
  Status: 'StoryStatus:1',
  'Status.Name': status,
  Estimate: 3,
  Description: `<p>Synthetic description of ${name}.</p>`,
  Custom_AcceptanceCriteria: '<ul><li>Synthetic criterion</li></ul>',
  ...scope,
  ...sprint,
  ...me,
});
const stories = [
  story(1001, 'Synthetic sign-in page', 'In Progress'),
  story(1002, 'Synthetic password reset', 'Done'),
];
const defect = {
  _oid: 'Defect:1101',
  AssetType: 'Defect',
  Number: 'D-01101',
  Name: 'Synthetic crash on save',
  AssetState: 64,
  'Status.Name': 'In Progress',
  ...scope,
  ...sprint,
  ...me,
};
const task = {
  _oid: 'Task:1201',
  AssetType: 'Task',
  Number: 'TK-01201',
  Name: 'Synthetic task',
  AssetState: 64,
  Parent: 'Story:1001',
  'Parent.Number': 'B-01001',
  'Status.Name': 'Open',
  ToDo: 2,
  ...scope,
  ...sprint,
  ...me,
};

const fake = new FakeAgility({
  meta: snapshot as unknown as Record<string, unknown>,
  baseUrl: 'http://127.0.0.1/SyntheticInstance',
  assets: {
    Story: stories,
    Defect: [defect],
    Task: [task],
    Test: [],
    Workitem: [...stories, defect, task],
    PrimaryWorkitem: [...stories, defect],
    Scope: [
      {
        _oid: 'Scope:1001',
        Name: 'Synthetic Mobile App',
        AssetState: 64,
        ChildrenMeAndDown: ['Scope:1001'],
        Members: ['Member:20'],
      },
    ],
    Member: [
      { _oid: 'Member:20', Name: 'Synthetic Member', Username: 'synthetic', IsSelf: true, AssetState: 64 },
    ],
    Team: [{ _oid: 'Team:5', Name: 'Synthetic Team', AssetState: 64 }],
    Timebox: [
      {
        _oid: 'Timebox:42',
        Name: 'Synthetic Sprint 42',
        BeginDate: '2026-01-01T00:00:00Z',
        EndDate: '2099-01-01T00:00:00Z',
        AssetState: 64,
        Schedule: 'Schedule:1',
        'Schedule.ScheduledScopes': ['Scope:1001'],
      },
    ],
    StoryStatus: [
      { _oid: 'StoryStatus:1', Name: 'In Progress', Order: 1, RollupState: 64 },
      { _oid: 'StoryStatus:2', Name: 'Done', Order: 2, RollupState: 128 },
    ],
    TaskStatus: [{ _oid: 'TaskStatus:1', Name: 'Open', Order: 1 }],
  },
});

export interface FixtureAgility {
  /** Base URL of the synthetic instance, e.g. http://127.0.0.1:41234/SyntheticInstance. */
  readonly url: string;
  close(): Promise<void>;
}

/** Starts the synthetic Agility on 127.0.0.1 (port 0 = any free port). */
export function startFixtureAgility(port = 0): Promise<FixtureAgility> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      const answer = await fake.fetch(
        new Request(`http://127.0.0.1${req.url}`, {
          method: req.method ?? 'GET',
          ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        }),
      );
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch (error) {
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: String((error as Error).message) }));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: bound } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${bound}/SyntheticInstance`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.main) {
  const fixture = await startFixtureAgility(Number(process.argv[2] ?? 0));
  console.error(`Synthetic Agility at ${fixture.url} (any AB_AGILITY_TOKEN works)`);
}
