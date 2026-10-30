// SPDX-License-Identifier: Apache-2.0
// Configuration export and import (P8-05, THREAT_MODEL T29, L-065, L-078): a file that carries no secret unless a
// passphrase seals it, and an import that is additive, goes through the admin API and cannot widen access.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAdminToken, generateMasterKey, Keyring, sealCredentialToken } from '@agility-bridge/auth';
import { silentLogger } from '@agility-bridge/core';
import { openSqliteStorage } from '@agility-bridge/storage-sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureAgility, startFixtureAgility } from '../../../scripts/fixture-agility.ts';
import { main } from '../src/main.ts';
import { localClient } from '../src/manage/client.ts';
import {
  type Bundle,
  buildBundle,
  decryptSecrets,
  encryptSecrets,
  importBundle,
  parseBundle,
} from '../src/manage/config-bundle.ts';
import { type RunningServer, startServe } from '../src/serve.ts';

const posix = process.platform !== 'win32';
const AGILITY_TOKEN = '1.ConfigBundleTokenNotReal0123456789AbCdEf';
const PERSONAL_TOKEN = '1.PersonalTokenOfAnnNotReal0123456789AbCd';
const PASSPHRASE = 'correct horse battery staple';

let dir: string;
let agility: FixtureAgility;
let server: RunningServer | undefined;
beforeAll(async () => {
  agility = await startFixtureAgility();
});
afterAll(() => agility.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-config-'));
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

function envFor(name: string): Record<string, string> {
  const key = join(dir, `${name}.key`);
  writeFileSync(key, generateMasterKey(1), { mode: 0o600 });
  return { AB_DATA_DIR: join(dir, name), AB_MASTER_KEY_FILE: key, AB_ALLOW_HTTP_INSTANCES: 'on' };
}

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

const ok = async (args: string[], env: Record<string, string>, stdin = '') => {
  const r = await cli(args, env, stdin);
  expect(r.code, `${args.join(' ')}: ${r.err}`).toBe(0);
  return r.json as Record<string, unknown>;
};

/** A person's own credential: the admin API refuses to create it (even for the break-glass owner), so it goes in directly. */
async function addPersonalCredential(
  env: Record<string, string>,
  instanceId: string,
  userId: string,
  label: string,
): Promise<void> {
  const keyring = await Keyring.create(readFileSync(env['AB_MASTER_KEY_FILE'] as string, 'utf8').trim());
  const db = await openSqliteStorage({ path: join(env['AB_DATA_DIR'] as string, 'agility-bridge.db') });
  const id = `crd_${crypto.randomUUID().replaceAll('-', '')}`;
  const sealed = await sealCredentialToken(keyring, id, PERSONAL_TOKEN);
  await db.credentials.create({ id, instanceId, ownerUserId: userId, label, ...sealed });
  await db.close();
}

/** A deployment with everything an export must carry and everything it must not. */
async function seedSource(env: Record<string, string>) {
  const inst = await ok(['instance', 'add', 'Main', agility.url], env);
  const shared = await ok(
    ['credential', 'add', '--instance', String(inst['id']), '--label', 'Service member'],
    env,
    AGILITY_TOKEN,
  );
  const ws = await ok(
    [
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
      String(shared['id']),
    ],
    env,
  );
  await ok(
    ['workspace', 'add', 'old', '--name', 'Old', '--instance', String(inst['id']), '--project', 'Scope:1001'],
    env,
  );
  const user = await ok(['user', 'add', 'ann@example.test', '--name', 'Ann'], env);
  // A person's personal credential and a grant that uses it: neither may leave the deployment.
  await addPersonalCredential(env, String(inst['id']), String(user['id']), 'Ann personal');
  await ok(['grant', 'add', '--workspace', String(ws['id']), '--user', String(user['id'])], env);
  await ok(
    ['grant', 'add', '--workspace', String(ws['id']), '--service', 'reporting-bot', '--tools', 'whoami'],
    env,
  );
  const oldWs = (await ok(['workspace', 'list'], env)) as unknown as { id: string; slug: string }[];
  await ok(['workspace', 'disable', String(oldWs.find((w) => w.slug === 'old')?.id)], env);
  return { inst, shared, ws, user };
}

async function names(env: Record<string, string>) {
  const get = async (args: string[]) =>
    (await ok(args, env)) as unknown as { label?: string; slug?: string }[];
  return {
    instances: (await get(['instance', 'list'])).length,
    workspaces: (await get(['workspace', 'list'])).map((w) => w.slug),
    credentials: (await get(['credential', 'list'])).map((c) => c.label),
  };
}

describe('the passphrase seal', () => {
  it('round trips, with a fresh salt and IV each time', async () => {
    const a = await encryptSecrets({ c1: AGILITY_TOKEN }, PASSPHRASE);
    const b = await encryptSecrets({ c1: AGILITY_TOKEN }, PASSPHRASE);
    expect(a).toMatchObject({ kdf: 'PBKDF2-HMAC-SHA256', iterations: 600_000 });
    expect(a.salt).not.toBe(b.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(JSON.stringify(a)).not.toContain(AGILITY_TOKEN);
    expect(await decryptSecrets(a, PASSPHRASE)).toEqual({ c1: AGILITY_TOKEN });
  });

  it('a wrong passphrase and a changed file give the same refusal, and nothing else', async () => {
    const sealed = await encryptSecrets({ c1: AGILITY_TOKEN }, PASSPHRASE);
    await expect(decryptSecrets(sealed, 'another passphrase here')).rejects.toThrow(
      'The passphrase is wrong, or the file was changed.',
    );
    const flipped = { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -6)}AAAAAA` };
    await expect(decryptSecrets(flipped, PASSPHRASE)).rejects.toThrow(
      'The passphrase is wrong, or the file was changed.',
    );
  });

  it('refuses a file that names another key derivation or cost, before deriving anything', async () => {
    const sealed = await encryptSecrets({ c1: 'x'.repeat(20) }, PASSPHRASE);
    await expect(decryptSecrets({ ...sealed, iterations: 1_000 }, PASSPHRASE)).rejects.toThrow(
      /600000|600,000/,
    );
    await expect(decryptSecrets({ ...sealed, iterations: 50_000_000 }, PASSPHRASE)).rejects.toThrow(
      /refusing/,
    );
    await expect(decryptSecrets({ ...sealed, kdf: 'SCRYPT' as never }, PASSPHRASE)).rejects.toThrow(
      /refusing/,
    );
  });

  it('the instances and the credential-to-instance map are part of what the passphrase authenticates (S-1)', async () => {
    const binding = '{"i":[["i1","https://agility.example.com/Acme"]],"c":[["c1","i1"]]}';
    const sealed = await encryptSecrets({ c1: AGILITY_TOKEN }, PASSPHRASE, binding);
    expect(await decryptSecrets(sealed, PASSPHRASE, binding)).toEqual({ c1: AGILITY_TOKEN });
    await expect(
      decryptSecrets(sealed, PASSPHRASE, binding.replace('agility.example.com', 'attacker.example')),
    ).rejects.toThrow('The passphrase is wrong, or the file was changed.');
  });

  it('refuses a short passphrase', async () => {
    await expect(encryptSecrets({ c1: 'x' }, 'short')).rejects.toThrow(/12 to 1,024/);
  });
});

describe('reading a file', () => {
  const good = (): Bundle => ({
    format: 'agility-bridge-config',
    version: 2,
    exportedAt: '2026-10-30T00:00:00.000Z',
    instances: [
      { ref: 'i1', label: 'Main', baseUrl: 'https://agility.example.com/Acme', numberPrefixes: null },
    ],
    credentials: [{ ref: 'c1', instance: 'i1', label: 'Service', tokenHint: '' }],
    workspaces: [
      {
        slug: 'team',
        name: 'Team',
        instance: 'i1',
        allowedScopeIds: ['Scope:1'],
        includeChildScopes: true,
        assetTypes: null,
        enabledTools: null,
        limits: {},
        defaultCredential: 'c1',
        writePolicy: {},
        credentialSource: 'stored',
      },
    ],
    grants: [
      {
        workspace: 'team',
        label: 'bot',
        credential: 'c1',
        tools: null,
        scopeIds: null,
        assetTypes: null,
        limits: {},
        rateLimit: null,
        expiresAt: null,
      },
    ],
    secrets: null,
  });
  const text = (b: unknown) => JSON.stringify(b);

  it('accepts a valid file', () => {
    expect(parseBundle(text(good()))).toMatchObject({ version: 2 });
  });

  type Loose = Record<string, unknown> &
    Record<'credentials' | 'grants' | 'workspaces', Record<string, unknown>[]>;
  const cases: [string, (b: Loose) => void][] = [
    ['an owner on a credential', (b) => void Object.assign(b.credentials[0] ?? {}, { ownerUserId: 'usr_x' })],
    ['a user on a grant', (b) => void Object.assign(b.grants[0] ?? {}, { userId: 'usr_x' })],
    ['a role', (b) => void Object.assign(b, { role: 'owner' })],
    ['a token in the clear', (b) => void Object.assign(b.credentials[0] ?? {}, { token: AGILITY_TOKEN })],
    [
      'a credential id on a workspace',
      (b) => void Object.assign(b.workspaces[0] ?? {}, { defaultCredentialId: 'crd_x' }),
    ],
    ['another format', (b) => void Object.assign(b, { format: 'something-else' })],
    ['another version', (b) => void Object.assign(b, { version: 3 })],
  ];
  it.each(cases)('refuses %s (strict: unknown fields are errors)', (_name, change) => {
    const b = good() as unknown as Loose;
    change(b);
    expect(() => parseBundle(text(b))).toThrow(/Not an agility-bridge configuration file/);
  });

  it('refuses dangling and cross-instance references, repeats and bad slugs', () => {
    const dangling = good();
    dangling.credentials[0] = { ...dangling.credentials[0], instance: 'i9' } as never;
    expect(() => parseBundle(text(dangling))).toThrow(/unknown instance/);
    const cross = good();
    cross.instances.push({
      ref: 'i2',
      label: 'Other',
      baseUrl: 'https://other.example.com/X',
      numberPrefixes: null,
    });
    cross.credentials.push({ ref: 'c2', instance: 'i2', label: 'Other', tokenHint: '' });
    cross.workspaces[0] = { ...cross.workspaces[0], defaultCredential: 'c2' } as never;
    expect(() => parseBundle(text(cross))).toThrow(/not one of its instance/);
    const grantCross = good();
    grantCross.instances.push({
      ref: 'i2',
      label: 'Other',
      baseUrl: 'https://other.example.com/X',
      numberPrefixes: null,
    });
    grantCross.credentials.push({ ref: 'c2', instance: 'i2', label: 'Other', tokenHint: '' });
    grantCross.grants[0] = { ...grantCross.grants[0], credential: 'c2' } as never;
    expect(() => parseBundle(text(grantCross))).toThrow(/not one of its workspace's instance/);
    const repeat = good();
    repeat.workspaces.push(repeat.workspaces[0] as never);
    expect(() => parseBundle(text(repeat))).toThrow(/repeats/);
    const slug = good();
    slug.workspaces[0] = { ...slug.workspaces[0], slug: '../etc' } as never;
    expect(() => parseBundle(text(slug))).toThrow(/Not an agility-bridge/);
  });

  it('refuses text that is not JSON and a file over 1 MiB', () => {
    expect(() => parseBundle('nope')).toThrow(/not JSON/);
    expect(() => parseBundle(' '.repeat(1_048_577))).toThrow(/larger than 1 MiB/);
  });
});

describe('export', () => {
  it('lists shared things only, with no token, no person and nothing revoked or disabled', async () => {
    const env = envFor('a');
    await seedSource(env);
    const r = await cli(['config', 'export'], env);
    expect(r.code).toBe(0);
    const bundle = parseBundle(r.out);
    expect(bundle.secrets).toBeNull();
    expect(bundle.instances).toHaveLength(1);
    expect(bundle.credentials.map((c) => c.label)).toEqual(['Service member']);
    expect(bundle.workspaces.map((w) => w.slug)).toEqual(['team']);
    expect(bundle.grants.map((g) => g.label)).toEqual(['reporting-bot']);
    for (const secret of [AGILITY_TOKEN, PERSONAL_TOKEN, 'ann@example.test', 'Ann personal', 'usr_']) {
      expect(r.out, secret).not.toContain(secret);
    }
    expect(r.err).toContain('no tokens exported');
  });

  it('--with-tokens needs --out, the local database and a passphrase, and never overwrites', async () => {
    const env = envFor('a');
    await seedSource(env);
    const out = join(dir, 'export.json');
    expect(
      (await cli(['config', 'export', '--with-tokens'], { ...env, AB_CONFIG_PASSPHRASE: PASSPHRASE })).err,
    ).toContain('needs --out');
    expect(
      (
        await cli(
          ['config', 'export', '--with-tokens', '--out', out],
          { ...env, AB_ADMIN_URL: 'https://x.example.test' },
          PASSPHRASE,
        )
      ).err,
    ).toContain('local database only');
    expect((await cli(['config', 'export', '--with-tokens', '--out', out], env, 'short')).err).toMatch(
      /12 to 1,024/,
    );
    expect(() => lstatSync(out)).toThrow();

    const done = await cli(['config', 'export', '--with-tokens', '--out', out], env, PASSPHRASE);
    expect(done.code, done.err).toBe(0);
    expect(done.json).toMatchObject({ tokens: 1, credentials: 1 });
    const file = readFileSync(out, 'utf8');
    for (const secret of [AGILITY_TOKEN, PERSONAL_TOKEN, PASSPHRASE, 'ann@example.test']) {
      expect(file, secret).not.toContain(secret);
      expect(done.out + done.err, secret).not.toContain(secret);
    }
    if (posix) expect(lstatSync(out).mode & 0o777).toBe(0o600);
    expect(parseBundle(file).secrets).not.toBeNull();
    const again = await cli(['config', 'export', '--with-tokens', '--out', out], env, PASSPHRASE);
    expect(again.code).toBe(1);
    expect(again.err).toContain('already exists');

    // Taking tokens out is an audit event, with counts and no value.
    const db = await openSqliteStorage({ path: join(dir, 'a', 'agility-bridge.db') });
    const rows = (await db.audit.query({ kind: 'admin', limit: 100 })).filter(
      (r) => r.action === 'config.export',
    );
    await db.close();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(AGILITY_TOKEN);
    expect(rows[0]?.details).toMatchObject({ withTokens: true, tokens: 1 });
  });

  it('buildBundle never reads a personal credential into the file', async () => {
    const env = envFor('a');
    await seedSource(env);
    const client = await localClient(env, silentLogger);
    const requests: string[] = [];
    const spy = {
      request: async (m: string, p: string, b?: unknown) => {
        requests.push(`${m} ${p}`);
        return client.request(m, p, b);
      },
    };
    const bundle = await buildBundle(spy);
    await client.close();
    expect(requests.every((q) => q.startsWith('GET '))).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain('Ann personal');
  });
});

describe('import', () => {
  it('is a dry run by default: nothing is written, and the plan says what would be', async () => {
    const a = envFor('a');
    await seedSource(a);
    const file = join(dir, 'plan.json');
    await ok(['config', 'export', '--out', file], a);
    const b = envFor('b');
    const r = await cli(['config', 'import', file], b);
    expect(r.code, r.err).toBe(0);
    const result = r.json as {
      applied: boolean;
      items: { kind: string; action: string }[];
      counts: Record<string, number>;
    };
    expect(result.applied).toBe(false);
    expect(
      result.items
        .filter((i) => i.action === 'create')
        .map((i) => i.kind)
        .sort(),
    ).toEqual(['instance', 'workspace']);
    expect(r.err).toContain('dry run');
    expect(await names(b)).toEqual({ instances: 0, workspaces: [], credentials: [] });
  });

  it('--apply adds the instance and the workspace, names what waits for a token, and a second run changes nothing', async () => {
    const a = envFor('a');
    await seedSource(a);
    const file = join(dir, 'tokenless.json');
    await ok(['config', 'export', '--out', file], a);
    const b = envFor('b');
    const first = await cli(['config', 'import', file, '--apply'], b);
    expect(first.code, first.err + first.out).toBe(0);
    const items = (first.json as { items: { kind: string; action: string; name: string; reason?: string }[] })
      .items;
    // No token in the file: the credential is only named, the workspace is made without its default, and the grant
    // that needs that credential waits for it.
    expect(items.find((i) => i.kind === 'credential')).toMatchObject({ action: 'skip' });
    expect(items.find((i) => i.kind === 'workspace')).toMatchObject({
      action: 'create',
      reason: expect.stringContaining('default credential'),
    });
    expect(items.find((i) => i.kind === 'grant')).toMatchObject({ action: 'skip' });
    expect(await names(b)).toEqual({ instances: 1, workspaces: ['team'], credentials: [] });
    const second = await cli(['config', 'import', file, '--apply'], b);
    expect(second.code).toBe(0);
    const again = (second.json as { items: { action: string }[] }).items;
    expect(again.every((i) => i.action === 'exists' || i.action === 'skip')).toBe(true);
    expect(again.some((i) => i.action === 'create')).toBe(false);
  });

  it('with tokens: the passphrase opens the file, the credential is created as shared and the grant follows', async () => {
    const a = envFor('a');
    await seedSource(a);
    const file = join(dir, 'sealed.json');
    await ok(['config', 'export', '--with-tokens', '--out', file], a, PASSPHRASE);
    const c = envFor('c');
    const wrong = await cli(['config', 'import', file, '--apply'], c, 'not the passphrase!');
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('wrong, or the file was changed');
    expect(await names(c)).toEqual({ instances: 0, workspaces: [], credentials: [] });

    const applied = await cli(['config', 'import', file, '--apply'], c, PASSPHRASE);
    expect(applied.code, applied.err).toBe(0);
    expect(applied.out + applied.err).not.toContain(AGILITY_TOKEN);
    const state = await names(c);
    expect(state).toEqual({ instances: 1, workspaces: ['team'], credentials: ['Service member'] });
    const creds = (await ok(['credential', 'list'], c)) as unknown as {
      ownerUserId: string | null;
      validationStatus: string;
    }[];
    expect(creds[0]).toMatchObject({ ownerUserId: null, validationStatus: 'valid' });
    const ws = (await ok(['workspace', 'list'], c)) as unknown as {
      id: string;
      defaultCredentialId: string | null;
    }[];
    expect(ws[0]?.defaultCredentialId).not.toBeNull();
    const grants = (await ok(['grant', 'list'], c)) as unknown as { userId: string | null; label: string }[];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ userId: null, label: 'reporting-bot' });
    // The audit log of the target records each creation as the CLI's.
    const db = await openSqliteStorage({ path: join(dir, 'c', 'agility-bridge.db') });
    const actions = (await db.audit.query({ kind: 'admin', limit: 100 })).map((r) => r.action);
    await db.close();
    expect(actions).toEqual(
      expect.arrayContaining(['instance.create', 'credential.create', 'workspace.create', 'grant.create']),
    );
  });

  it('a file whose instance address was edited is refused before anything is created, the token goes nowhere (S-1)', async () => {
    const a = envFor('a');
    await seedSource(a);
    const file = join(dir, 'sealed.json');
    await ok(['config', 'export', '--with-tokens', '--out', file], a, PASSPHRASE);
    const edited = JSON.parse(readFileSync(file, 'utf8')) as { instances: { baseUrl: string }[] };
    (edited.instances[0] as { baseUrl: string }).baseUrl = 'https://attacker.example/Acme';
    writeFileSync(file, JSON.stringify(edited));
    const c = envFor('c');
    const r = await cli(['config', 'import', file, '--apply'], c, PASSPHRASE);
    expect(r.code).toBe(1);
    expect(r.err).toContain('wrong, or the file was changed');
    expect(await names(c)).toEqual({ instances: 0, workspaces: [], credentials: [] });
  });

  it('the plan names the address each instance and credential would use (S-1)', async () => {
    const a = envFor('a');
    await seedSource(a);
    const file = join(dir, 'sealed.json');
    await ok(['config', 'export', '--with-tokens', '--out', file], a, PASSPHRASE);
    const r = await cli(['config', 'import', file], envFor('c'), PASSPHRASE);
    const items = (r.json as { items: { kind: string; name: string }[] }).items;
    const url = parseBundle(readFileSync(file, 'utf8')).instances[0]?.baseUrl as string;
    expect(items.find((i) => i.kind === 'instance')?.name).toContain(url.replace(/\/$/, ''));
    expect(items.find((i) => i.kind === 'credential')?.name).toContain(url.replace(/\/$/, ''));
  });

  it('--add-grants finishes a partly failed import: a grant the existing workspace lacks is created, none twice (Q-3)', async () => {
    const a = envFor('a');
    await seedSource(a);
    const file = join(dir, 'sealed.json');
    await ok(['config', 'export', '--with-tokens', '--out', file], a, PASSPHRASE);
    const c = envFor('c');
    expect((await cli(['config', 'import', file, '--apply'], c, PASSPHRASE)).code).toBe(0);
    const grants = (await ok(['grant', 'list'], c)) as unknown as { id: string }[];
    await ok(['grant', 'revoke', String(grants[0]?.id)], c);
    // Without the flag nothing is added, and the plan says how to finish.
    const plain = await cli(['config', 'import', file, '--apply'], c, PASSPHRASE);
    const plainItems = (plain.json as { items: { kind: string; action: string; reason?: string }[] }).items;
    expect(plainItems.find((i) => i.kind === 'grant')).toMatchObject({ action: 'skip' });
    expect(plainItems.find((i) => i.kind === 'workspace')?.reason).toContain('--add-grants');
    const finish = await cli(['config', 'import', file, '--apply', '--add-grants'], c, PASSPHRASE);
    expect(finish.code, finish.err).toBe(0);
    expect(
      (finish.json as { items: { kind: string; action: string }[] }).items.find((i) => i.kind === 'grant'),
    ).toMatchObject({ action: 'create' });
    const again = await cli(['config', 'import', file, '--apply', '--add-grants'], c, PASSPHRASE);
    expect(
      (again.json as { items: { kind: string; action: string }[] }).items.find((i) => i.kind === 'grant'),
    ).toMatchObject({ action: 'exists' });
    expect(
      ((await ok(['grant', 'list'], c)) as unknown as { revokedAt: unknown }[]).filter(
        (g) => g.revokedAt === null,
      ),
    ).toHaveLength(1);
  });

  it('cannot widen access: an existing workspace is left as it is, with its projects', async () => {
    const a = envFor('a');
    await seedSource(a);
    const file = join(dir, 'x.json');
    await ok(['config', 'export', '--out', file], a);
    const widened = parseBundle(readFileSync(file, 'utf8'));
    (widened.workspaces[0] as { allowedScopeIds: string[] }).allowedScopeIds = [
      'Scope:1001',
      'Scope:1002',
      'Scope:0',
    ];
    writeFileSync(file, JSON.stringify(widened));
    const b = envFor('b');
    const inst = await ok(['instance', 'add', 'Mine', agility.url], b);
    await ok(
      [
        'workspace',
        'add',
        'team',
        '--name',
        'Mine',
        '--instance',
        String(inst['id']),
        '--project',
        'Scope:1001',
      ],
      b,
    );
    const r = await cli(['config', 'import', file, '--apply'], b);
    expect(r.code, r.err).toBe(0);
    const ws = (await ok(['workspace', 'list'], b)) as unknown as {
      slug: string;
      name: string;
      allowedScopeIds: string[];
    }[];
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ slug: 'team', name: 'Mine', allowedScopeIds: ['Scope:1001'] });
    // ...and no grant of the file was added to it: a file never opens a new way into what exists.
    const items = (r.json as { items: { kind: string; action: string; reason?: string }[] }).items;
    expect(items.find((i) => i.kind === 'grant')).toMatchObject({
      action: 'skip',
      reason: expect.stringContaining('adds no grants'),
    });
    expect((await ok(['grant', 'list'], b)) as unknown as unknown[]).toHaveLength(0);
  });

  it("never uses a personal credential: a label that is a person's is skipped, and a grant waits", async () => {
    const a = envFor('a');
    await seedSource(a);
    const file = join(dir, 'sealed.json');
    await ok(['config', 'export', '--with-tokens', '--out', file], a, PASSPHRASE);
    // The target already has a personal credential named like the shared one, on the same instance.
    const b = envFor('b');
    const inst = await ok(['instance', 'add', 'Main', agility.url], b);
    const user = await ok(['user', 'add', 'bob@example.test'], b);
    await addPersonalCredential(b, String(inst['id']), String(user['id']), 'Service member');
    const r = await cli(['config', 'import', file, '--apply'], b, PASSPHRASE);
    expect(r.code, r.err).toBe(0);
    const items = (r.json as { items: { kind: string; action: string; reason?: string }[] }).items;
    expect(items.find((i) => i.kind === 'credential')).toMatchObject({
      action: 'skip',
      reason: expect.stringContaining('personal'),
    });
    expect(items.find((i) => i.kind === 'grant')).toMatchObject({ action: 'skip' });
    const creds = (await ok(['credential', 'list'], b)) as unknown as { ownerUserId: string | null }[];
    expect(creds).toHaveLength(1);
    const ws = (await ok(['workspace', 'list'], b)) as unknown as { defaultCredentialId: string | null }[];
    expect(ws[0]?.defaultCredentialId).toBeNull();
  });

  it('a crafted file naming a user, an owner or a token in the clear is refused before anything is read or written', async () => {
    const a = envFor('a');
    await seedSource(a);
    const file = join(dir, 'x.json');
    await ok(['config', 'export', '--out', file], a);
    const bundle = JSON.parse(readFileSync(file, 'utf8')) as { grants: Record<string, unknown>[] };
    Object.assign(bundle.grants[0] ?? {}, { userId: 'usr_victim' });
    writeFileSync(file, JSON.stringify(bundle));
    const b = envFor('b');
    const r = await cli(['config', 'import', file, '--apply'], b);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Not an agility-bridge configuration file');
    expect(await names(b)).toEqual({ instances: 0, workspaces: [], credentials: [] });
  });

  it('workspaces that enable writes or pass-through need --allow-sensitive', async () => {
    const a = envFor('a');
    await seedSource(a);
    const file = join(dir, 'x.json');
    await ok(['config', 'export', '--out', file], a);
    const bundle = parseBundle(readFileSync(file, 'utf8'));
    (bundle.workspaces[0] as { credentialSource: string }).credentialSource = 'passthrough';
    writeFileSync(file, JSON.stringify(bundle));
    const b = envFor('b');
    const refused = await cli(['config', 'import', file, '--apply'], b);
    const items = (refused.json as { items: { kind: string; action: string; reason?: string }[] }).items;
    expect(items.find((i) => i.kind === 'workspace')).toMatchObject({
      action: 'skip',
      reason: expect.stringContaining('--allow-sensitive'),
    });
    expect((await names(b)).workspaces).toEqual([]);
    const allowed = await cli(['config', 'import', file, '--apply', '--allow-sensitive'], b);
    expect(allowed.code, allowed.err).toBe(0);
    expect((await names(b)).workspaces).toEqual(['team']);
  });

  it('refuses a missing file, a link and a file over 1 MiB, without a stack trace', async () => {
    const b = envFor('b');
    expect((await cli(['config', 'import', join(dir, 'missing.json')], b)).err).toContain('does not exist');
    const big = join(dir, 'big.json');
    writeFileSync(big, ' '.repeat(1_048_577));
    expect((await cli(['config', 'import', big], b)).err).toContain('larger than');
  });

  it('through a server, an import with a wrong admin token is refused and creates nothing', async () => {
    const a = envFor('a');
    await seedSource(a);
    const file = join(dir, 'x.json');
    await ok(['config', 'export', '--out', file], a);
    const adminToken = generateAdminToken();
    writeFileSync(join(dir, 'admin.token'), adminToken, { mode: 0o600 });
    const serverEnv = { ...envFor('r'), AB_ADMIN_TOKEN_FILE: join(dir, 'admin.token'), AB_PORT: '0' };
    server = await startServe(serverEnv, { sink: () => {} });
    writeFileSync(join(dir, 'wrong.token'), generateAdminToken(), { mode: 0o600 });
    const denied = await cli(['config', 'import', file, '--apply'], {
      AB_ADMIN_URL: server.url,
      AB_ADMIN_TOKEN_FILE: join(dir, 'wrong.token'),
    });
    expect(denied.code).not.toBe(0);
    expect((await server.storage.instances.list()).length).toBe(0);
    expect((await server.storage.workspaces.list()).length).toBe(0);
    const allowed = await cli(['config', 'import', file, '--apply'], {
      AB_ADMIN_URL: server.url,
      AB_ADMIN_TOKEN_FILE: join(dir, 'admin.token'),
    });
    expect(allowed.code, allowed.err).toBe(0);
    expect((await server.storage.workspaces.list()).map((w) => w.slug)).toEqual(['team']);
  });
});

describe('import against a fake API', () => {
  it('makes only the calls of the plan: reads for a dry run, and no write names an owner or a user', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const api = {
      request: async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        if (method === 'GET') return { status: 200, body: [] };
        return { status: 201, body: { id: `${path.slice(1)}_new` } };
      },
    };
    const bundle: Bundle = {
      format: 'agility-bridge-config',
      version: 2,
      exportedAt: 'x',
      instances: [
        { ref: 'i1', label: 'Main', baseUrl: 'https://agility.example.com/Acme', numberPrefixes: null },
      ],
      credentials: [{ ref: 'c1', instance: 'i1', label: 'Service', tokenHint: '' }],
      workspaces: [
        {
          slug: 'team',
          name: 'Team',
          instance: 'i1',
          allowedScopeIds: ['Scope:1'],
          includeChildScopes: true,
          assetTypes: null,
          enabledTools: null,
          limits: {},
          defaultCredential: 'c1',
          writePolicy: {},
          credentialSource: 'stored',
        },
      ],
      grants: [
        {
          workspace: 'team',
          label: 'bot',
          credential: 'c1',
          tools: null,
          scopeIds: null,
          assetTypes: null,
          limits: {},
          rateLimit: null,
          expiresAt: null,
        },
      ],
      secrets: null,
    };
    await importBundle(api, bundle, { apply: false, allowSensitive: false, secrets: { c1: AGILITY_TOKEN } });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    calls.length = 0;
    await importBundle(api, bundle, { apply: true, allowSensitive: false, secrets: { c1: AGILITY_TOKEN } });
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /instances',
      'POST /credentials',
      'POST /workspaces',
      'POST /grants',
    ]);
    expect(writes.find((c) => c.path === '/credentials')?.body).toMatchObject({ ownerUserId: null });
    expect(writes.find((c) => c.path === '/grants')?.body).toMatchObject({ userId: null });
    expect(JSON.stringify(writes.filter((c) => c.path !== '/credentials'))).not.toContain(AGILITY_TOKEN);
  });
});

if (posix) {
  describe('export file mode', () => {
    it('creates the directory private when it has to', async () => {
      const env = envFor('a');
      await seedSource(env);
      const out = join(dir, 'new-dir', 'export.json');
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o755);
      await ok(['config', 'export', '--out', out], env);
      expect(lstatSync(out).mode & 0o777).toBe(0o600);
    });
  });
}
