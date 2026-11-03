// SPDX-License-Identifier: Apache-2.0
// A mock Agility for latency measurements (P9-03): the fake of the test harness over the shared world of the cost test,
// padded to a realistic size (work items of about 450 bytes, P0-06), and answering after a delay that models a real
// instance. Synthetic data only. The same `createMock` runs behind a Node HTTP server (this file, `node
// scripts/perf/mock-agility.ts [port]`) and in a Worker (`spikes/perf-mock`).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeAgility, type Row } from '../../packages/core/test/harness/index.ts';
import { costFakeOptions } from '../../packages/core/test/tools/cost-world.ts';

/**
 * The latency model, in milliseconds per upstream request. A model, not a measurement of a tenant: P0-06 (live Agility
 * 26.0.3.2) measured 0.2-0.3 s per `query.v1` call and about 1.1 s when sorting by `ChangeDate` (L-163); a `meta.v1`
 * type is about 90 KB; history is a heavier read. Replace the numbers with a tenant's own to rerun.
 */
export interface LatencyModel {
  readonly query: number;
  readonly sortedByChangeDate: number;
  readonly meta: number;
  readonly history: number;
  readonly other: number;
}
export const DEFAULT_LATENCY: LatencyModel = {
  query: 250,
  sortedByChangeDate: 1100,
  meta: 150,
  history: 400,
  other: 150,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `n` more stories in the cost world's sprint and project, shaped like the P0-06 rows. */
function padding(n: number): Row[] {
  const ann = { Owners: ['Member:20'], 'Owners.Name': ['Ann Example'] };
  return Array.from({ length: n }, (_, i) => ({
    _oid: `Story:${7000 + i}`,
    AssetType: 'Story',
    Number: `B-${String(7000 + i).padStart(5, '0')}`,
    Name: `Synthetic story ${i}: a realistic work item title of average length`,
    AssetState: i % 3 === 0 ? 128 : 64,
    Scope: 'Scope:1001',
    'Scope.Name': 'Mobile App',
    Timebox: 'Timebox:42',
    'Timebox.Name': 'Sprint 42',
    Status: `StoryStatus:${(i % 3) + 1}`,
    'Status.Name': ['Not started', 'In progress', 'Done'][i % 3],
    Estimate: [1, 2, 3, 5, 8][i % 5],
    ChangeDateUTC: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.0000000Z`,
    Description: '<p>As a user I want a synthetic capability so that I can see a synthetic result.</p>',
    ...ann,
  }));
}

export interface Mock {
  /** Answers one request below `/SyntheticInstance/`, after the modelled delay. */
  handle(req: Request): Promise<Response>;
  /** Requests answered since the last reset. */
  readonly count: () => number;
  readonly reset: () => void;
}

export function createMock(latency: LatencyModel = DEFAULT_LATENCY, extraStories = 150): Mock {
  const base = costFakeOptions();
  const extra = padding(extraStories);
  const assets = { ...base.assets } as Record<string, readonly Row[]>;
  for (const type of ['Story', 'Workitem', 'PrimaryWorkitem'])
    if (assets[type] !== undefined) assets[type] = [...(assets[type] as readonly Row[]), ...extra];
  let served = 0;
  const fake = new FakeAgility({
    ...base,
    assets,
    override: async (req, call) => {
      served++;
      const body = JSON.stringify(call.body ?? '');
      const ms = call.path.startsWith('meta.v1')
        ? latency.meta
        : call.path.startsWith('rest-1.v1/Hist')
          ? latency.history
          : call.path.startsWith('query')
            ? /"-?ChangeDate/.test(body)
              ? latency.sortedByChangeDate
              : latency.query
            : latency.other;
      await sleep(ms);
      return base.override?.(req, call);
    },
  });
  return {
    handle: async (req) => {
      if (fake.calls.length > 500) fake.calls.length = 0;
      try {
        return await fake.fetch(req);
      } catch (error) {
        return new Response(JSON.stringify({ error: String((error as Error).message) }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
    },
    count: () => served,
    reset: () => {
      served = 0;
    },
  };
}

/** The fake derives paths from this base; a server of any origin maps onto it. */
export const MOCK_ORIGIN = 'https://agility.example.com';

export interface RunningMock {
  /** The instance address to give the bridge, e.g. `http://127.0.0.1:41234/SyntheticInstance`. */
  readonly url: string;
  readonly mock: Mock;
  close(): Promise<void>;
}

/** The mock behind a Node HTTP server on 127.0.0.1 (port 0 picks a free one). */
export function startMock(port = 0, latency: LatencyModel = DEFAULT_LATENCY): Promise<RunningMock> {
  const mock = createMock(latency);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const post = req.method === 'POST';
    const answer = await mock.handle(
      new Request(`${MOCK_ORIGIN}${req.url}`, {
        method: req.method ?? 'GET',
        ...(post ? { body: Buffer.concat(chunks), headers: { 'content-type': 'application/json' } } : {}),
      }),
    );
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/SyntheticInstance`,
        mock,
        close: () => new Promise<void>((done) => server.close(() => done())),
      }),
    ),
  );
}

if (import.meta.main) {
  const running = await startMock(Number(process.argv[2] ?? 0));
  console.error(`Mock Agility at ${running.url}`);
}
