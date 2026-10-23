// SPDX-License-Identifier: Apache-2.0
// The system under test: the built `agility-bridge serve` on a temporary SQLite database, a browser-facing fake OpenID
// Connect provider (self-generated keys, e2e/idp.ts) and the synthetic Agility (scripts/fixture-agility.ts), all on
// loopback with random secrets. Nothing real, no network. `secure: true` puts a TLS proxy with a throw-away
// self-signed certificate in front, so the server sees an `https://` public address and uses the `__Host-` cookies,
// `Secure` and HSTS exactly as a deployment does.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { generateMasterKey } from '../packages/auth/src/secrets/keyring.ts';
import { generateAdminToken } from '../packages/auth/src/tokens/admin.ts';
import { OUT_DIR } from './global-setup.ts';
import { type BrowserIdp, startIdp } from './idp.ts';

/** Obviously fake Agility tokens (the synthetic Agility accepts any token). Built at run time (gitleaks). */
export const fakeAgilityToken = (label: string): string => `1.${label}${randomBytes(9).toString('hex')}`;
export const OWNER = { sub: 'owner-sub', email: 'owner@example.com', name: 'Olive Owner' } as const;
export const MEMBER = { sub: 'member-sub', email: 'member@example.com', name: 'Mia Member' } as const;

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface TestServer {
  /** The public address the browser uses (`http://localhost:<port>` or `https://localhost:<port>`). */
  readonly base: string;
  readonly idp: BrowserIdp;
  /** The synthetic Agility's address (the instance URL to type into the panel). */
  readonly agilityUrl: string;
  /** The bootstrap admin token of this throwaway server (random per start). */
  readonly adminToken: string;
  readonly dbPath: string;
  /** One-use link that makes the first sign-in the owner. */
  setupLink(): Promise<string>;
  /** A call to the admin API with the bootstrap admin token (seeding and checking state; the panel is what is tested). */
  api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
  /** An instance, a validated shared credential and a workspace on the synthetic Agility, through the admin API. */
  seed(
    slug?: string,
  ): Promise<{ instanceId: string; credentialId: string; workspaceId: string; slug: string }>;
  /** The fake Agility tokens `seed` stored (the ZAP scan checks its reports for them). */
  seededTokens(): string[];
  /** Pretends every live session was created `minutes` ago (the re-authentication window is 10 minutes). */
  ageSessions(minutes: number): void;
  /** Everything the server wrote to stderr so far (structured logs: must never hold a secret). */
  logs(): string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function waitFor(child: ChildProcess, needle: string, what: string): Promise<string> {
  let text = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not start; stderr:\n${text}`)), 30_000);
    child.stderr?.on('data', (c: Buffer) => {
      text += c.toString();
      if (text.includes(needle)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`${what} exited; stderr:\n${text}`));
    });
  });
}

/** A TLS front for the HTTP server: the address the browser (and the server's public URL) uses is `https://`. */
function tlsProxy(dir: string, port: number, backend: number): Promise<Server> {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const up = httpRequest(
      { host: '127.0.0.1', port: backend, method: req.method, path: req.url, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export interface StartOptions {
  /** Put TLS in front (`__Host-` cookies, `Secure`, HSTS). */
  readonly secure?: boolean;
  /** More `AB_*` variables for the server. */
  readonly env?: Readonly<Record<string, string>>;
}

export async function startServer(options: StartOptions = {}): Promise<TestServer> {
  const idp = await startIdp({ ...OWNER });

  const agilityPort = await freePort();
  const agility = spawn(
    process.execPath,
    [join(ROOT, 'scripts', 'fixture-agility.ts'), String(agilityPort)],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  await waitFor(agility, 'Synthetic Agility at', 'synthetic Agility');
  const agilityUrl = `http://127.0.0.1:${agilityPort}/SyntheticInstance`;

  const dir = mkdtempSync(join(tmpdir(), 'ab-e2e-browser-'));
  const publicPort = await freePort();
  const backendPort = options.secure ? await freePort() : publicPort;
  const base = `${options.secure ? 'https' : 'http'}://localhost:${publicPort}`;
  const adminToken = generateAdminToken();
  const dbPath = join(dir, 'agility-bridge.db');
  const child = spawn(process.execPath, [join(OUT_DIR, 'index.mjs'), 'serve'], {
    env: {
      PATH: process.env['PATH'] ?? '',
      AB_HOST: '127.0.0.1',
      AB_PORT: String(backendPort),
      AB_DB_PATH: dbPath,
      AB_MASTER_KEY: generateMasterKey(1),
      AB_ADMIN_TOKEN: adminToken,
      AB_PUBLIC_URL: base,
      AB_OIDC_ISSUER: idp.issuer,
      AB_OIDC_CLIENT_ID: idp.clientId,
      AB_OIDC_CLIENT_SECRET: idp.clientSecret,
      AB_OIDC_NAME: 'corp',
      AB_OIDC_LABEL: 'Corp SSO',
      AB_IDENTITY_PRIVATE_ADDRESSES: 'allow',
      AB_LOGIN_AUTO_PROVISION: 'off',
      AB_ALLOW_HTTP_INSTANCES: 'on',
      ...options.env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => {
    stderr += c.toString();
  });
  await waitFor(child, '"serving"', 'agility-bridge serve').catch(async (error: unknown) => {
    agility.kill();
    await idp.close();
    throw error;
  });
  const proxy = options.secure ? await tlsProxy(dir, publicPort, backendPort) : undefined;

  const stopChild = async (p: ChildProcess) => {
    p.removeAllListeners('exit');
    p.kill('SIGTERM');
    await new Promise<void>((r) => (p.exitCode !== null ? r() : p.once('exit', () => r())));
  };

  const api: TestServer['api'] = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/admin/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${adminToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text === '' ? null : JSON.parse(text) };
  };
  const seeded: string[] = [];
  const must = async (what: string, call: ReturnType<TestServer['api']>) => {
    const r = await call;
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json as Record<string, string>;
  };

  return {
    base,
    idp,
    api,
    async seed(slug = 'synthetic') {
      const instance = await must(
        'instance',
        api('POST', '/instances', { label: 'Synthetic', baseUrl: agilityUrl }),
      );
      const token = fakeAgilityToken('seed');
      seeded.push(token);
      const credential = await must(
        'credential',
        api('POST', '/credentials', {
          instanceId: instance['id'],
          ownerUserId: null,
          label: 'Team read-only',
          token,
        }),
      );
      await must('validate', api('POST', `/credentials/${credential['id']}/validate`));
      const workspace = await must(
        'workspace',
        api('POST', '/workspaces', {
          slug,
          name: 'Synthetic workspace',
          instanceId: instance['id'],
          allowedScopeIds: ['Scope:1001'],
          defaultCredentialId: credential['id'],
        }),
      );
      return {
        instanceId: instance['id'] as string,
        credentialId: credential['id'] as string,
        workspaceId: workspace['id'] as string,
        slug,
      };
    },
    agilityUrl,
    adminToken,
    dbPath,
    async setupLink() {
      const res = await fetch(`http://127.0.0.1:${backendPort}/api/admin/v1/setup-links`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: '{}',
      });
      if (res.status !== 201)
        throw new Error(`setup link: ${res.status} ${await res.text()}\n${stderr.slice(-1500)}`);
      return ((await res.json()) as { url: string }).url;
    },
    seededTokens: () => [...seeded],
    ageSessions(minutes) {
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(
          `UPDATE kv SET value = json_set(value, '$.createdAt', json_extract(value, '$.createdAt') - ?) WHERE key LIKE 'sess:%'`,
        ).run(minutes * 60_000);
      } finally {
        db.close();
      }
    },
    logs: () => stderr,
    async stop() {
      await stopChild(child);
      await stopChild(agility);
      await idp.close();
      if (proxy) await new Promise<void>((r) => proxy.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Evil {
  /** Another site than the panel (`127.0.0.1`: cross-site). */
  readonly crossSite: string;
  /** Another origin on the panel's own site (`localhost` on a different port: same-site, cross-origin). */
  readonly sameSite: string;
  /** The page served at `/` from now on. */
  html: string;
  /** Every request path the attacker's server received. */
  readonly hits: string[];
  close(): Promise<void>;
}

/** A plain-HTTP server for the pages of a hostile site (the CSRF tests). */
export async function startEvil(): Promise<Evil> {
  const port = await freePort();
  const hits: string[] = [];
  const evil: Evil = {
    crossSite: `http://127.0.0.1:${port}`,
    sameSite: `http://localhost:${port}`,
    html: '<!doctype html><title>evil</title>',
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  const server = createHttpServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' }).end(evil.html);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return evil;
}
