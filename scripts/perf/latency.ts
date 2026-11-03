// SPDX-License-Identifier: Apache-2.0
// Latency per tool and deployment mode (P9-03): every read tool at its worst-case fixture (the arguments of the cost
// test, L-114) against the mock Agility (scripts/perf/mock-agility.ts: synthetic, Agility-shaped data and a documented
// latency model), sequentially, N calls after a warm-up. Never a real tenant.
//   node --conditions=source scripts/perf/latency.ts stdio  [--n 15] [--out file]   Node stdio, cold call per tool too
//   node --conditions=source scripts/perf/latency.ts http   [--n 15] [--out file]   `agility-bridge serve` on loopback
//   AB_PERF_URL=https://<worker> AB_PERF_WORKSPACE=<slug> AB_PERF_TOKEN=<device token> AB_PERF_ADMIN_TOKEN=<admin token> \
//     node --conditions=source scripts/perf/latency.ts remote [--n 20] [--out file]   a deployed Worker
// `remote` tags every request with `?perf=<tool>:<i>` so a `wrangler tail --format json` capture can be matched to the
// calls (CPU time per request, `scripts/perf/tail-cpu.ts`).
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WORST_CASES } from '../../packages/core/test/tools/worst-case.ts';
import { startMock } from './mock-agility.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'apps/cli/src/index.ts');
/** Any value works against the mock; built here so no token-like literal sits in the repository. */
const MOCK_CREDENTIAL = ['synthetic', 'value', 'for', 'the', 'mock'].join('-');

export interface ToolStats {
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
  readonly samples: number;
  /** Agility requests per call (the mean of the samples). */
  readonly requests: number | null;
  readonly errors: number;
}
export interface PerfRun {
  readonly mode: string;
  readonly date: string;
  readonly node: string;
  readonly n: number;
  readonly warm: Record<string, ToolStats>;
  /** The first call of a fresh process (stdio only): metadata not cached. */
  readonly cold?: Record<string, { ms: number; requests: number }>;
  /** Tool calls per `?perf=` tag, in order (remote). */
  readonly tags?: string[];
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

export function summarize(ms: readonly number[], requests: readonly number[], errors: number): ToolStats {
  const s = [...ms].sort((a, b) => a - b);
  return {
    p50: Math.round(percentile(s, 50)),
    p95: Math.round(percentile(s, 95)),
    min: Math.round(s[0] ?? 0),
    max: Math.round(s[s.length - 1] ?? 0),
    samples: s.length,
    requests:
      requests.length === 0
        ? null
        : Number((requests.reduce((a, b) => a + b, 0) / requests.length).toFixed(2)),
    errors,
  };
}

type Call = (
  name: string,
  args: Record<string, unknown>,
  tag: string,
) => Promise<{ ms: number; isError: boolean }>;

/** Sequential samples of every tool; `requestsOf` is read around each call when the mode can count them. */
async function measure(
  call: Call,
  names: readonly string[],
  n: number,
  requestsOf?: () => Promise<number>,
): Promise<Record<string, ToolStats>> {
  const out: Record<string, ToolStats> = {};
  for (const name of names) {
    const args = WORST_CASES[name]?.args ?? {};
    const first = await call(name, args, `${name}:warmup`);
    if (first.isError) {
      console.error(`${name}: the call failed; skipped (not offered here, or a fixture mismatch)`);
      continue;
    }
    const ms: number[] = [];
    const reqs: number[] = [];
    let errors = 0;
    for (let i = 0; i < n; i++) {
      const before = requestsOf === undefined ? 0 : await requestsOf();
      const r = await call(name, args, `${name}:${i}`);
      if (requestsOf !== undefined) reqs.push((await requestsOf()) - before);
      if (r.isError) errors++;
      else ms.push(r.ms);
    }
    out[name] = summarize(ms, reqs, errors);
    console.error(`${name}: p50 ${out[name]?.p50} ms, p95 ${out[name]?.p95} ms`);
  }
  return out;
}

/** Tool names with a worst-case fixture; the report tools only when `reports`. */
const NAMES = Object.keys(WORST_CASES);

// ---- stdio ----

interface Stdio {
  readonly child: ChildProcess;
  rpc(method: string, params: unknown): Promise<Record<string, unknown>>;
  close(): void;
}

function startStdio(env: Record<string, string>): Stdio {
  const child = spawn(process.execPath, ['--conditions=source', CLI], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', (line) => {
    try {
      const m = JSON.parse(line) as Record<string, unknown>;
      const resolve = waiting.get(m['id'] as number);
      if (resolve !== undefined) {
        waiting.delete(m['id'] as number);
        resolve(m);
      }
    } catch {
      /* not JSON-RPC */
    }
  });
  let id = 0;
  const send = (m: unknown) => child.stdin?.write(`${JSON.stringify(m)}\n`);
  return {
    child,
    rpc: (method, params) =>
      new Promise((resolve) => {
        const mine = ++id;
        waiting.set(mine, resolve);
        send({ jsonrpc: '2.0', id: mine, method, params });
      }),
    close: () => {
      child.kill();
    },
  };
}

