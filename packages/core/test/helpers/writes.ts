// SPDX-License-Identifier: Apache-2.0
// Fakes for the write framework (P7-01): an in-memory "Agility" with one asset type, a test-only write tool built with
// `defineWriteTool`, a recording audit sink and a runtime/context builder. Nothing here talks to a network.
import { z } from 'zod';
import {
  AbError,
  type ApprovalChannelPort,
  ApprovalLedger,
  type ChannelReply,
  defineWriteTool,
  ErrorCode,
  memoryLedgerStore,
  systemClock,
  type ToolContext,
  type ToolDefinition,
  type WriteActor,
  type WriteAuditRecord,
  type WriteAuditSink,
  type WriteRuntime,
} from '../../src/index.ts';
import { makeContext } from './context.ts';

export interface FakeItem {
  oid: string;
  number: string;
  title: string;
  status: string;
  /** Bumped by every change, like `ChangeDateUTC`. */
  version: number;
}

/** The fake upstream: items by OID, a count of every read and every send. */
export class FakeItems {
  readonly items: Map<string, FakeItem> = new Map<string, FakeItem>();
  reads = 0;
  sends: Array<{ oid: string; status: string }> = [];
  /** Run once, just before a re-read answers (simulates someone else changing the item). */
  beforeReread: (() => void) | undefined;
  failSendWith: AbError | Error | undefined;

  constructor() {
    this.items.set('Story:1', {
      oid: 'Story:1',
      number: 'B-00001',
      title: 'Sign-in page',
      status: 'In Progress',
      version: 1,
    });
    this.items.set('Story:2', {
      oid: 'Story:2',
      number: 'B-00002',
      title: 'Search',
      status: 'Done',
      version: 1,
    });
  }

  find(ref: string): FakeItem | undefined {
    this.reads++;
    return [...this.items.values()].find((i) => i.number === ref || i.oid === ref);
  }
}

export const TEST_TOOL = 'update_test_item';

/** `update_test_item { item, status }`: the whole pipeline on fakes. Only ever used in tests. */
export function makeTestWriteTool(fake: FakeItems): ToolDefinition {
  return defineWriteTool({
    name: TEST_TOOL,
    title: 'Update test item',
    description: 'Set the status of one test item.',
    kind: 'write',
    cost: 3,
    idempotent: true,
    inputSchema: z.object({ item: z.string(), status: z.string() }),
    allowedFields: { Story: ['Status'] },
    async plan(input, ctx) {
      ctx.budget.spend(1, 'the plan read');
      const item = fake.find(input.item);
      if (item === undefined) throw new AbError(ErrorCode.NotFound, 'No such item.');
      return {
        mutation: {
          operation: 'update_status',
          target: { assetType: 'Story', oid: item.oid, number: item.number },
          changes: [{ field: 'Status', old: item.status, new: input.status }],
        },
        version: String(item.version),
        label: item.title,
      };
    },
    async reread(plan, ctx) {
      ctx.budget.spend(1, 'the re-read');
      fake.beforeReread?.();
      fake.beforeReread = undefined;
      const item = fake.find(plan.mutation.target.oid);
      return { values: { Status: item?.status ?? null }, version: String(item?.version) };
    },
    async send(plan, ctx) {
      ctx.budget.spend(1, 'the write');
      if (fake.failSendWith !== undefined) throw fake.failSendWith;
      const status = plan.mutation.changes[0]?.new as string;
      fake.sends.push({ oid: plan.mutation.target.oid, status });
      const item = fake.items.get(plan.mutation.target.oid);
      if (item !== undefined) {
        item.status = status;
        item.version++;
      }
      return { oid: plan.mutation.target.oid };
    },
  });
}

/** An audit sink that records every row; `failIntent` makes the intent write fail like a broken database. */
export class RecordingAudit implements WriteAuditSink {
  readonly durable = true;
  readonly records: WriteAuditRecord[] = [];
  failIntent = false;
  failOutcome = false;
  /** Called in `intent`, to check what had happened by then (the intent is written before the send). */
  onIntent: (() => void) | undefined;

  async intent(record: WriteAuditRecord): Promise<string | null> {
    if (this.failIntent) throw new Error('database is down');
    this.onIntent?.();
    this.records.push(record);
    return `intent-${this.records.length}`;
  }

  async outcome(record: WriteAuditRecord): Promise<void> {
    if (this.failOutcome) throw new Error('database is down');
    this.records.push(record);
  }
}

export const ACTOR: WriteActor = { id: 'user-1', userId: 'user-1', grantId: 'grant-1', tokenId: 'tok-1' };

/** A channel that answers at once (push elicitation) and counts the questions and the texts it was asked. */
export function answeringChannel(
  answer: boolean | (() => ChannelReply) = true,
  kind: 'elicitation' | 'page' = 'elicitation',
): ApprovalChannelPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    kind,
    asked,
    async ask(prompt) {
      asked.push(prompt.message);
      return typeof answer === 'function' ? answer() : { status: 'answered', approved: answer };
    },
  };
}

export function makeRuntime(overrides: Partial<WriteRuntime> = {}): WriteRuntime & { audit: RecordingAudit } {
  const audit = new RecordingAudit();
  return {
    approval: 'required',
    tools: [TEST_TOOL],
    actor: ACTOR,
    ledger: new ApprovalLedger(memoryLedgerStore(systemClock), systemClock),
    audit,
    stateKey: new Uint8Array(32).fill(7),
    ...overrides,
  } as WriteRuntime & { audit: RecordingAudit };
}

/** A context in which every layer allows `update_test_item`. Each test removes one layer. */
export function writeContext(
  runtime: WriteRuntime | undefined,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return makeContext({
    workspace: {
      id: 'ws-1',
      name: 'Team',
      groups: ['core', 'writes'],
      writes: { enabled: true, approval: runtime?.channel?.kind ?? 'unavailable' },
    },
    grantedTools: [TEST_TOOL],
    ...(runtime === undefined ? {} : { writes: runtime }),
    ...overrides,
  });
}
