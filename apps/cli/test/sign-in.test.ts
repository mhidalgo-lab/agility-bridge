// SPDX-License-Identifier: Apache-2.0
// Sign-in on `agility-bridge serve` (P4-01): the settings, client secrets from files, the owner setup link from the CLI
// to a signed-in owner over real sockets and a local fake identity provider, and the address policy of provider calls.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_LOGIN_POLICY, generateMasterKey, resolveLoginUser } from '@agility-bridge/auth';
import { openSqliteStorage } from '@agility-bridge/storage-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeOidc, fakeOidc } from '../../../packages/auth/test/helpers/fake-idp.ts';
import { serveFetch } from '../../../scripts/serve-fetch.ts';
import { ConfigError } from '../src/config.ts';
import { main } from '../src/main.ts';
import { loadServeConfig, type RunningServer, startServe, withSecretFiles } from '../src/serve.ts';

let dir: string;
let server: RunningServer | undefined;
let stops: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-signin-'));
  writeFileSync(join(dir, 'master.key'), generateMasterKey(1), { mode: 0o600 });
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await Promise.all(stops.map((s) => s()));
  stops = [];
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Windows may hold the database a moment longer (L-104).
  }
});

const GOOGLE = { AB_GOOGLE_CLIENT_ID: 'gid.example.test', AB_GOOGLE_CLIENT_SECRET: 'gsecret-value-123' };
const env = (over: Record<string, string> = {}) => ({
  AB_DATA_DIR: join(dir, 'data'),
  AB_MASTER_KEY_FILE: join(dir, 'master.key'),
  AB_PORT: '0',
  ...over,
});