async function initialized(env: Record<string, string>): Promise<Stdio> {
  const s = startStdio(env);
  await s.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'perf', version: '0' },
  });
  s.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return s;
}

const timedCall =
  (s: Stdio): Call =>
  async (name, args) => {
    const t = performance.now();
    const r = await s.rpc('tools/call', { name, arguments: args });
    const result = (r['result'] ?? {}) as { isError?: boolean };
    return { ms: performance.now() - t, isError: r['error'] !== undefined || result.isError === true };
  };

async function stdioRun(n: number): Promise<PerfRun> {
  const mock = await startMock();
  const env = {
    AB_AGILITY_URL: mock.url,
    AB_AGILITY_TOKEN: MOCK_CREDENTIAL,
    AB_ALLOW_HTTP_INSTANCES: 'on',
    AB_REPORTS: 'on',
    AB_ATTACHMENT_DOWNLOAD: 'on',
    AB_LOG_LEVEL: 'error',
  };
  const cold: Record<string, { ms: number; requests: number }> = {};
  for (const name of NAMES) {
    const s = await initialized(env);
    const before = mock.mock.count();
    const r = await timedCall(s)(name, WORST_CASES[name]?.args ?? {}, '');
    if (!r.isError) cold[name] = { ms: Math.round(r.ms), requests: mock.mock.count() - before };
    s.close();
  }
  const s = await initialized(env);
  const warm = await measure(timedCall(s), NAMES, n, async () => mock.mock.count());
  s.close();
  await mock.close();
  return {
    mode: 'node-stdio',
    date: new Date().toISOString().slice(0, 10),
    node: process.version,
    n,
    warm,
    cold,
  };
}

// ---- HTTP (local serve and a Worker) ----

async function httpCall(base: string, token: string, tagged: boolean): Promise<Call> {
  return async (name, args, tag) => {
    const url = tagged ? `${base}?perf=${encodeURIComponent(tag)}` : base;
    const t = performance.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const text = await res.text();
    const ms = performance.now() - t;
    const body = res.headers.get('content-type')?.includes('event-stream')
      ? (text.split('\n').find((l) => l.startsWith('data:')) ?? 'data: {}').slice(5)
      : text;
    try {
      const m = JSON.parse(body) as { error?: unknown; result?: { isError?: boolean } };
      return { ms, isError: !res.ok || m.error !== undefined || m.result?.isError === true };
    } catch {
      return { ms, isError: true };
    }
  };
}

