// SPDX-License-Identifier: Apache-2.0
// P4-08: OWASP ZAP baseline (passive) scans of the admin panel. `pnpm scan:zap` builds the CLI, starts the same throwaway
// server as the browser E2E (temporary SQLite, fake identity provider and synthetic Agility on loopback, random fake
// tokens), signs in through a setup link and runs ZAP from a pinned container image on the host network against that
// server only:
//   1. /auth/login          not signed in (the pages an attacker sees first)
//   2. /admin               signed in as the owner (session cookie), spidered through the links of the panel
//   3. /api/admin/v1        every operation of the OpenAPI document, with the bootstrap admin token, passive only (`-S`)
// A run fails on any unreviewed alert of risk Medium or High. Accepted alerts live in `.zap/rules.tsv` with a reason.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import globalSetup from './global-setup.ts';
import { startServer, type TestServer } from './server.ts';

/** Pinned by digest (the `stable` tag moves). Update with `docker pull ghcr.io/zaproxy/zaproxy:stable`. */
export const ZAP_IMAGE =
  'ghcr.io/zaproxy/zaproxy@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'zap-reports');
const RULES = join(ROOT, '.zap', 'rules.tsv');

interface Alert {
  readonly pluginid: string;
  readonly alert: string;
  readonly riskcode: string;
  readonly instances?: readonly { readonly uri: string; readonly method: string }[];
}
interface Report {
  readonly site?: readonly { readonly alerts?: readonly Alert[] }[];
}

/**
 * Signs in the way a browser does, with a tiny cookie jar: the setup page's form (the code travels in the URL fragment and
 * the page's script moves it into the form; here it is posted directly), the identity provider's redirect, the callback.
 */