function secretFile(name: string, content: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

describe('sign-in settings on serve', () => {
  it('reads providers and the policy through the shared parser', () => {
    const c = loadServeConfig({
      AB_DATA_DIR: '/d',
      AB_PUBLIC_URL: 'https://bridge.example.test',
      ...GOOGLE,
      AB_LOGIN_ALLOW_DOMAINS: 'example.test',
      AB_LOGIN_AUTO_PROVISION: 'member',
    });
    expect(c.identity?.providers.map((p) => p.kind)).toEqual(['google']);
    expect(c.identity?.policy.autoProvision).toBe('member');
    expect(c.identityPrivateAddresses).toBe('refuse');
    expect(loadServeConfig({ AB_DATA_DIR: '/d' }).identity).toBeUndefined();
  });

  it('refuses bad values with the variable named and the value never echoed', () => {
    for (const [bad, variable] of [
      [{ AB_GOOGLE_CLIENT_ID: 'x' }, 'AB_GOOGLE_CLIENT_SECRET'],
      [{ ...GOOGLE, AB_LOGIN_AUTO_PROVISION: 'owner' }, 'AB_LOGIN_AUTO_PROVISION'],
      [{ ...GOOGLE, AB_PUBLIC_URL: 'http://bridge.example.test' }, 'AB_PUBLIC_URL'],
      [{ AB_LOGIN_ALLOW_EMAILS: 'ann@example.test' }, 'AB_LOGIN_ALLOW_EMAILS'],
      [{ AB_IDENTITY_PRIVATE_ADDRESSES: 'maybe' }, 'AB_IDENTITY_PRIVATE_ADDRESSES'],
      [{ AB_RATE_LIMIT_SIGN_IN: '0' }, 'AB_RATE_LIMIT_SIGN_IN'],
    ] as Array<[Record<string, string>, string]>) {
      try {
        loadServeConfig({ AB_DATA_DIR: '/d', AB_PUBLIC_URL: 'https://bridge.example.test', ...bad });
        throw new Error(`accepted ${JSON.stringify(bad)}`);
      } catch (error) {
        expect(error, JSON.stringify(bad)).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toContain(variable);
        expect((error as Error).message).not.toContain('gsecret-value-123');
      }
    }
  });

  it('knows the identity settings and rejects typos', () => {
    expect(() => loadServeConfig({ AB_DATA_DIR: '/d', AB_GOOGLE_CLIENT_IDD: 'x' })).toThrow(
      /Unknown setting/,
    );
  });

  it('warns about risky combinations at start', async () => {
    const lines: string[] = [];
    server = await startServe(
      env({
        AB_PUBLIC_URL: 'http://127.0.0.1:8787',
        ...GOOGLE,
        AB_LOGIN_ALLOW_DOMAINS: 'example.test',
      }),
      { sink: (l) => lines.push(l) },
    );
    expect(lines.join('\n')).toContain('only users who already exist can sign in');
    expect(lines.join('\n')).not.toContain('gsecret-value-123');
  });
});

describe('client secrets from files', () => {
  const data = () => join(dir, 'data');

  it('reads <SECRET>_FILE into <SECRET>', () => {
    const file = secretFile('google.secret', 'from-a-file-value\n');
    const out = withSecretFiles({ AB_GOOGLE_CLIENT_SECRET_FILE: file }, data());
    expect(out['AB_GOOGLE_CLIENT_SECRET']).toBe('from-a-file-value');
    const c = loadServeConfig(
      env({
        AB_PUBLIC_URL: 'https://bridge.example.test',
        AB_GOOGLE_CLIENT_ID: 'gid',
        AB_GOOGLE_CLIENT_SECRET_FILE: file,
      }),
    );
    expect(c.identity?.providers[0]).toMatchObject({ kind: 'google', clientId: 'gid' });
    expect(JSON.stringify(c)).not.toContain('from-a-file-value');
  });

  it('refuses both forms, a group-readable file, a link, a file inside the data directory and a missing one', () => {
    const file = secretFile('a.secret', 'value-aaa');
    expect(() =>
      withSecretFiles({ AB_GITHUB_CLIENT_SECRET: 'x', AB_GITHUB_CLIENT_SECRET_FILE: file }, data()),
    ).toThrow(/not both/);
    const open = secretFile('open.secret', 'value-bbb', 0o644);
    const link = join(dir, 'link.secret');
    // Windows has no POSIX modes, and creating links needs a privilege the runners lack.
    if (process.platform !== 'win32') {
      expect(() => withSecretFiles({ AB_OIDC_CLIENT_SECRET_FILE: open }, data())).toThrow(
        /AB_OIDC_CLIENT_SECRET_FILE: .*chmod 600/,
      );
      symlinkSync(file, link);
      expect(() => withSecretFiles({ AB_GOOGLE_CLIENT_SECRET_FILE: link }, data())).toThrow(/symbolic link/);
    }
    mkdirSync(data(), { recursive: true });
    const inside = join(data(), 'in.secret');
    writeFileSync(inside, 'value-ccc', { mode: 0o600 });
    expect(() => withSecretFiles({ AB_GOOGLE_CLIENT_SECRET_FILE: inside }, data())).toThrow(
      /inside the data directory/,
    );
    expect(() => withSecretFiles({ AB_GOOGLE_CLIENT_SECRET_FILE: join(dir, 'missing') }, data())).toThrow(
      ConfigError,
    );
    for (const call of [open, link, join(dir, 'missing')]) {
      try {
        withSecretFiles({ AB_GOOGLE_CLIENT_SECRET_FILE: call }, data());
      } catch (error) {
        expect((error as Error).message).not.toMatch(/value-(aaa|bbb|ccc)/);
      }
    }
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** A fake OIDC provider on a loopback socket; its issuer is its own address. */
async function loopbackIdp(): Promise<FakeOidc> {
  let handler: ((r: Request) => Promise<Response>) | undefined;
  const srv = await serveFetch((r) =>
    (handler ?? (async () => new Response('starting', { status: 503 })))(r),
  );
  stops.push(srv.close);
  const idp = await fakeOidc({ issuer: srv.url });
  handler = idp.fetch;
  return idp;
}

async function cli(args: string[], e: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, {
    env: e,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    stdin: () => async () => '',
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('the first owner, end to end over sockets', () => {
  async function boot(over: Record<string, string> = {}) {
    const idp = await loopbackIdp();
    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    const e = env({
      AB_PORT: String(port),
      AB_PUBLIC_URL: publicUrl,
      AB_OIDC_ISSUER: idp.issuer,
      AB_OIDC_CLIENT_ID: idp.clientId,
      AB_OIDC_CLIENT_SECRET: idp.clientSecret,
      AB_OIDC_NAME: 'corp',
      AB_IDENTITY_PRIVATE_ADDRESSES: 'allow',
      ...over,
    });
    const lines: string[] = [];
    server = await startServe(e, { sink: (l) => lines.push(l) });
    return { idp, publicUrl, e, lines };
  }

  const form = (code: string, provider = 'oidc-corp') =>
    `code=${encodeURIComponent(code)}&provider=${provider}`;
  const post = (publicUrl: string, body: string) =>
    fetch(`${publicUrl}/auth/setup`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      body,
    });

  it('issues a link with the CLI, signs the first owner in with it, and the link is then spent', async () => {
    const { idp, publicUrl, e, lines } = await boot();
    const issued = await cli(['setup-link', '--ttl-minutes', '30'], e);
    expect(issued.code).toBe(0);
    const { url, expiresAt } = JSON.parse(issued.out) as { url: string; expiresAt: number };
    expect(url.startsWith(`${publicUrl}/auth/setup#ab_setup_`)).toBe(true);
    expect(new URL(url).search).toBe('');
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(issued.err).toContain('works once');
    const code = new URL(url).hash.slice(1);

    const page = await fetch(`${publicUrl}/auth/setup`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");

    const start = await post(publicUrl, form(code));
    expect(start.status).toBe(303);
    const location = new URL(start.headers.get('location') as string);
    expect(location.origin).toBe(idp.issuer);
    expect(location.href).not.toContain(code);
    const cookie = (start.headers.get('set-cookie') as string).split(';')[0] as string;
    const { code: authCode, state } = idp.authorize(location, { email: 'first@example.test', sub: 'first' });
    const done = await fetch(`${publicUrl}/auth/callback/oidc-corp?code=${authCode}&state=${state}`, {
      headers: { cookie },
    });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('first@example.test (owner)');
    expect((await post(publicUrl, form(code))).status).toBe(400);
    const owners = (await server?.storage.users.list())?.filter((u) => u.role === 'owner');
    expect(owners).toMatchObject([{ email: 'first@example.test', idp: 'oidc:corp', idpSubject: 'first' }]);

    await server?.audit.flush();
    const rows = await server?.storage.audit.query({ limit: 100 });
    // The sign-in, the issue of the link, and the refused replay of the spent link.
    expect(rows?.map((r) => r.action).sort()).toEqual(['login.denied', 'login.ok', 'setup_link.create']);
    const text = `${lines.join('\n')}${JSON.stringify(rows)}${issued.err}`;
    expect(text).not.toContain(code);
    expect(text).not.toContain(idp.clientSecret);
    expect(JSON.stringify(rows)).not.toContain('first@example.test');
  });

  it('refuses the CLI link when sign-in is not configured', async () => {
    const e = env();
    const r = await cli(['setup-link'], e);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Sign-in is not configured');
  });

  it('refuses identity providers on private addresses by default (T11), and allows them on request', async () => {
    const { publicUrl } = await boot({ AB_IDENTITY_PRIVATE_ADDRESSES: 'refuse' });
    const blocked = await fetch(`${publicUrl}/auth/login/oidc-corp`, { redirect: 'manual' });
    expect(blocked.status).toBe(502);
    expect(await blocked.text()).toContain('could not be reached');
    await server?.close();
    server = undefined;
    const { publicUrl: again } = await boot({ AB_IDENTITY_PRIVATE_ADDRESSES: 'allow' });
    expect((await fetch(`${again}/auth/login/oidc-corp`, { redirect: 'manual' })).status).toBe(302);
  });

  it('serves the sign-in routes on the real socket with the edge headers', async () => {
    const { publicUrl } = await boot();
    const res = await fetch(`${publicUrl}/auth/login`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    // A foreign Host is still refused (DNS rebinding).
    const foreign = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${publicUrl}/auth/login`, { headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(foreign).toBe(403);
  });
});

describe('two connections to one database file (L-185)', () => {
  it('lets exactly one concurrent first sign-in bind the user', async () => {
    const path = join(dir, 'race.db');
    const a = await openSqliteStorage({ path });
    const b = await openSqliteStorage({ path });
    try {
      await a.users.create({ id: 'u-race', email: 'race@example.test', role: 'member' });
      const identity = (idp: string, subject: string) => ({
        idp,
        subject,
        email: 'race@example.test',
        emailVerified: true as const,
        displayName: null,
      });
      const decisions = await Promise.all([
        resolveLoginUser(a.users, identity('google', 'g-1'), EMPTY_LOGIN_POLICY),
        resolveLoginUser(b.users, identity('github', 'gh-1'), EMPTY_LOGIN_POLICY),
        resolveLoginUser(a.users, identity('oidc:corp', 'o-1'), EMPTY_LOGIN_POLICY),
        resolveLoginUser(b.users, identity('cf-access', 'cf-1'), EMPTY_LOGIN_POLICY),
      ]);
      expect(decisions.filter((d) => d.ok)).toHaveLength(1);
      expect(decisions.filter((d) => !d.ok && d.reason === 'identity_conflict')).toHaveLength(3);
      const row = await a.users.get('u-race');
      expect(row?.idp).not.toBeNull();
      expect(await b.users.getByIdentity(row?.idp as string, row?.idpSubject as string)).toMatchObject({
        id: 'u-race',
      });
    } finally {
      await a.close();
      await b.close();
    }
  });
});
