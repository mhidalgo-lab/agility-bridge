// SPDX-License-Identifier: Apache-2.0
// The MCP Tasks extension (`io.modelcontextprotocol/tasks`, 2026-07-28, SEP-2663; P8-10, THREAT_MODEL T32, L-016, L-073).
// A client that declares the extension on a `tools/call` of a report tool gets a task handle at once instead of waiting
// for the report; `tasks/get` then does the work, inside that request and its budget (nothing runs after a response, so
// Workers need no `waitUntil`): the first poll claims the task with one atomic marker, runs the stored call through the
// same MCP pipeline as any other call (shaping, envelope, budget, quota, audit) and keeps the sealed result. Records are
// sealed with the keyring's `task` purpose, stored under the SHA-256 of a 256-bit random id (a copy of the store holds no
// usable handle), bound to the owner's grant, workspace and device token, and gone after 15 minutes. A task another
// device, grant or workspace asks about does not exist. Web-standard only; no module state (T21).
import type { EffectiveAccess } from '@agility-bridge/auth';
import { KeyPurpose, type Keyring } from '@agility-bridge/auth';
import { type Clock, canonicalJson, type Random, type ToolDefinition } from '@agility-bridge/core';
import type { KvStore } from '@agility-bridge/storage';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
/** How long a task record lives. */
export const TASK_TTL_MS = 15 * 60_000;
/** How long one poll may own the running of a task before another may try again (the request deadline is 180 s). */
const RUN_LEASE_MS = 200_000;
/** The most serialised argument bytes a task may carry (S-3). */
const MAX_ARGUMENT_BYTES = 8 * 1024;
/** Tasks one grant may start per 15-minute window (S-3): storage and write amplification, not a quota of reports. */
const MAX_TASKS_PER_WINDOW = 30;
/** Characters of result a record may hold: sealed and base64-encoded it must fit one `kv` value (262,144 characters, P-5). */
const MAX_RESULT_CHARS = 150_000;
const POLL_INTERVAL_MS = 2_000;
const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

type Json = Record<string, unknown>;

/** Whether a request carries the 2026-07-28 envelope: only those may use `tasks/*` (L-016). */
export function isModernRequest(message: unknown): boolean {
  const meta = (message as { params?: { _meta?: Json } } | null)?.params?._meta;
  return (
    meta !== undefined &&
    meta !== null &&
    typeof meta === 'object' &&
    typeof meta[PROTOCOL_VERSION_KEY] === 'string'
  );
}

/** Whether a message is a 2026-07-28 `tools/call` that declares the extension (a 2025-era request never does, L-016). */
export function declaresTasks(message: unknown): boolean {
  const params = (message as { params?: { _meta?: Json } } | null)?.params;
  const meta = params?._meta;
  if (meta === undefined || meta === null || typeof meta !== 'object') return false;
  if (typeof meta[PROTOCOL_VERSION_KEY] !== 'string') return false;
  const caps = meta[CAPABILITIES_KEY] as { extensions?: Json } | undefined;
  const ext = caps?.extensions?.[TASKS_EXTENSION];
  return ext !== undefined && ext !== null && typeof ext === 'object';
}

type Status = 'working' | 'completed' | 'failed' | 'cancelled';

interface TaskRecord {
  readonly v: 1;
  readonly grantId: string;
  readonly workspaceId: string;
  readonly tokenId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: Status;
  /** A digest of the scope the result was computed under; a finished result is returned only while it still holds (S-4). */
  scope?: string;
  /** The stored `tools/call` (name and arguments). */
  readonly request: { readonly name: string; readonly arguments: unknown };
  result?: unknown;
  error?: { code: number; message: string };
  updatedAt: number;
}

export interface TaskServiceOptions {
  readonly kv: KvStore;
  readonly keyring: Keyring;
  readonly clock: Clock;
  readonly random: Random;
  /** Override of the run lease (tests); the route sets nothing. */
  readonly leaseMs?: number;
}

/** What the route hands the service for one request. */
export interface TaskRequest {
  readonly message: unknown;
  readonly access: EffectiveAccess;
  /** The tools this caller may call. */
  readonly tools: readonly ToolDefinition[];
  /** Runs one `tools/call` through the MCP pipeline of this request and returns its JSON-RPC result or error. */
  readonly run: (call: {
    name: string;
    arguments: unknown;
  }) => Promise<{ readonly result: unknown } | { readonly error: { code: number; message: string } }>;
}