async function signIn(server: TestServer): Promise<string> {
  const jar = new Map<string, string>();
  const link = new URL(await server.setupLink());
  const code = link.hash.slice(1);
  const cookies = (): Record<string, string> =>
    jar.size === 0 ? {} : { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  const keep = (res: Response): void => {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const eq = pair.indexOf('=');
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(line)) jar.delete(pair.slice(0, eq));
      else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  };
  const start = await fetch(`${link.origin}${link.pathname}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: link.origin,
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams({ code, provider: 'oidc-corp' }).toString(),
  });
  keep(start);
  let next = start.headers.get('location');
  for (let i = 0; next !== null && i < 10; i++) {
    const res = await fetch(new URL(next, link.origin).href, { redirect: 'manual', headers: cookies() });
    keep(res);
    next = res.headers.get('location');
  }
  const session = [...jar].find(([k]) => /ab_session$/.test(k));
  if (session === undefined) throw new Error('sign-in through the setup link produced no session cookie');
  return `${session[0]}=${session[1]}`;
}

/** A replacer rule that adds one request header to everything ZAP sends. */
function header(i: number, name: string, value: string): string[] {
  const p = `replacer.full_list(${i})`;
  return [
    `-config ${p}.description=${name}`,
    `-config ${p}.enabled=true`,
    `-config ${p}.matchtype=REQ_HEADER`,
    `-config ${p}.matchstr=${name}`,
    `-config ${p}.regex=false`,
    `-config ${p}.replacement=${value}`,
  ];
}

/** Docker Desktop (Windows/macOS/WSL) runs containers in a VM whose `localhost` is not this machine's. */
function dockerIsDesktop(): boolean {
  const info = spawnSync('docker', ['info', '--format', '{{.OperatingSystem}}'], { encoding: 'utf8' });
  return /docker desktop/i.test(info.stdout);
}

const RELAY = 'ab-zap-relay';
const RELAY_PY = `
import asyncio, sys
port = int(sys.argv[1])
async def pipe(r, w):
    try:
        while (d := await r.read(65536)):
            w.write(d); await w.drain()
    except Exception:
        pass
    finally:
        w.close()
async def handle(r, w):
    try:
        ur, uw = await asyncio.open_connection('host.docker.internal', port)
    except Exception:
        w.close(); return
    await asyncio.gather(pipe(r, uw), pipe(ur, w))
async def main():
    srv = await asyncio.start_server(handle, '127.0.0.1', port)
    async with srv:
        await srv.serve_forever()
asyncio.run(main())
`;

/** Makes the VM's `localhost:<port>` reach the server on this machine's loopback (Docker Desktop only). */
function startRelay(port: number): void {
  const run = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      RELAY,
      '--network',
      'host',
      '--entrypoint',
      'python3',
      ZAP_IMAGE,
      '-c',
      RELAY_PY,
      String(port),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (run.status !== 0) throw new Error('could not start the loopback relay container');
}

function stopRelay(): void {
  spawnSync('docker', ['rm', '-f', RELAY], { stdio: 'ignore' });
}

function zap(args: readonly string[]): number {
  const run = spawnSync(
    'docker',
    ['run', '--rm', '--network', 'host', '-v', `${OUT}:/zap/wrk:rw`, ZAP_IMAGE, ...args],
    { stdio: 'inherit' },
  );
  if (run.error !== undefined) throw run.error;
  return run.status ?? 3;
}

const IGNORED = new Set(
  readFileSync(RULES, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((f) => f[1] === 'IGNORE')
    .map((f) => f[0]),
);

async function main(): Promise<number> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  chmodSync(OUT, 0o777); // the container's `zap` user writes the reports
  const cleanup = globalSetup();
  const server = await startServer({ env: { AB_OAUTH: 'on' } });
  const desktop = dockerIsDesktop();
  if (desktop) startRelay(Number(new URL(server.base).port));
  const secrets: string[] = [server.adminToken];
  let failed = false;
  try {
    const cookie = await signIn(server);
    secrets.push(cookie.slice(cookie.indexOf('=') + 1));

    // Something to look at: an instance, a credential (its token is a secret too), a workspace, a member, a grant and a
    // device token, so the scan spiders pages with data on them.
    const { workspaceId } = await server.seed('scan');
    const owner = ((await server.api('GET', '/users')).json as { id: string }[])[0];
    const member = await server.api('POST', '/users', { email: 'member@example.com', role: 'member' });
    if (member.status !== 201 || owner === undefined) throw new Error(`seed users: ${member.status}`);
    const grant = await server.api('POST', '/grants', { workspaceId, userId: owner.id, label: 'Scan grant' });
    if (grant.status !== 201) throw new Error(`seed grant: ${grant.status}`);
    const grantId = (grant.json as { record: { id: string } }).record.id;
    const issued = await server.api('POST', `/grants/${grantId}/tokens`, { label: 'scan device' });
    if (issued.status !== 201) throw new Error(`seed token: ${issued.status}`);
    secrets.push(...server.seededTokens(), (issued.json as { token: string }).token);

    // The API description needs the admin token too (it is not public): fetch it here and hand ZAP the file, so the scan
    // imports every operation instead of stopping at a 401.
    const spec = await fetch(`${server.base}/api/admin/v1/openapi.json`, {
      headers: { authorization: `Bearer ${server.adminToken}` },
    });
    if (spec.status !== 200) throw new Error(`openapi document: ${spec.status}`);
    writeFileSync(join(OUT, 'openapi.json'), await spec.text());

    const common = ['-I', '-c', '/zap/wrk/rules.tsv', '-m', '2'];
    writeFileSync(join(OUT, 'rules.tsv'), readFileSync(RULES));
    const runs: { name: string; args: string[] }[] = [
      {
        name: 'login',
        args: [
          'zap-baseline.py',
          '-t',
          `${server.base}/auth/login`,
          ...common,
          '-J',
          'login.json',
          '-r',
          'login.html',
        ],
      },
      {
        name: 'admin',
        args: [
          'zap-baseline.py',
          '-t',
          `${server.base}/admin`,
          ...common,
          '-J',
          'admin.json',
          '-r',
          'admin.html',
          '-z',
          header(0, 'Cookie', cookie).join(' '),
        ],
      },
      {
        name: 'api',
        args: [
          'zap-api-scan.py',
          '-t',
          '/zap/wrk/openapi.json',
          '-f',
          'openapi',
          '-O',
          server.base,
          '-S',
          '-I',
          '-c',
          '/zap/wrk/rules.tsv',
          '-J',
          'api.json',
          '-r',
          'api.html',
          '-z',
          header(0, 'Authorization', `Bearer ${server.adminToken}`).join(' '),
        ],
      },
    ];
    for (const run of runs) {
      console.error(`\n=== ZAP ${run.name} ===`);
      const status = zap(run.args);
      if (status > 2) {
        console.error(`ZAP ${run.name} did not complete (exit ${status})`);
        failed = true;
        continue;
      }
      const report = JSON.parse(readFileSync(join(OUT, `${run.name}.json`), 'utf8')) as Report;
      const text =
        readFileSync(join(OUT, `${run.name}.json`), 'utf8') +
        readFileSync(join(OUT, `${run.name}.html`), 'utf8');
      if (secrets.some((s) => text.includes(s))) {
        // Delete both reports so neither a local run nor the workflow's artifact upload keeps the secret.
        rmSync(join(OUT, `${run.name}.json`), { force: true });
        rmSync(join(OUT, `${run.name}.html`), { force: true });
        console.error(`ZAP ${run.name}: report contains a secret value; deleted it`);
        failed = true;
      }
      for (const a of report.site?.flatMap((s) => s.alerts ?? []) ?? []) {
        const risk = Number(a.riskcode);
        const n = a.instances?.length ?? 0;
        const reviewed = IGNORED.has(a.pluginid);
        console.error(
          `${risk >= 2 && !reviewed ? 'FAIL' : 'note'}  [${a.pluginid}] ${a.alert} (risk ${risk}, ${n} instance(s))${reviewed ? ' reviewed' : ''}`,
        );
        if (risk >= 2 && !reviewed) failed = true;
      }
    }
  } finally {
    if (desktop) stopRelay();
    await server.stop();
    cleanup();
  }
  console.error(failed ? '\nZAP scan FAILED' : '\nZAP scan passed (no unreviewed Medium or High alert)');
  return failed ? 1 : 0;
}

process.exitCode = await main();
