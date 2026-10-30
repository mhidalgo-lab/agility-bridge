// SPDX-License-Identifier: Apache-2.0
// `agility-bridge doctor` (P8-04, THREAT_MODEL T28, L-077): read-only, scrubbed, consent for the token check.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey, Keyring, verifyKeyring } from '@agility-bridge/auth';
import { openSqliteStorage } from '@agility-bridge/storage-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.ts';
import { type DoctorDeps, type DoctorOptions, renderReport, runDoctor } from '../src/doctor.ts';
import { main } from '../src/main.ts';

const posix = process.platform !== 'win32';
const TOKEN = '1.DoctorTestTokenNotReal0123456789AbCdEf';
const INSTANCE = 'https://agility.example.com/Acme';
const OPTS: DoctorOptions = { checkToken: false, offline: false, fix: false };

let dir: string;
let home: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-doctor-'));
  home = join(dir, 'home');
  cwd = join(dir, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Windows may hold a file a moment longer (L-104).
  }
});

/** Names, modes and contents of everything under `root`: what a write of any kind would change. */
function snapshot(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const rel = join(prefix, name);
    const st = lstatSync(join(root, rel));
    if (st.isDirectory()) {
      out.push(`d ${rel} ${(st.mode & 0o777).toString(8)}`, ...snapshot(root, rel));
    } else if (st.isSymbolicLink()) {
      out.push(`l ${rel} 000`);
    } else {
      out.push(
        `f ${rel} ${(st.mode & 0o777).toString(8)} ${readFileSync(join(root, rel)).toString('base64')}`,
      );
    }
  }
  return out;
}

interface Calls {
  readonly requests: { url: string; authorization: string | null }[];
  validated: number;
}

function fakes(respond?: (request: Request) => Response): { deps: Partial<DoctorDeps>; calls: Calls } {
  const calls: Calls = { requests: [], validated: 0 };
  return {
    calls,
    deps: {
      fetchFor: () => async (request) => {
        calls.requests.push({ url: request.url, authorization: request.headers.get('authorization') });
        return (
          respond?.(request) ??
          new Response(JSON.stringify({ Name: 'Member' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      },
      validate: async () => {
        calls.validated++;
        return {
          status: 'valid',
          memberOid: 'Member:20',
          memberName: 'Zelda Quux',
          memberUsername: 'zq',
          reachableScopeIds: ['Scope:0', 'Scope:1'],
        };
      },
    },
  };
}

type Report = Awaited<ReturnType<typeof runDoctor>>;
const run = (opts: DoctorOptions, env: Record<string, string>, extra: Partial<DoctorDeps> = {}) =>
  runDoctor(opts, { env, home, cwd, ...extra });
const text = (report: Report) => `${renderReport(report, OPTS)}\n${JSON.stringify(report)}`;
const byId = (report: Report, prefix: string) => report.findings.filter((f) => f.id.startsWith(prefix));

async function makeServerData(masterKey: string): Promise<{ dataDir: string; keyFile: string }> {
  const dataDir = join(dir, 'data');
  const storage = await openSqliteStorage({ path: join(dataDir, 'agility-bridge.db') });
  await verifyKeyring(storage, await Keyring.create(masterKey));
  await storage.close();
  const keyFile = join(dir, 'keys', 'master.key');
  mkdirSync(join(dir, 'keys'), { recursive: true });
  writeFileSync(keyFile, masterKey, { mode: 0o600 });
  return { dataDir, keyFile };
}

function plaintextClientFile(): string {
  const file = join(cwd, '.mcp.json');
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        agility: {
          command: 'npx',
          args: ['-y', 'agility-bridge'],
          env: { AB_AGILITY_URL: INSTANCE, AB_AGILITY_TOKEN: TOKEN },
        },
      },
    }),
    { mode: 0o644 },
  );
  chmodSync(file, 0o644);
  return file;
}

