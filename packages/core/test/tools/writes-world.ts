// SPDX-License-Identifier: Apache-2.0
// The write tools' test world (P7-04): the shared synthetic world plus a fake `rest-1.v1/Data` write endpoint that
// records every POST exactly as sent and applies the documented effect to the in-memory rows (set / add / remove on
// attributes and relations, creates of Expression and Actual), so the re-read, the no-op and the conflict paths see
// real state. Nothing here is a real Agility: the request shapes are the documented ones and stay *unverified* (P7-07).
import { createBudget, parseXml, type ToolContext, type ToolDefinition } from '../../src/index.ts';
import { WRITE_TOOLS } from '../../src/tools/writes/index.ts';
import type { FakeCall, Row } from '../harness/index.ts';
import { answeringChannel, makeRuntime, type RecordingAudit, writeContext } from '../helpers/writes.ts';
import { rig, world } from './reports-world.ts';

export const WRITE_NAMES: readonly string[] = WRITE_TOOLS.map((t) => t.name);
export const tool = (name: string): ToolDefinition => {
  const t = WRITE_TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no write tool ${name}`);
  return t;
};

export interface Post {
  readonly path: string;
  readonly xml: string;
  readonly contentType: string | null;
}

type Mutable = Record<string, unknown>;

export interface WriteRig {
  readonly posts: Post[];
  readonly assets: Record<string, Mutable[]>;
  readonly calls: FakeCall[];
  readonly audit: RecordingAudit;
  readonly channel: ReturnType<typeof answeringChannel>;
  readonly ctx: ToolContext;
  /** Rebuilds the context, for example with a deny list or without a layer. */
  context(over?: Partial<ToolContext>): ToolContext;
  /** Runs a tool by name with parsed arguments. */
  run(
    name: string,
    args: Record<string, unknown>,
    ctx?: ToolContext,
  ): Promise<{ text: string; structured?: unknown }>;
  /** Requests that are not reads: every POST that is not `query.v1`. */
  writes(): Post[];
}

export function writeRig(
  options: {
    readonly approve?: boolean;
    readonly poisoned?: boolean;
    /** Runs when the person is asked (simulates someone else changing the item meanwhile). */
    readonly duringApproval?: (assets: Record<string, Mutable[]>) => void;
  } = {},
): WriteRig {
  const base = world({ poisoned: options.poisoned === true });
  const assets = base as unknown as Record<string, Mutable[]>;
  assets['Member'] = [
    ...(assets['Member'] ?? []),
    { _oid: 'Member:21', Name: 'Bob Example', Username: 'bob', IsSelf: false, AssetState: 64 },
  ];
  assets['StoryStatus'] = [
    ...(assets['StoryStatus'] ?? []),
    { _oid: 'StoryStatus:4', Name: 'In review', Order: 4, RollupState: 64, Team: 'Team:5' },
    { _oid: 'StoryStatus:5', Name: 'Green review', Order: 5, RollupState: 64, Team: 'Team:6' },
    { _oid: 'StoryStatus:6', Name: 'Retired', Order: 6, RollupState: 64, Inactive: true },
  ];
  assets['Actual'] = [];
  assets['Expression'] = [];
  const posts: Post[] = [];
  let counter = 9_000;
  const find = (oid: string): Mutable | undefined => {
    const [type = ''] = oid.split(':');
    return (assets[type] ?? []).find((r) => r['_oid'] === oid);
  };
  const memberName = (oid: string): string => String(find(oid)?.['Name'] ?? oid);
  const apply = (type: string, id: string | undefined, xml: string): string => {
    const root = parseXml(xml);
    const op = (name: string) => root.children.filter((c) => c.attributes['name'] === name);
    if (id === undefined) {
      const oid = `${type}:${++counter}`;
      if (type === 'Expression') {
        const item = find(op('Mentions')[0]?.children[0]?.attributes['idref'] ?? '');
        assets['Expression']?.push({
          _oid: oid,
          Content: op('Content')[0]?.text ?? '',
          Mentions: [item?.['_oid']],
          'Mentions:Workitem.Scope': [item?.['Scope']],
          Author: 'Member:20',
          'Author.Name': memberName('Member:20'),
          AuthoredAt: '2026-10-21T12:00:00Z',
          AssetState: 64,
        });
      } else if (type === 'Actual') {
        const itemOid = op('Workitem')[0]?.children[0]?.attributes['idref'] ?? '';
        const item = find(itemOid);
        const value = Number(op('Value')[0]?.text);
        assets['Actual']?.push({
          _oid: oid,
          Value: value,
          Date: op('Date')[0]?.text,
          Member: op('Member')[0]?.children[0]?.attributes['idref'],
          Workitem: itemOid,
          IsDeleted: false,
          Scope: item?.['Scope'],
          AssetState: 64,
        });
        if (item !== undefined) {
          item['Actuals.Value.@Sum'] =
            Math.round((Number(item['Actuals.Value.@Sum'] ?? 0) + value) * 100) / 100;
        }
      }
      return `${oid}:1`;
    }
    const row = find(`${type}:${id}`);
    if (row === undefined) throw new Error(`the fake write endpoint has no ${type}:${id}`);
    for (const rel of root.children.filter((c) => c.name === 'Relation')) {
      const name = rel.attributes['name'] as string;
      const act = rel.attributes['act'];
      const oids = rel.children.map((c) => c.attributes['idref'] as string);
      if (name === 'Status' && act === 'set') {
        const status = find(oids[0] as string);
        row['Status'] = status?.['_oid'];
        row['Status.Name'] = status?.['Name'];
      } else if (name === 'Timebox' && act === 'set') {
        row['Timebox'] = oids[0];
        row['Timebox.Name'] = find(oids[0] as string)?.['Name'];
      } else if (name === 'Owners') {
        const now = new Set<string>(((row['Owners'] as string[] | undefined) ?? []).map(String));
        for (const o of oids) act === 'add' ? now.add(o) : now.delete(o);
        row['Owners'] = [...now];
        row['Owners.Name'] = [...now].map(memberName);
      } else throw new Error(`the fake write endpoint does not model ${act} on ${name}`);
    }
    row['ChangeDateUTC'] = `2026-10-21T12:00:0${posts.length}.0000000Z`;
    return `${type}:${id}:${++counter}`;
  };

  const channel = answeringChannel(options.approve !== false);
  const ask = channel.ask.bind(channel);
  (channel as { ask: typeof channel.ask }).ask = async (prompt) => {
    options.duringApproval?.(assets);
    return ask(prompt);
  };
  const runtime = makeRuntime({ channel, tools: [...WRITE_NAMES] });
  const r = rig({
    fake: { assets: base, filters: 'evaluate' },
    override: (req, call) => {
      if (req.method === 'POST' && call.path.startsWith('rest-1.v1/Data/')) {
        const [, , type = '', id] = call.path.split('/');
        const xml = String(call.body);
        posts.push({ path: call.path, xml, contentType: req.headers.get('content-type') });
        const moment = apply(type, id, xml);
        return new Response(`<Asset href="/SyntheticInstance/${call.path}" id="${moment}"/>`, {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        });
      }
      return undefined;
    },
  });
  const base_ctx = r.ctx();
  const context = (over: Partial<ToolContext> = {}): ToolContext =>
    writeContext(runtime, {
      fetch: base_ctx.fetch,
      ...(base_ctx.metadata === undefined ? {} : { metadata: base_ctx.metadata }),
      projects: base_ctx.projects,
      clock: base_ctx.clock,
      budget: createBudget(200),
      grantedTools: [...WRITE_NAMES],
      ...over,
    });
  return {
    posts,
    assets,
    calls: r.fake.calls as FakeCall[],
    audit: runtime.audit,
    channel,
    ctx: context(),
    context,
    run: (name, args, ctx = context()) => {
      const t = tool(name);
      return t.handler(t.inputSchema.parse(args), ctx);
    },
    writes: () => posts,
  };
}

export type { Row };

/** The most expensive call the shared world can make on a cold cache, per write tool (L-114): applied once, with confirm. */
export const WRITE_WORST_CASES: Readonly<
  Record<string, { readonly args: Record<string, unknown>; readonly why: string }>
> = {
  add_comment: {
    args: { asset: 'B-01002', text: 'Looks good' },
    why: 'number lookup, item read, member, latest comments, then the re-read (3) and the write',
  },
  update_status: {
    args: { asset: 'B-01002', new_status: 'In review' },
    why: 'number lookup, item read, the status list on a cold cache, the re-read and the write',
  },
  log_effort: {
    args: { asset: 'B-01002', hours: 2.5, date: '2026-10-20' },
    why: 'number lookup, item with its total, member, existing entries, the re-read and the write',
  },
  assign_owners: {
    args: { asset: 'B-01002', add: ['bob', 'Bob Example'], remove: ['me'] },
    why: 'every member resolved by a different path, then the re-read and the write',
  },
  move_to_sprint: {
    args: { asset: 'B-01002', sprint: 'next' },
    why: 'a relative sprint (two reads), its state, the re-read and the write',
  },
};
