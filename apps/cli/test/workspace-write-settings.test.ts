// SPDX-License-Identifier: Apache-2.0
// `workspace set --writes --write-approval` and `grant update --write-approval` (P7-34): the merged policy keeps what the
// command was not told to change, and the same API rules apply (the CLI acts as the break-glass owner).
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
  dir = mkdtempSync(join(tmpdir(), 'ab-write-settings-'));
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
  const policy = async () => {
    const client = await localClient(env, silentLogger);
    try {
      return (
        (await client.request('GET', `/workspaces/${String(ws['id'])}`)).body as { writePolicy: unknown }
      ).writePolicy;
    } finally {
      await client.close();
    }
  };
  /** A policy with custom attributes, set through the admin API in process (the CLI has no flag for them). */
  const setPolicy = async (writePolicy: unknown) => {
    const client = await localClient(env, createLogger({ level: 'error', sink: () => {} }));
    try {
      const r = await client.request('PATCH', `/workspaces/${String(ws['id'])}`, { writePolicy });
      expect(r.status).toBe(200);
    } finally {
      await client.close();
    }
  };
  return { env, run, wsId: String(ws['id']), grantId: String(added.record['id']), policy, setPolicy };
}

describe('workspace set --writes and --write-approval (P7-34)', () => {
  it('merges the policy: changing the approval keeps `enabled` and `customFields`', async () => {
    const { run, wsId, policy, setPolicy } = await setup();
    await setPolicy({ enabled: true, customFields: ['Custom_Region'] });
    await run(['workspace', 'set', wsId, '--write-approval', 'page_only']);
    expect(await policy()).toEqual({ enabled: true, customFields: ['Custom_Region'], approval: 'page_only' });
    await run(['workspace', 'set', wsId, '--writes', 'off']);
    expect(await policy()).toEqual({
      enabled: false,
      customFields: ['Custom_Region'],
      approval: 'page_only',
    });
    await run(['workspace', 'set', wsId, '--writes', 'on', '--write-approval', 'any']);
    expect(await policy()).toEqual({ enabled: true, customFields: ['Custom_Region'] });
  });

  it('leaves the policy alone when neither option is given, and refuses bad words before any request', async () => {
    const { env, run, wsId, policy, setPolicy } = await setup();
    await setPolicy({ enabled: true, approval: 'page_only', customFields: ['Custom_Region'] });
    await run(['workspace', 'set', wsId, '--name', 'Renamed']);
    expect(await policy()).toEqual({ enabled: true, approval: 'page_only', customFields: ['Custom_Region'] });
    for (const args of [
      ['workspace', 'set', wsId, '--writes', 'maybe'],
      ['workspace', 'set', wsId, '--write-approval', 'workspace'],
    ]) {
      expect((await cli(args, env)).code, args.join(' ')).toBeGreaterThan(0);
    }
    expect(await policy()).toEqual({ enabled: true, approval: 'page_only', customFields: ['Custom_Region'] });
    const missing = await cli(['workspace', 'set', 'wsp_404', '--writes', 'on'], env);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('not_found');
  });

  it('sets the approval of a grant with grant update, and `any` removes it', async () => {
    const { run, grantId } = await setup();
    const rate = async (args: string[]) =>
      ((await run(['grant', 'update', grantId, ...args])) as { record: { rateLimit: unknown } }).record
        .rateLimit;
    expect(await rate(['--write-approval', 'page_only'])).toEqual({ writeApproval: 'page_only' });
    expect(await rate(['--write-approval', 'any'])).toBeNull();
  });
});