describe('doctor: read-only and scrubbed', () => {
  it('without --fix never writes, with a database, key files and client files present', async () => {
    const key = generateMasterKey(1);
    const { dataDir, keyFile } = await makeServerData(key);
    plaintextClientFile();
    if (posix) chmodSync(dataDir, 0o755);
    const before = snapshot(dir);
    const { deps } = fakes();
    const report = await run(
      OPTS,
      {
        AB_AGILITY_URL: INSTANCE,
        AB_AGILITY_TOKEN: TOKEN,
        AB_DATA_DIR: dataDir,
        AB_MASTER_KEY_FILE: keyFile,
      },
      deps,
    );
    expect(snapshot(dir)).toEqual(before);
    expect(report.fixed).toEqual([]);
    expect(byId(report, 'server.database').find((f) => f.id === 'server.database')?.status).toBe('ok');
    expect(byId(report, 'server.key-check')[0]?.status).toBe('ok');
    expect(byId(report, 'client.')[0]?.status).toBe('warn');
  });

  it('prints no secret: not the token, the master key, nor the member', async () => {
    const key = generateMasterKey(1);
    const { dataDir } = await makeServerData(key);
    plaintextClientFile();
    const { deps } = fakes();
    const report = await run(
      { ...OPTS, checkToken: true },
      { AB_AGILITY_URL: INSTANCE, AB_AGILITY_TOKEN: TOKEN, AB_DATA_DIR: dataDir, AB_MASTER_KEY: key },
      deps,
    );
    const all = text(report);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(key);
    expect(all).not.toContain('DoctorTestToken');
    expect(all).not.toContain('Zelda');
  });

  it('scrubs a secret that a message carries', async () => {
    const { deps } = fakes();
    const report = await run(OPTS, { AB_AGILITY_URL: `${INSTANCE}/${TOKEN}`, AB_AGILITY_TOKEN: TOKEN }, deps);
    expect(text(report)).not.toContain(TOKEN);
  });
});

describe('doctor: the network and the token', () => {
  it('probes the configured https instance without credentials, and checks the token only with --check-token', async () => {
    const a = fakes();
    await run(OPTS, { AB_AGILITY_URL: INSTANCE, AB_AGILITY_TOKEN: TOKEN }, a.deps);
    expect(a.calls.validated).toBe(0);
    expect(a.calls.requests).toHaveLength(1);
    expect(a.calls.requests[0]).toEqual({ url: `${INSTANCE}/meta.v1/Member`, authorization: null });

    const b = fakes();
    const report = await run(
      { ...OPTS, checkToken: true },
      { AB_AGILITY_URL: INSTANCE, AB_AGILITY_TOKEN: TOKEN },
      b.deps,
    );
    expect(b.calls.validated).toBe(1);
    expect(byId(report, 'token.check')[0]).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('2 project'),
    });
  });

  it('--offline makes no request, even with --check-token', async () => {
    const { deps, calls } = fakes();
    await run(
      { ...OPTS, offline: true, checkToken: true },
      { AB_AGILITY_URL: INSTANCE, AB_AGILITY_TOKEN: TOKEN },
      deps,
    );
    expect(calls.requests).toHaveLength(0);
    expect(calls.validated).toBe(0);
  });

  it('refuses an http:// instance without any request', async () => {
    const { deps, calls } = fakes();
    const report = await run(
      OPTS,
      { AB_AGILITY_URL: 'http://agility.example.com/Acme', AB_AGILITY_TOKEN: TOKEN },
      deps,
    );
    expect(byId(report, 'config.stdio')[0]?.status).toBe('fail');
    expect(calls.requests).toHaveLength(0);
  });

  it('does not follow a redirect and skips the token check when the probe fails', async () => {
    const { deps, calls } = fakes(
      () => new Response(null, { status: 302, headers: { location: 'https://attacker.example.net/' } }),
    );
    const report = await run(
      { ...OPTS, checkToken: true },
      { AB_AGILITY_URL: INSTANCE, AB_AGILITY_TOKEN: TOKEN },
      deps,
    );
    expect(byId(report, 'instance.reach')[0]?.status).toBe('fail');
    expect(byId(report, 'token.check')[0]?.status).toBe('skip');
    expect(calls.requests.map((r) => r.url)).toEqual([`${INSTANCE}/meta.v1/Member`]);
    expect(calls.validated).toBe(0);
  });

  it('reports a refused token as a failure and an outage as a warning', async () => {
    const { deps } = fakes();
    const env = { AB_AGILITY_URL: INSTANCE, AB_AGILITY_TOKEN: TOKEN };
    const invalid = await run({ ...OPTS, checkToken: true }, env, {
      ...deps,
      validate: async () => ({
        status: 'invalid',
        code: 'AB_AGILITY_AUTH',
        message: 'Agility refused the token.',
      }),
    });
    expect(byId(invalid, 'token.check')[0]?.status).toBe('fail');
    const down = await run({ ...OPTS, checkToken: true }, env, {
      ...deps,
      validate: async () => ({
        status: 'unavailable',
        code: 'AB_AGILITY_UNAVAILABLE',
        message: 'Agility did not answer.',
      }),
    });
    expect(byId(down, 'token.check')[0]?.status).toBe('warn');
  });

  it('no configuration in the shell is information, not a failure', async () => {
    const report = await run(OPTS, {});
    expect(byId(report, 'config.stdio')[0]?.status).toBe('info');
    expect(report.findings.some((f) => f.status === 'fail')).toBe(false);
  });

  it('too old a Node version fails', async () => {
    const report = await run(OPTS, {}, { nodeVersion: '20.11.0' });
    expect(byId(report, 'runtime.node')[0]?.status).toBe('fail');
  });
});