export interface TaskService {
  /** Whether this `tools/call` becomes a task: the extension is declared and the tool is a granted report tool. */
  wants(message: unknown, tool: string | null, tools: readonly ToolDefinition[]): boolean;
  /** Whether this message is a `tasks/*` request of a 2026-07-28 client (others get the SDK's method-not-found). */
  isTaskRequest(message: unknown): boolean;
  /** Answers a `tools/call` (creates the task) or a `tasks/*` request with the JSON-RPC response body. */
  handle(request: TaskRequest): Promise<Json>;
}

const rpcError = (id: unknown, code: number, message: string): Json => ({
  jsonrpc: '2.0',
  id: typeof id === 'string' || typeof id === 'number' ? id : null,
  error: { code, message },
});

const sha256Hex = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

/** A 256-bit random handle as 43 URL-safe characters. */
const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const iso = (ms: number): string => new Date(ms).toISOString();

export function createTaskService(options: TaskServiceOptions): TaskService {
  const { kv, keyring, clock, random } = options;
  const leaseMs = options.leaseMs ?? RUN_LEASE_MS;
  const recordKey = (hash: string) => `task:${hash}`;
  const leaseKey = (hash: string) => `taskrun:${hash}`;
  const cancelKey = (hash: string) => `taskcancel:${hash}`;
  const scopeOf = (access: EffectiveAccess): Promise<string> =>
    sha256Hex(
      canonicalJson({ projects: access.projects, assetTypes: access.assetTypes, limits: access.limits }),
    );

  async function load(hash: string): Promise<TaskRecord | null> {
    const text = await kv.get(recordKey(hash));
    if (text === null) return null;
    try {
      const sealed = JSON.parse(text) as { ciphertext: string; iv: string; keyVersion: number };
      const record = JSON.parse(await keyring.open(KeyPurpose.Task, `task|${hash}`, sealed)) as TaskRecord;
      return record.expiresAt > clock.now() ? record : null;
    } catch {
      return null;
    }
  }

  async function save(hash: string, record: TaskRecord): Promise<void> {
    const sealed = await keyring.seal(KeyPurpose.Task, `task|${hash}`, JSON.stringify(record));
    await kv.set(recordKey(hash), JSON.stringify(sealed), { expiresAt: record.expiresAt });
  }

  /** The caller's own tasks only: grant, workspace and device token must all match. */
  const owns = (record: TaskRecord, access: EffectiveAccess): boolean =>
    record.grantId === access.grant.id &&
    record.workspaceId === access.workspace.id &&
    record.tokenId === (access.tokenId ?? '');

  const view = (id: string, r: TaskRecord): Json => {
    const base = {
      resultType: 'complete',
      taskId: id,
      status: r.status,
      createdAt: iso(r.createdAt),
      lastUpdatedAt: iso(r.updatedAt),
      ttlMs: Math.max(0, r.expiresAt - clock.now()),
      ...(r.status === 'working' ? { pollIntervalMs: POLL_INTERVAL_MS } : {}),
    };
    if (r.status === 'completed') return { ...base, result: r.result };
    if (r.status === 'failed') return { ...base, error: r.error };
    return base;
  };

  const isTaskId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);

  return {
    wants(message, tool, tools) {
      return (
        declaresTasks(message) && tool !== null && tools.some((t) => t.name === tool && t.group === 'reports')
      );
    },

    isTaskRequest(message) {
      const method = (message as { method?: unknown } | null)?.method;
      return typeof method === 'string' && method.startsWith('tasks/') && isModernRequest(message);
    },

    async handle({ message, access, tools, run }) {
      const m = message as { id?: unknown; method?: unknown; params?: Json };
      const id = m.id;
      const notFound = rpcError(id, -32602, 'Unknown or expired task.');
      try {
        if (m.method === 'tools/call') {
          const params = m.params ?? {};
          const name = typeof params['name'] === 'string' ? params['name'] : '';
          if (!tools.some((t) => t.name === name && t.group === 'reports')) {
            return rpcError(id, -32602, 'This tool cannot run as a task.');
          }
          const args = params['arguments'] ?? {};
          const tool = tools.find((t) => t.name === name);
          if (args === null || typeof args !== 'object' || Array.isArray(args)) {
            return rpcError(id, -32602, 'The arguments must be an object.');
          }
          if (JSON.stringify(args).length > MAX_ARGUMENT_BYTES) {
            return rpcError(id, -32602, 'The arguments are too large for a task.');
          }
          // The call is checked now, so a bad one never becomes a stored task that fails later (S-3).
          if (tool?.deprecatedArguments === undefined && !tool?.inputSchema.safeParse(args).success) {
            return rpcError(id, -32602, `The arguments do not match the input schema of ${name}.`);
          }
          const now = clock.now();
          const window = Math.floor(now / TASK_TTL_MS);
          const allowed = await kv.increment(`taskn:${encodeURIComponent(access.grant.id)}:${window}`, {
            by: 1,
            max: MAX_TASKS_PER_WINDOW,
            expiresAt: (window + 1) * TASK_TTL_MS,
          });
          if (allowed === null) {
            return rpcError(
              id,
              -32000,
              'Too many tasks were started recently for this connection. Wait a few minutes.',
            );
          }
          const taskId = toBase64Url(random.bytes(32));
          const record: TaskRecord = {
            v: 1,
            grantId: access.grant.id,
            workspaceId: access.workspace.id,
            tokenId: access.tokenId ?? '',
            createdAt: now,
            updatedAt: now,
            expiresAt: now + TASK_TTL_MS,
            status: 'working',
            request: { name, arguments: args },
          };
          await save(await sha256Hex(taskId), record);
          const { resultType: _omit, ...task } = view(taskId, record) as Json;
          return {
            jsonrpc: '2.0',
            id: typeof id === 'string' || typeof id === 'number' ? id : null,
            result: { resultType: 'task', ...task },
          };
        }

        const taskId = (m.params as { taskId?: unknown } | undefined)?.taskId;
        if (!isTaskId(taskId)) return notFound;
        const hash = await sha256Hex(taskId);
        const record = await load(hash);
        if (record === null || !owns(record, access)) return notFound;
        const ok = (result: Json) => ({ jsonrpc: '2.0', id: id as never, result });

        if (m.method === 'tasks/update') {
          // None of the report tools ever asks for input, so there is never an outstanding request to answer.
          return rpcError(id, -32602, 'This task is not waiting for input.');
        }

        if (m.method === 'tasks/cancel') {
          if (record.status === 'working') {
            // The marker first: a poll that finishes the report at this moment checks it after saving (Q-5).
            await kv.set(cancelKey(hash), '1', { expiresAt: record.expiresAt });
            const latest = await load(hash);
            if (latest?.status === 'working') {
              latest.status = 'cancelled';
              latest.updatedAt = clock.now();
              await save(hash, latest);
            }
          }
          return ok({ resultType: 'complete' });
        }

        if (m.method !== 'tasks/get') return rpcError(id, -32601, 'Method not found.');
        if (record.status === 'completed') {
          // The result was computed under the scope of that poll; it is returned only while the caller still has the tool
          // and the same scope (S-4).
          const stillAllowed =
            tools.some((t) => t.name === record.request.name && t.group === 'reports') &&
            record.scope === (await scopeOf(access));
          return stillAllowed ? ok(view(taskId, record)) : notFound;
        }
        if (record.status !== 'working') return ok(view(taskId, record));

        // The first poll to take the lease runs the call; any other poll sees it working. A lease that outlives the
        // request deadline lets a later poll try again (reports only read, so a repeat is safe).
        const claimed = await kv.setIfAbsent(leaseKey(hash), '1', { expiresAt: clock.now() + leaseMs });
        if (!claimed) return ok(view(taskId, record));
        try {
          let outcome: Awaited<ReturnType<TaskRequest['run']>>;
          try {
            outcome = await run(record.request);
          } catch {
            // A runner that threw is a failed task, not a lease nobody releases (Q-2).
            outcome = { error: { code: -32603, message: 'The report could not be produced.' } };
          }
          // A cancel that arrived while the report ran wins: the result is dropped.
          const current = await load(hash);
          if (current === null) return notFound;
          if (current.status === 'working') {
            current.updatedAt = clock.now();
            if ('result' in outcome) {
              current.status = 'completed';
              current.result = outcome.result;
              current.scope = await scopeOf(access);
            } else {
              current.status = 'failed';
              current.error = outcome.error;
            }
            const tooLarge =
              current.status === 'completed' && JSON.stringify(current.result).length > MAX_RESULT_CHARS;
            try {
              if (tooLarge) throw new Error('too large');
              await save(hash, current);
            } catch {
              // The report ran and cannot be kept: say so once, never run it again for it (P-5).
              current.status = 'failed';
              delete current.result;
              delete current.scope;
              current.error = { code: -32603, message: 'The result is too large to keep as a task.' };
              await save(hash, current);
            }
            // A cancel that landed between the read and the save still wins (Q-5).
            if ((await kv.get(cancelKey(hash))) !== null) {
              current.status = 'cancelled';
              delete current.result;
              delete current.error;
              delete current.scope;
              current.updatedAt = clock.now();
              await save(hash, current);
            }
          }
          return ok(view(taskId, current));
        } finally {
          await kv.delete(leaseKey(hash)).catch(() => {});
        }
      } catch {
        return rpcError(id, -32603, 'The task service is not available right now.');
      }
    },
  };
}
