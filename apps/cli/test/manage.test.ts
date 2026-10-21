// SPDX-License-Identifier: Apache-2.0
// Management commands (P2-10): local (in-process admin API over SQLite) and remote (a running server's admin API)
// give identical results and audit rows; secrets never come from argv.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAdminToken, generateMasterKey } from '@agility-bridge/auth';
import { openSqliteStorage } from '@agility-bridge/storage-sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureAgility, startFixtureAgility } from '../../../scripts/fixture-agility.ts';
import { main } from '../src/main.ts';
import { COMMANDS, usage } from '../src/manage/commands.ts';
import { type RunningServer, startServe } from '../src/serve.ts';

const AGILITY_TOKEN = '1.ServiceTokenNotRealAbCdEfGhIjKlMn4242';
let dir: string;
let agility: FixtureAgility;
beforeAll(async () => {
  agility = await startFixtureAgility();
});
afterAll(() => agility.close());
let server: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-manage-'));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
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

function keyFile(name: string): string {
  const path = join(dir, name);
  writeFileSync(path, generateMasterKey(1), { mode: 0o600 });
  return path;
}

/** The same administration, step by step; ids flow from one step to the next. */
async function script(env: Record<string, string>) {
  const steps: { args: string[]; code: number | 'serving'; json: unknown }[] = [];
  const run = async (args: string[], stdin = '') => {
    const r = await cli(args, env, stdin);
    steps.push({ args, code: r.code, json: r.json });
    expect(r.code, `${args.join(' ')}: ${r.err}`).toBe(0);
    return r.json as Record<string, unknown>;
  };
  const inst = await run(['instance', 'add', 'Main', agility.url]);
  const cred = await run(
    ['credential', 'add', '--instance', String(inst['id']), '--label', 'Service member'],
    AGILITY_TOKEN,
  );
  expect(cred).toMatchObject({ validationStatus: 'valid', tokenHint: '4242', memberOid: 'Member:20' });
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
    '--project',
    'Scope:1002',
    '--children',
    '--default-credential',
    String(cred['id']),
  ]);
  const grant = (await run([
    'grant',
    'add',
    '--workspace',
    String(ws['id']),
    '--user',
    String(user['id']),
    '--tools',
    'whoami,get_assets',
  ])) as { record: Record<string, unknown> };
  const issued = await run([
    'token',
    'issue',
    String(grant.record['id']),
    '--label',
    'laptop',
    '--expires-days',
    '30',
  ]);
  await run(['token', 'list', String(grant.record['id'])]);
  await run(['grant', 'list', '--workspace', String(ws['id'])]);
  await run(['workspace', 'set', String(ws['id']), '--name', 'Team renamed']);
  await run(['grant', 'revoke', String(grant.record['id'])]);
  return { steps, issued };
}

/** Ids, times and secrets differ between two runs; the shape and values must not. */
function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/"(usr|ins|crd|wsp|grt|tok)_[0-9a-f]{32}"/g, '"$1_ID"')
      .replace(/ab_live_[0-9A-Za-z]{43}_[0-9A-Za-z]{6}/g, 'ab_live_TOKEN')
      .replace(/"ab_live_[0-9A-Za-z]{4}"/g, '"ab_live_PREFIX"')
      .replace(/":1[0-9]{12}/g, '":0'),
  );
}

