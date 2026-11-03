// SPDX-License-Identifier: Apache-2.0
// `workspace set` and `grant update` limit options (P8-46): `--max-rows`, `--quota-daily` and `--quota-monthly` change only
// the limit named; every other limit (row and call budgets, panel switches, the other quota period) stays (THREAT_MODEL T5).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey } from '@agility-bridge/auth';
import { createLogger, silentLogger } from '@agility-bridge/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureAgility, startFixtureAgility } from '../../../scripts/fixture-agility.ts';
import { main } from '../src/main.ts';
import { localClient } from '../src/manage/client.ts';

const AGILITY_TOKEN = '1.ServiceTokenNotRealAbCdEfGhIjKlMn4242';
let dir: string;
let agility: FixtureAgility;
beforeAll(async () => {
  agility = await startFixtureAgility();
});
afterAll(() => agility.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-merge-limits-'));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Windows may hold the database a moment longer (L-104).
  }
});

async function cli(args: string[], env: Record<string, string>, stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, {
    env,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    stdin: () => async () => stdin,
  });
  const text = out.join('\n');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { code, json, out: text, err: err.join('\n') };
}

async function setup() {
  const keyPath = join(dir, 'w.key');
  writeFileSync(keyPath, generateMasterKey(1), { mode: 0o600 });
  const env = { AB_DATA_DIR: join(dir, 'w'), AB_MASTER_KEY_FILE: keyPath, AB_ALLOW_HTTP_INSTANCES: 'on' };
  const run = async (args: string[], stdin = '') => {
    const r = await cli(args, env, stdin);
    expect(r.code, `${args.join(' ')}: ${r.err}`).toBe(0);
    return r.json as Record<string, unknown>;
  };
  const inst = await run(['instance', 'add', 'Main', agility.url]);
  const cred = await run(
    ['credential', 'add', '--instance', String(inst['id']), '--label', 'Service member'],
    AGILITY_TOKEN,
  );
  const user = await run(['user', 'add', 'ann@example.test', '--name', 'Ann']);
  const ws = await run([
    'workspace',
    'add',
    'team',
    '--name',
    'Team',
    '--instance',
    String(inst['id']),
    '--project',
    'Scope:1001',
    '--default-credential',
    String(cred['id']),
  ]);
  const added = (await run([
    'grant',
    'add',
    '--workspace',
    String(ws['id']),
    '--user',
    String(user['id']),
  ])) as { record: Record<string, unknown> };
  const grantId = String(added.record['id']);
  const wsPath = `/workspaces/${String(ws['id'])}`;
  const grantPath = `/grants/${grantId}`;
  const limitsOf = async (path: string) => {
    const client = await localClient(env, silentLogger);
    try {
      return ((await client.request('GET', path)).body as { limits: unknown }).limits;
    } finally {
      await client.close();
    }
  };
  /** Limits the CLI has no flag for (panel switches, budgets), set through the admin API in process. */
  const setLimits = async (path: string, limits: unknown) => {
    const client = await localClient(env, createLogger({ level: 'error', sink: () => {} }));
    try {
      const r = await client.request('PATCH', path, { limits });
      expect(r.status).toBe(200);
    } finally {
      await client.close();
    }
  };
  return { env, run, wsId: String(ws['id']), grantId, wsPath, grantPath, limitsOf, setLimits };
}

describe('workspace set limit options merge (P8-46)', () => {
  it('--quota-daily keeps maxRows, the panel switches and the other period, and the reverse', async () => {
    const { run, wsId, wsPath, limitsOf, setLimits } = await setup();
    await setLimits(wsPath, { maxRows: 50, callBudget: 30, reports: true, quota: { monthly: 9000 } });
    await run(['workspace', 'set', wsId, '--quota-daily', '500']);
    expect(await limitsOf(wsPath)).toEqual({
      maxRows: 50,
      callBudget: 30,
      reports: true,
      quota: { monthly: 9000, daily: 500 },
    });
    await run(['workspace', 'set', wsId, '--max-rows', '20']);
    expect(await limitsOf(wsPath)).toEqual({
      maxRows: 20,
      callBudget: 30,
      reports: true,
      quota: { monthly: 9000, daily: 500 },
    });
  });

  it('`none` removes one limit, and the last quota period removes `quota`', async () => {
    const { run, wsId, wsPath, limitsOf, setLimits } = await setup();
    await setLimits(wsPath, { maxRows: 50, reports: true, quota: { daily: 500, monthly: 9000 } });
    await run(['workspace', 'set', wsId, '--quota-daily', 'none']);
    expect(await limitsOf(wsPath)).toEqual({ maxRows: 50, reports: true, quota: { monthly: 9000 } });
    await run(['workspace', 'set', wsId, '--quota-monthly', 'none', '--max-rows', 'none']);
    expect(await limitsOf(wsPath)).toEqual({ reports: true });
  });

  it('leaves the limits alone without a limit option, and refuses bad values before any change', async () => {
    const { env, run, wsId, wsPath, limitsOf, setLimits } = await setup();
    const before = { maxRows: 50, reports: true, quota: { daily: 500 } };
    await setLimits(wsPath, before);
    await run(['workspace', 'set', wsId, '--name', 'Renamed']);
    expect(await limitsOf(wsPath)).toEqual(before);
    for (const args of [
      ['workspace', 'set', wsId, '--max-rows', '0'],
      ['workspace', 'set', wsId, '--max-rows', '1001'],
      ['workspace', 'set', wsId, '--quota-daily', 'lots'],
      ['workspace', 'set', wsId, '--quota-monthly', '1.5'],
    ]) {
      expect((await cli(args, env)).code, args.join(' ')).toBeGreaterThan(0);
    }
    expect(await limitsOf(wsPath)).toEqual(before);
  });
});

describe('grant update quota options (P8-46)', () => {
  it('merges the quota into the grant limits and `none` removes a period', async () => {
    const { run, grantId, grantPath, limitsOf, setLimits } = await setup();
    await setLimits(grantPath, { maxRows: 40, quota: { monthly: 7000 } });
    await run(['grant', 'update', grantId, '--quota-daily', '300']);
    expect(await limitsOf(grantPath)).toEqual({ maxRows: 40, quota: { monthly: 7000, daily: 300 } });
    await run(['grant', 'update', grantId, '--quota-monthly', 'none']);
    expect(await limitsOf(grantPath)).toEqual({ maxRows: 40, quota: { daily: 300 } });
  });
});
