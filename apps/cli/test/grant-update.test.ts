// SPDX-License-Identifier: Apache-2.0
// `grant update` (P7-40): the grant's rate and hourly write limit from the command line, over the same PATCH /grants/{id}.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey } from '@agility-bridge/auth';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureAgility, startFixtureAgility } from '../../../scripts/fixture-agility.ts';
import { main } from '../src/main.ts';

const AGILITY_TOKEN = '1.ServiceTokenNotRealAbCdEfGhIjKlMn4242';
let dir: string;
let agility: FixtureAgility;
beforeAll(async () => {
  agility = await startFixtureAgility();
});
afterAll(() => agility.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-grant-update-'));
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
  const keyPath = join(dir, 'g.key');
  writeFileSync(keyPath, generateMasterKey(1), { mode: 0o600 });
  const env = { AB_DATA_DIR: join(dir, 'g'), AB_MASTER_KEY_FILE: keyPath, AB_ALLOW_HTTP_INSTANCES: 'on' };
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
  return { env, run, grantId: String(added.record['id']) };
}

describe('grant update (P7-40)', () => {
  it('sets the rate and the hourly write limit, keeps what it was not told to change, and clears with none', async () => {
    const { run, grantId } = await setup();
    const rate = async (args: string[]) =>
      ((await run(['grant', 'update', grantId, ...args])) as { record: { rateLimit: unknown } }).record
        .rateLimit;
    expect(await rate(['--rate-per-minute', '60'])).toEqual({ perMinute: 60 });
    expect(await rate(['--writes-per-hour', '5'])).toEqual({ perMinute: 60, writesPerHour: 5 });
    expect(await rate(['--write-approval', 'page_only'])).toEqual({
      perMinute: 60,
      writesPerHour: 5,
      writeApproval: 'page_only',
    });
    expect(
      await rate(['--rate-per-minute', 'none', '--writes-per-hour', 'none', '--write-approval', 'any']),
    ).toBeNull();
  });

  it('refuses bad values and an empty change before any request, and a missing grant with exit 1', async () => {
    const { env, grantId } = await setup();
    for (const args of [
      ['grant', 'update', grantId],
      ['grant', 'update', grantId, '--rate-per-minute', '0'],
      ['grant', 'update', grantId, '--writes-per-hour', '1001'],
      ['grant', 'update', grantId, '--writes-per-hour', 'lots'],
      ['grant', 'update', grantId, '--write-approval', 'sometimes'],
    ]) {
      const r = await cli(args, env);
      expect(r.code, args.join(' ')).toBeGreaterThan(0);
    }
    const missing = await cli(['grant', 'update', 'grt_404', '--rate-per-minute', '5'], env);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('not_found');
  });
});