describe('local and remote management', () => {
  it('give identical results and audit rows (local rows carry via: cli)', async () => {
    const localEnv = { AB_DATA_DIR: join(dir, 'local'), AB_MASTER_KEY_FILE: keyFile('local.key') };
    const local = await script(localEnv);

    const adminToken = generateAdminToken();
    writeFileSync(join(dir, 'admin.token'), adminToken, { mode: 0o600 });
    const serverEnv = {
      AB_DATA_DIR: join(dir, 'remote'),
      AB_MASTER_KEY_FILE: keyFile('remote.key'),
      AB_ADMIN_TOKEN_FILE: join(dir, 'admin.token'),
      AB_PORT: '0',
    };
    server = await startServe(serverEnv, { sink: () => {} });
    const remote = await script({ AB_ADMIN_URL: server.url, AB_ADMIN_TOKEN_FILE: join(dir, 'admin.token') });

    expect(normalize(remote.steps)).toEqual(normalize(local.steps));
    expect((local.issued as { token: string }).token).toMatch(/^ab_live_/);

    await server.audit.flush();
    const remoteRows = await server.storage.audit.query({ kind: 'admin', limit: 100 });
    const localDb = await openSqliteStorage({ path: join(dir, 'local', 'agility-bridge.db') });
    const localRows = await localDb.audit.query({ kind: 'admin', limit: 100 });
    await localDb.close();
    const shape = (rows: typeof remoteRows) =>
      rows
        .map((r) => ({
          action: r.action,
          status: r.status,
          targetType: r.targetType,
          details: { ...r.details, via: 'X' },
        }))
        .sort((a, b) => a.action.localeCompare(b.action));
    expect(shape(localRows)).toEqual(shape(remoteRows));
    expect(new Set(localRows.map((r) => r.details?.['via']))).toEqual(new Set(['cli']));
    expect(new Set(remoteRows.map((r) => r.details?.['via']))).toEqual(new Set(['api']));
    // The Agility token reached neither the output nor the audit log.
    expect(JSON.stringify([local.steps, remote.steps, localRows, remoteRows])).not.toContain(AGILITY_TOKEN);
  });

  it('reports API errors on stderr with exit 1, and usage errors with exit 2', async () => {
    const env = { AB_DATA_DIR: join(dir, 'd'), AB_MASTER_KEY_FILE: keyFile('k.key') };
    const missing = await cli(['grant', 'revoke', 'grt_404'], env);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('not_found');
    const usageErr = await cli(['workspace', 'add', 'x'], env);
    expect(usageErr.code).toBe(2);
    expect(usageErr.err).toContain('--name is required');
    expect((await cli(['user', 'add', 'a@example.test', '--bogus', '1'], env)).code).toBe(2);
    const help = await cli(['token', 'issue', '--help'], env);
    expect(help.out).toContain('agility-bridge token issue <grant-id> --label <value>');
  });

  it('keys status, rotate and retire work on the local database only', async () => {
    const env = { AB_DATA_DIR: join(dir, 'd'), AB_MASTER_KEY_FILE: keyFile('k.key') };
    const inst = (await cli(['instance', 'add', 'M', agility.url], env)).json as {
      id: string;
    };
    expect(
      (await cli(['credential', 'add', '--instance', inst.id, '--label', 's'], env, AGILITY_TOKEN)).code,
    ).toBe(0);
    expect((await cli(['keys', 'status'], env)).json).toEqual([
      { version: 1, credentials: 1, loaded: true, current: true, retired: false },
    ]);
    const k2 = join(dir, 'k2.key');
    writeFileSync(k2, generateMasterKey(2), { mode: 0o600 });
    const rotated = { ...env, AB_MASTER_KEY_FILE: k2, AB_MASTER_KEY_FILE_PREVIOUS: env.AB_MASTER_KEY_FILE };
    expect((await cli(['keys', 'rotate', '--reason', 'test'], rotated)).json).toMatchObject({
      rotated: 1,
      remaining: 0,
    });
    expect((await cli(['keys', 'retire', '1', '--reason', 'done'], rotated)).json).toEqual({ retired: 1 });
    const remote = await cli(['keys', 'status'], { ...env, AB_ADMIN_URL: 'https://mcp.example.test' });
    expect(remote.code).toBe(1);
    expect(remote.err).toContain('local database only');
  });

  it('init writes a 0600 key once', async () => {
    const path = join(dir, 'cfg', 'master.key');
    const first = await cli(['init', '--key-file', path], {});
    expect(first.json).toEqual({ masterKeyFile: path });
    expect(readFileSync(path, 'utf8')).toMatch(/^v1:/);
    expect((await cli(['init', '--key-file', path], {})).code).toBe(1);
  });

  it('remote mode refuses plain HTTP to other hosts and redirects', async () => {
    const r = await cli(['user', 'list'], {
      AB_ADMIN_URL: 'http://mcp.example.test',
      AB_ADMIN_TOKEN: generateAdminToken(),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('HTTPS');
  });
});

describe('secrets never in argv (T23)', () => {
  const SECRET_FLAG = /^--?(?:token|agility[-_]?token|password|secret|api[-_]?key|master[-_]?key)\b/i;

  it('no command takes a secret as an option or argument', () => {
    for (const spec of COMMANDS) {
      for (const o of spec.options ?? [])
        expect(SECRET_FLAG.test(`--${o.name}`), `${spec.words.join(' ')} --${o.name}`).toBe(false);
      for (const a of spec.args ?? [])
        expect(a.name, spec.words.join(' ')).not.toMatch(/token$|secret|password|key$/i);
    }
  });

  it('no documented command line carries a secret', () => {
    const doc = readFileSync(new URL('../../../docs/guide/cli.md', import.meta.url), 'utf8');
    const lines = doc
      .split('\n')
      .filter((l) => /^\s*agility-bridge\s/.test(l) || /`agility-bridge\s/.test(l));
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(line, line).not.toMatch(
        /ab_(?:live|test|admin)_[0-9A-Za-z]{10}|v\d+:[A-Za-z0-9+/]{20}|--(?:token|password|secret|master-key)\b/,
      );
    }
    for (const spec of COMMANDS) expect(doc, usage(spec)).toContain(`agility-bridge ${spec.words.join(' ')}`);
  });

  it('a secret given as a flag is refused before anything runs', async () => {
    const r = await cli(['credential', 'add', '--token', AGILITY_TOKEN], {});
    expect(r.code).toBe(2);
    expect(r.err).toContain('never takes secrets as flags');
  });
});