describe('doctor: server data', () => {
  it('fails on a master key that is not the one the database was made with, without writing', async () => {
    const { dataDir } = await makeServerData(generateMasterKey(1));
    const before = snapshot(dir);
    const report = await run(OPTS, { AB_DATA_DIR: dataDir, AB_MASTER_KEY: generateMasterKey(1) });
    expect(byId(report, 'server.key-check')[0]?.status).toBe('fail');
    expect(snapshot(dir)).toEqual(before);
  });

  it('does not create a database or a directory that is missing', async () => {
    const before = snapshot(dir);
    const report = await run(OPTS, {
      AB_DATA_DIR: join(dir, 'nowhere'),
      AB_MASTER_KEY: generateMasterKey(1),
    });
    expect(byId(report, 'server.database').find((f) => f.id === 'server.database')?.status).toBe('skip');
    expect(snapshot(dir)).toEqual(before);
  });

  it('a file that is not an agility-bridge database fails', async () => {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'agility-bridge.db'), 'not a database');
    const report = await run(OPTS, { AB_DATA_DIR: join(dir, 'data') });
    expect(byId(report, 'server.database').find((f) => f.id === 'server.database')?.status).toBe('fail');
  });

  it('a master key file inside the data directory is refused', async () => {
    const { dataDir } = await makeServerData(generateMasterKey(1));
    const inside = join(dataDir, 'master.key');
    writeFileSync(inside, generateMasterKey(1), { mode: 0o600 });
    const report = await run(OPTS, { AB_DATA_DIR: dataDir, AB_MASTER_KEY_FILE: inside });
    expect(byId(report, 'server.master-key')[0]).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('inside the data directory'),
    });
  });
});