/** Per-tool Agility requests from the audit statistics (calls and requests are summed per tool since `from`). */
async function auditRequests(
  admin: string,
  adminToken: string,
  from: number,
): Promise<Record<string, number>> {
  const res = await fetch(`${admin}/api/admin/v1/audit/stats?groupBy=tool&limit=100&from=${from}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const body = (await res.json()) as {
    data: { key: string | null; calls: number; agilityRequests: number }[];
  };
  return Object.fromEntries(
    body.data.map((r) => [r.key ?? '', r.calls === 0 ? 0 : Number((r.agilityRequests / r.calls).toFixed(2))]),
  );
}

async function names(base: string, token: string): Promise<string[]> {
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const text = await res.text();
  const body =
    text.startsWith('event') || text.startsWith('data')
      ? (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5)
      : text;
  const tools = (JSON.parse(body) as { result: { tools: { name: string }[] } }).result.tools;
  return tools.map((t) => t.name).filter((t) => NAMES.includes(t));
}

async function remoteRun(n: number): Promise<PerfRun> {
  const env = (k: string) => {
    const v = process.env[k];
    if (v === undefined || v === '') throw new Error(`set ${k}`);
    return v;
  };
  const origin = env('AB_PERF_URL').replace(/\/$/, '');
  const base = `${origin}/w/${env('AB_PERF_WORKSPACE')}/mcp`;
  const token = env('AB_PERF_TOKEN');
  const adminToken = env('AB_PERF_ADMIN_TOKEN');
  const offered = await names(base, token);
  const from = Date.now() - 1000;
  const tags: string[] = [];
  const inner = await httpCall(base, token, true);
  const call: Call = async (name, args, tag) => {
    tags.push(tag);
    return inner(name, args, tag);
  };
  const warm = await measure(call, offered, n);
  const reqs = await auditRequests(origin, adminToken, from);
  const merged = Object.fromEntries(
    Object.entries(warm).map(([k, v]) => [k, { ...v, requests: reqs[k] ?? null }]),
  );
  return {
    mode: 'workers',
    date: new Date().toISOString().slice(0, 10),
    node: process.version,
    n,
    warm: merged,
    tags,
  };
}

async function httpRun(n: number): Promise<PerfRun> {
  const mock = await startMock();
  const dir = mkdtempSync(join(tmpdir(), 'ab-perf-'));
  const keys = mkdtempSync(join(tmpdir(), 'ab-perf-keys-'));
  const port = 18787;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AB_DATA_DIR: dir,
    AB_MASTER_KEY_FILE: join(keys, 'master.key'),
    AB_ADMIN_TOKEN_FILE: join(keys, 'admin.token'),
    AB_ALLOW_HTTP_INSTANCES: 'on',
    AB_REPORTS: 'on',
    AB_LOG_LEVEL: 'error',
    AB_PORT: String(port),
    AB_PUBLIC_URL: `http://127.0.0.1:${port}`,
  };
  // Asynchronous: the mock answers from this process, which a blocking child call would stall.
  const cli = async (...args: string[]) =>
    (
      await promisify(execFile)(process.execPath, ['--conditions=source', CLI, ...args], {
        env,
        encoding: 'utf8',
      })
    ).stdout;
  const json = async (...args: string[]) => JSON.parse(await cli(...args)) as Record<string, any>;
  await cli('init', '--key-file', join(keys, 'master.key'));
  const adminToken = (await cli('admin-token')).trim();
  writeFileSync(join(keys, 'admin.token'), adminToken, { mode: 0o600 });
  writeFileSync(join(dir, 'service.token'), MOCK_CREDENTIAL, { mode: 0o600 });
  const instance = await json('instance', 'add', 'Mock', mock.url);
  const credential = await json(
    'credential',
    'add',
    '--instance',
    instance['id'],
    '--label',
    'mock',
    '--from-file',
    join(dir, 'service.token'),
  );
  const user = await json('user', 'add', 'perf@example.com', '--name', 'Perf');
  const workspace = await json(
    'workspace',
    'add',
    'perf',
    '--name',
    'Perf',
    '--instance',
    instance['id'],
    '--project',
    'Scope:1001',
    '--children',
    '--default-credential',
    credential['id'],
    '--tools',
    NAMES.join(','),
  );
  const grant = await json(
    'grant',
    'add',
    '--workspace',
    workspace['id'],
    '--user',
    user['id'],
    '--tools',
    NAMES.join(','),
  );
  const issued = await json('token', 'issue', grant['record']?.id ?? grant['id'], '--label', 'perf');
  const server = spawn(process.execPath, ['--conditions=source', CLI, 'serve'], { env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // Reports and attachment download are off until a workspace turns them on (D-101).
    const patched = await fetch(`http://127.0.0.1:${port}/api/admin/v1/workspaces/${workspace['id']}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ limits: { reports: true, attachmentDownload: true } }),
    });
    if (!patched.ok) throw new Error(`workspace limits: ${patched.status}`);
    const base = `http://127.0.0.1:${port}/w/perf/mcp`;
    const offered = await names(base, issued['token']);
    const call = await httpCall(base, issued['token'], false);
    const warm = await measure(call, offered, n, async () => mock.mock.count());
    return { mode: 'node-http', date: new Date().toISOString().slice(0, 10), node: process.version, n, warm };
  } finally {
    server.kill();
    await mock.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const mode = argv[0];
  const flag = (k: string) => argv[argv.indexOf(k) + 1];
  const n = argv.includes('--n') ? Number(flag('--n')) : 15;
  const run =
    mode === 'stdio'
      ? await stdioRun(n)
      : mode === 'http'
        ? await httpRun(n)
        : mode === 'remote'
          ? await remoteRun(n)
          : undefined;
  if (run === undefined) {
    console.error('usage: latency.ts stdio|http|remote [--n 15] [--out file]');
    return 2;
  }
  const text = `${JSON.stringify(run, null, 2)}\n`;
  if (argv.includes('--out')) writeFileSync(flag('--out') as string, text);
  else process.stdout.write(text);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(2);
    },
  );
}
