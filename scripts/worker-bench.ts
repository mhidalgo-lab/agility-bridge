// SPDX-License-Identifier: Apache-2.0
// CPU of the Worker's code paths (P3-10, L-020, L-097), measured in Node (the same V8 as workerd, P0-09): the cold boot
// in fresh child processes, and warm MCP calls with request isolation against Agility-shaped fake responses. Costs are
// also given as multiples of a calibration workload measured in the same run, so runners of different speed compare;
// a path whose relative cost grows past 2× its baseline is flagged.
//   pnpm bench:worker            measure and compare with scripts/bench/worker-baseline.json
//   pnpm bench:worker --update   rewrite the baseline
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASELINE = fileURLToPath(new URL('./bench/worker-baseline.json', import.meta.url));
const THRESHOLD = 2;

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/** A fixed workload: JSON round trips of a 50 KB document (the shape of work the server does). */
export function calibrate(): number {
  const doc = {
    rows: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `Item ${i}`, description: 'x'.repeat(120) })),
  };
  const samples: number[] = [];
  for (let r = 0; r < 7; r++) {
    const t = cpu();
    for (let i = 0; i < 20; i++) JSON.parse(JSON.stringify(doc));
    samples.push(cpu() - t);
  }
  return median(samples);
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.floor((s.length - 1) / 2)] as number);
}

export interface BenchResult {
  readonly calibrationMs: number;
  /** CPU ms per path (median). */
  readonly ms: Record<string, number>;
  /** Cost relative to the calibration workload. */
  readonly relative: Record<string, number>;
  /** Agility requests per call. */
  readonly requests: Record<string, number>;
}

/** Paths whose relative cost grew past THRESHOLD × the baseline (new paths are not flagged). */
export function regressions(current: BenchResult, baseline: BenchResult, threshold = THRESHOLD): string[] {
  return Object.entries(current.relative)
    .filter(
      ([path, v]) =>
        baseline.relative[path] !== undefined && v > (baseline.relative[path] as number) * threshold,
    )
    .map(
      ([path, v]) =>
        `${path}: ${v.toFixed(2)}× calibration, baseline ${baseline.relative[path]?.toFixed(2)}×`,
    );
}

/** One cold boot in this (fresh) process: what the Worker does before its first answer. */
async function coldBoot(): Promise<number> {
  const t = cpu();
  const auth = await import('../packages/auth/src/index.ts');
  const core = await import('../packages/core/src/index.ts');
  const http = await import('../packages/http-app/src/index.ts');
  const storageMod = await import('../packages/storage/src/index.ts');
  const imported = cpu() - t;
  // As the Worker does at module scope (startup, not the request's budget, P3-14).
  const registry = new core.ToolRegistry();
  for (const tool of core.CORE_TOOLS) registry.register(tool);
  core.prewarmToolSchemas(core.CORE_TOOLS);
  const start = cpu();
  const settings = http.parseServerSettings({}, { callBudget: 45, maxResponseBytes: 524_288 });
  const keyring = await auth.Keyring.create(auth.generateMasterKey(1));
  await keyring.warm([auth.KeyPurpose.Credentials, auth.KeyPurpose.KeyCheck, auth.KeyPurpose.AuditIdentity]);
  const storage = storageMod.createMemoryStorage();
  await auth.verifyKeyring(storage, keyring);
  const adminVerifier = await auth.AdminTokenVerifier.create(auth.generateAdminToken());
  const logger = core.createLogger({ level: 'error', sink: () => {} });
  const { app } = http.assembleServer({
    settings,
    storage,
    keyring,
    host: {
      fetchFor: () => (r: Request) => fetch(r),
      limiters: new core.CredentialLimiters({ perCall: true }),
      breakers: new core.CircuitBreakers(),
      metadata: new core.MetadataService({ shareInflight: false }),
      logger,
      clock: core.systemClock,
      random: core.webCryptoRandom,
    },
    logger,
    limiter: new http.MemoryRateLimiter(),
    version: 'bench',
    isolation: 'request',
    registry,
    clientIp: () => 'bench',
    passthroughSecure: () => true,
    adminVerifier,
  });
  await (await app.fetch(new Request('http://127.0.0.1/health'))).text();
  process.stdout.write(JSON.stringify({ boot: cpu() - start, imports: imported }));
  return 0;
}

const CALLS: Record<string, unknown> = {
  'tools/list': { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  whoami: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
  search_work_items: {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'search_work_items', arguments: { limit: 25 } },
  },
  get_work_item: {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'get_work_item', arguments: { asset: 'B-00001' } },
  },
};

async function warmCalls(): Promise<{ ms: Record<string, number>; requests: Record<string, number> }> {
  const { world, post } = await import('../packages/http-app/test/helpers/world.ts');
  const w = await world({ isolation: 'request', background: () => {} }, { detachedAudit: true });
  const ms: Record<string, number> = {};
  const requests: Record<string, number> = {};
  for (const [name, body] of Object.entries(CALLS)) {
    for (let i = 0; i < 5; i++) await (await post(w, 'team-a', w.tokens.alice, body)).text(); // warm-up
    const samples: number[] = [];
    for (let i = 0; i < 25; i++) {
      const before = w.toolCalls.length;
      const t = cpu();
      await (await post(w, 'team-a', w.tokens.alice, body)).text();
      samples.push(cpu() - t);
      const call = w.toolCalls[before];
      if (call !== undefined) requests[name] = call.requestsUsed;
    }
    ms[name] = median(samples);
  }
  return { ms, requests };
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === '--child-cold') return coldBoot();
  const self = fileURLToPath(import.meta.url);
  const cold = Array.from(
    { length: 5 },
    () =>
      JSON.parse(
        execFileSync(process.execPath, ['--conditions=source', self, '--child-cold'], { encoding: 'utf8' }),
      ) as {
        boot: number;
        imports: number;
      },
  );
  const calibrationMs = calibrate();
  const warm = await warmCalls();
  const ms: Record<string, number> = {
    'cold: boot': median(cold.map((c) => c.boot)),
    ...Object.fromEntries(Object.entries(warm.ms).map(([k, v]) => [`warm: ${k}`, v])),
  };
  const relative = Object.fromEntries(
    Object.entries(ms).map(([k, v]) => [k, Number((v / calibrationMs).toFixed(3))]),
  );
  const result: BenchResult = { calibrationMs, ms, relative, requests: warm.requests };
  console.log(JSON.stringify(result, null, 2));
  if (argv.includes('--update')) {
    writeFileSync(BASELINE, `${JSON.stringify(result, null, 2)}\n`);
    console.error(`baseline written: ${BASELINE}`);
    return 0;
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as BenchResult;
  const flagged = regressions(result, baseline);
  for (const f of flagged) console.error(`::warning::CPU regression ${f}`);
  return flagged.length === 0 ? 0 : 1;
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