describe('doctor: client files', () => {
  it('flags a secret in args, an http address and an unknown AB_ name, naming no value', async () => {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          agility: {
            command: 'npx',
            args: ['-y', 'agility-bridge', '--token', TOKEN],
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a client variable reference, not a template
            env: { AB_AGILITY_URL: 'http://agility.example.com/X', AB_AGILITY_TOKN: '${T}' },
          },
          other: { command: 'something-else', args: ['--token', 'unrelated-secret-value'] },
        },
      }),
    );
    const report = await run(OPTS, {});
    const client = byId(report, 'client.');
    expect(client.some((f) => f.id.endsWith('.args') && f.status === 'fail')).toBe(true);
    expect(client.some((f) => f.id.endsWith('.url') && f.status === 'fail')).toBe(true);
    expect(client.some((f) => f.id.endsWith('.env') && f.status === 'warn')).toBe(true);
    expect(text(report)).not.toContain(TOKEN);
    expect(text(report)).not.toContain('unrelated-secret-value');
  });

  it('accepts variable and prompt references for the token', async () => {
    mkdirSync(join(cwd, '.vscode'));
    writeFileSync(
      join(cwd, '.vscode', 'mcp.json'),
      JSON.stringify({
        servers: {
          agility: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'agility-bridge'],
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a client input reference, not a template
            env: { AB_AGILITY_URL: INSTANCE, AB_AGILITY_TOKEN: '${input:agility-token}' },
          },
        },
      }),
    );
    const report = await run(OPTS, {});
    expect(byId(report, 'client.')).toMatchObject([{ status: 'ok' }]);
  });

  it.skipIf(!posix)(
    'does not read a symbolic link as a client file, and --fix does not change its target',
    async () => {
      const target = join(dir, 'target.json');
      writeFileSync(
        target,
        JSON.stringify({
          mcpServers: { agility: { args: ['agility-bridge'], env: { AB_AGILITY_TOKEN: TOKEN } } },
        }),
        { mode: 0o644 },
      );
      chmodSync(target, 0o644);
      symlinkSync(target, join(cwd, '.mcp.json'));
      const report = await run({ ...OPTS, fix: true }, {});
      expect(byId(report, 'client.')[0]).toMatchObject({
        status: 'warn',
        message: expect.stringContaining('symbolic link'),
      });
      expect(lstatSync(target).mode & 0o777).toBe(0o644);
      expect(report.fixed).toEqual([]);
    },
  );

  it('a file that is not JSON is information, not an error', async () => {
    writeFileSync(join(cwd, '.mcp.json'), '// comment\n{ "mcpServers": {} }');
    const report = await run(OPTS, {});
    expect(byId(report, 'client.')[0]?.status).toBe('info');
  });
});

describe.skipIf(!posix)('doctor --fix', () => {
  it('applies only the listed chmod repairs and changes no content', async () => {
    const { dataDir, keyFile } = await makeServerData(generateMasterKey(1));
    const clientFile = plaintextClientFile();
    chmodSync(dataDir, 0o755);
    chmodSync(keyFile, 0o644);
    const env = { AB_DATA_DIR: dataDir, AB_MASTER_KEY_FILE: keyFile };
    const listed = await run(OPTS, env);
    const plan = listed.findings.flatMap((f) => (f.fix === undefined ? [] : [f.fix.path])).sort();
    expect(plan).toEqual([clientFile, dataDir, keyFile].sort());

    const before = snapshot(dir);
    const fixed = await run({ ...OPTS, fix: true }, env);
    expect(fixed.fixed.map((f) => f.path).sort()).toEqual(plan);
    const after = snapshot(dir);
    // The same names and contents; only the modes of the listed paths differ.
    const strip = (rows: string[]) => rows.map((r) => r.replace(/^(\w \S+) [0-7]{3}/, '$1'));
    expect(strip(after)).toEqual(strip(before));
    expect(lstatSync(dataDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(keyFile).mode & 0o777).toBe(0o600);
    expect(lstatSync(clientFile).mode & 0o777).toBe(0o600);
    // A second run has nothing left to repair.
    expect((await run(OPTS, env)).findings.some((f) => f.fix !== undefined)).toBe(false);
  });
});

describe('doctor: hostile files and the keychain (Phase 8 review S-6, Q-8)', () => {
  it('strips terminal control characters from a server name taken from a foreign file', async () => {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'agility\u001b[2K\u001b[1A\rPASS': {
            command: 'npx',
            args: ['-y', 'agility-bridge', '--token', TOKEN],
          },
        },
      }),
    );
    const report = await run(OPTS, {});
    const shown = `${renderReport(report, OPTS)}\n${JSON.stringify(report)}`;
    expect(shown).not.toContain('\u001b');
    expect(shown).not.toContain('\r');
    expect(byId(report, 'client.').some((f) => f.status === 'fail')).toBe(true);
  });

  it.skipIf(!posix)(
    'does not hang on a FIFO named like a client file',
    async () => {
      execFileSync('mkfifo', [join(cwd, '.mcp.json')]);
      const report = await run(OPTS, {});
      expect(byId(report, 'client.')).toEqual([]);
    },
    5_000,
  );

  it.skipIf(!posix)(
    '--fix does not chmod the directory of an explicit AB_DB_PATH, it only reports it',
    async () => {
      const { dataDir } = await makeServerData(generateMasterKey(1));
      chmodSync(dataDir, 0o775);
      const env = { AB_DB_PATH: join(dataDir, 'agility-bridge.db'), AB_MASTER_KEY: generateMasterKey(1) };
      const report = await run({ ...OPTS, fix: true }, env);
      const dirFinding = byId(report, 'server.data-dir-mode')[0];
      expect(dirFinding?.status).toBe('warn');
      expect(dirFinding?.fix).toBeUndefined();
      expect(report.fixed).toEqual([]);
      expect(lstatSync(dataDir).mode & 0o777).toBe(0o775);
    },
  );

  it('reports a keychain token bound to another host as a failure, an unbound one as a warning, a bound one as ok (P8-31)', async () => {
    const data: Record<string, string> = { 'agility-bridge/agility-token': 'FAKE-TOKEN-0000000000' };
    const keychain = (service: string, account: string) => {
      const v = data[`${service}/${account}`];
      if (v === undefined) throw new ConfigError(`no entry "${service}/${account}"`);
      return v;
    };
    const env = { AB_AGILITY_URL: INSTANCE, AB_AGILITY_TOKEN: 'keychain:agility-token' };
    const unbound = await run({ ...OPTS, offline: false }, env, { keychain });
    expect(unbound.findings.some((f) => f.id === 'config.warning' && f.message.includes('not bound'))).toBe(
      true,
    );
    expect(byId(unbound, 'config.keychain-binding')).toEqual([]);
    data['agility-bridge/agility-token#host'] = new URL(INSTANCE).host;
    const ok = await run({ ...OPTS, offline: false }, env, { keychain });
    expect(byId(ok, 'config.keychain-binding')[0]?.status).toBe('ok');
    data['agility-bridge/agility-token#host'] = 'other.example.org';
    const bad = await run({ ...OPTS, offline: false }, env, { keychain });
    expect(byId(bad, 'config.stdio')[0]?.status).toBe('fail');
    expect(byId(bad, 'config.stdio')[0]?.message).toContain('other.example.org');
  });

  it('--offline reads nothing from the keychain and reports the checks as skipped', async () => {
    let reads = 0;
    const keychain = () => {
      reads++;
      return 'FAKE';
    };
    const report = await run(
      { ...OPTS, offline: true },
      {
        AB_AGILITY_URL: INSTANCE,
        AB_AGILITY_TOKEN: 'keychain:agility-token',
        AB_MASTER_KEY: 'keychain:master',
      },
      { keychain },
    );
    expect(reads).toBe(0);
    expect(byId(report, 'config.stdio')[0]?.status).toBe('skip');
    expect(report.findings.some((f) => f.status === 'fail')).toBe(false);
  });
});

describe('doctor: the command', () => {
  it('runs through main, prints a report and exits 0 when nothing failed', async () => {
    const out: string[] = [];
    const code = await main(['doctor', '--offline'], {
      env: { HOME: home },
      out: (t) => out.push(t),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Node');
  });

  it('--json is machine readable, and a failure gives exit 1', async () => {
    const out: string[] = [];
    const code = await main(['doctor', '--offline', '--json'], {
      env: { AB_AGILITY_URL: 'http://agility.example.com/X', AB_AGILITY_TOKEN: TOKEN },
      out: (t) => out.push(t),
      err: () => {},
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join('\n')) as { findings: { status: string }[] };
    expect(parsed.findings.some((f) => f.status === 'fail')).toBe(true);
    expect(out.join('\n')).not.toContain(TOKEN);
  });

  it('refuses a secret flag like every command', async () => {
    const err: string[] = [];
    const code = await main(['doctor', '--token', 'x'], { env: {}, out: () => {}, err: (t) => err.push(t) });
    expect(code).toBe(2);
  });
});
