// SPDX-License-Identifier: Apache-2.0
// The Cloudflare setup script against a fake wrangler (P3-05, L-100, T34).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { localConfigPath, readJsonc, type SetupOptions, setup, type Wrangler } from '../cf-setup.ts';

const COMMITTED = fileURLToPath(new URL('../../apps/worker/wrangler.jsonc', import.meta.url));

/** A wrangler with state: databases, secrets per worker, deploys; it records every call. */
function fakeWrangler() {
  const state = {
    databases: [] as { name: string; uuid: string }[],
    secrets: new Map<string, string>(),
    deploys: 0,
    calls: [] as string[],
    puts: [] as { name: string; input: string }[],
    createCwd: [] as string[],
  };
  const wrangler: Wrangler = (args, options = {}) => {
    state.calls.push(args.join(' '));
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'whoami') return ok('logged in');
    if (args[0] === 'd1' && args[1] === 'list') return ok(JSON.stringify(state.databases));
    if (args[0] === 'd1' && args[1] === 'create') {
      state.createCwd.push(options.cwd ?? '');
      state.databases.push({ name: args[2] as string, uuid: `uuid-${state.databases.length + 1}` });
      return ok();
    }
    if (args[0] === 'deploy') {
      state.deploys++;
      return ok('Uploaded\n  https://agility-bridge-staging.example.workers.dev\n');
    }
    if (args[0] === 'secret' && args[1] === 'list') {
      return ok(JSON.stringify([...state.secrets.keys()].map((name) => ({ name, type: 'secret_text' }))));
    }
    if (args[0] === 'secret' && args[1] === 'put') {
      state.puts.push({ name: args[2] as string, input: options.input ?? '' });
      state.secrets.set(args[2] as string, options.input ?? '');
      return ok();
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { state, wrangler };
}

let dir: string;
let workerDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-cf-'));
  workerDir = join(dir, 'worker');
  mkdirSync(workerDir);
  copyFileSync(COMMITTED, join(workerDir, 'wrangler.jsonc'));
});

function options(wrangler: Wrangler, over: Partial<SetupOptions> = {}): SetupOptions {
  return {
    name: 'agility-bridge-staging',
    plan: 'free',
    secretsFile: join(dir, 'staging.secrets'),
    showSecrets: false,
    dryRun: false,
    workerDir,
    wrangler,
    fetchHealth: async () => 200,
    log: () => {},
    ...over,
  };
}

describe('cf:setup', () => {
  it('first run: creates the database, writes the local config, deploys and sets both secrets via stdin', async () => {
    const { state, wrangler } = fakeWrangler();
    const result = await setup(options(wrangler));
    expect(result).toEqual({
      created: ['database', 'AB_MASTER_KEY', 'AB_ADMIN_TOKEN'],
      url: 'https://agility-bridge-staging.example.workers.dev',
    });
    expect(state.createCwd[0]).not.toBe('');
    expect(state.createCwd[0]).not.toBe(workerDir);
    const config = readJsonc(readFileSync(localConfigPath(workerDir, 'agility-bridge-staging'), 'utf8'));
    expect(config).toMatchObject({
      name: 'agility-bridge-staging',
      keep_vars: true,
      vars: {
        AB_PLAN: 'free',
        AB_ENVIRONMENT: 'test',
        AB_PUBLIC_URL: 'https://agility-bridge-staging.example.workers.dev',
      },
      d1_databases: [{ binding: 'DB', database_name: 'agility-bridge-staging', database_id: 'uuid-1' }],
    });
    // Secrets only through stdin, never in arguments; the file holds them, mode 0600.
    expect(state.calls.join('\n')).not.toMatch(/v1:|ab_admin_/);
    expect(state.puts.map((p) => p.name)).toEqual(['AB_MASTER_KEY', 'AB_ADMIN_TOKEN']);
    expect(state.puts[0]?.input).toMatch(/^v1:/);
    expect(state.puts[1]?.input).toMatch(/^ab_admin_/);
    const file = readFileSync(join(dir, 'staging.secrets'), 'utf8');
    expect(file).toContain(`AB_MASTER_KEY=${state.puts[0]?.input}`);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'staging.secrets')).mode & 0o777).toBe(0o600);
    // The committed config is untouched.
    expect(readFileSync(join(workerDir, 'wrangler.jsonc'), 'utf8')).toBe(readFileSync(COMMITTED, 'utf8'));
  });

  it('second run: no new database, no secret changed, only a deploy', async () => {
    const { state, wrangler } = fakeWrangler();
    await setup(options(wrangler));
    const before = { databases: state.databases.length, puts: state.puts.length };
    const second = await setup(options(wrangler, { secretsFile: join(dir, 'other.secrets') }));
    expect(second.created).toEqual([]);
    expect(state.databases.length).toBe(before.databases);
    expect(state.puts.length).toBe(before.puts);
    // The first run deployed twice (once to learn its workers.dev address), the second once.
    expect(state.deploys).toBe(3);
    expect(existsSync(join(dir, 'other.secrets'))).toBe(false);
  });

  it('refuses a local config of another deployment, before calling wrangler (T34)', async () => {
    const { state, wrangler } = fakeWrangler();
    writeFileSync(
      localConfigPath(workerDir, 'agility-bridge-staging'),
      JSON.stringify({
        name: 'agility-bridge',
        d1_databases: [{ binding: 'DB', database_name: 'agility-bridge' }],
      }),
    );
    await expect(setup(options(wrangler))).rejects.toThrow(/another deployment/);
    expect(state.calls).toEqual([]);
  });

  it('refuses an existing secrets file and bad names before changing anything', async () => {
    const { state, wrangler } = fakeWrangler();
    writeFileSync(join(dir, 'staging.secrets'), 'old');
    await expect(setup(options(wrangler))).rejects.toThrow(/already exists/);
    for (const name of [
      'Agility-Bridge',
      'other-name',
      'agility-bridge_staging',
      `agility-bridge-${'x'.repeat(60)}`,
    ]) {
      await expect(setup(options(wrangler, { name }))).rejects.toThrow(/--name/);
    }
    expect(state.calls).toEqual([]);
    expect(readFileSync(join(dir, 'staging.secrets'), 'utf8')).toBe('old');
  });

  it('generates nothing when the secrets file cannot be created, or when the secrets would be lost', async () => {
    const { state, wrangler } = fakeWrangler();
    await expect(
      setup(options(wrangler, { secretsFile: join(dir, 'missing', 'x.secrets') })),
    ).rejects.toThrow();
    expect(state.puts).toEqual([]);
    await expect(setup(options(wrangler, { secretsFile: undefined }))).rejects.toThrow(/--secrets-file/);
    expect(state.puts).toEqual([]);
  });

  it('production issues live tokens, every other deployment test tokens', async () => {
    const { wrangler } = fakeWrangler();
    await setup(options(wrangler, { name: 'agility-bridge', secretsFile: join(dir, 'prod.secrets') }));
    const prod = readJsonc(readFileSync(localConfigPath(workerDir, 'agility-bridge'), 'utf8'));
    expect(prod['vars']).toMatchObject({ AB_ENVIRONMENT: 'production' });
  });

  it('--domain: a custom domain as the only address and the public URL', async () => {
    const { state, wrangler } = fakeWrangler();
    let health = '';
    await setup(
      options(wrangler, {
        domain: 'mcp.example.test',
        fetchHealth: async (url) => {
          health = url;
          return 200;
        },
      }),
    );
    const config = readJsonc(readFileSync(localConfigPath(workerDir, 'agility-bridge-staging'), 'utf8'));
    expect(config).toMatchObject({
      workers_dev: false,
      routes: [{ pattern: 'mcp.example.test', custom_domain: true }],
      vars: { AB_PUBLIC_URL: 'https://mcp.example.test' },
    });
    expect(state.deploys).toBe(1); // the public URL is known: no second deploy
    expect(health).toBe('https://mcp.example.test/health');
    await expect(setup(options(wrangler, { domain: 'Not A Host' }))).rejects.toThrow(/--domain/);
    await expect(
      setup(options(wrangler, { domain: 'mcp.example.test', publicUrl: 'https://other.example.test' })),
    ).rejects.toThrow(/disagree/);
  });

  it('writes each secret to the file before Cloudflare gets it (P3-11 review)', async () => {
    const { state, wrangler } = fakeWrangler();
    const file = join(dir, 'order.secrets');
    const seen: string[] = [];
    const checking: Wrangler = (args, o) => {
      if (args[0] === 'secret' && args[1] === 'put') seen.push(readFileSync(file, 'utf8'));
      return wrangler(args, o);
    };
    await setup(options(checking, { secretsFile: file }));
    expect(seen[0]).toContain(`AB_MASTER_KEY=${state.puts[0]?.input}`);
    expect(seen[1]).toContain(`AB_ADMIN_TOKEN=${state.puts[1]?.input}`);
  });

  it('a dry run changes nothing', async () => {
    const { state, wrangler } = fakeWrangler();
    const lines: string[] = [];
    await setup(options(wrangler, { dryRun: true, log: (l) => lines.push(l) }));
    expect(state.calls).toEqual(['whoami', 'd1 list --json']);
    expect(existsSync(localConfigPath(workerDir, 'agility-bridge-staging'))).toBe(false);
    expect(lines.join('\n')).toContain('create D1 database agility-bridge-staging');
  });

  describe('--sign-in (P4-13)', () => {
    // Built at runtime: no secret-shaped literal in the repository.
    const secret = (label: string) =>
      `${label}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const GOOGLE_SECRET = secret('gsecret');
    const OIDC_SECRET = secret('osecret');
    const domain = 'mcp.example.test';

    /** Answers by a fragment of the question; unanswered questions get an empty answer. */
    function terminal(answers: Record<string, string>, asked: string[] = []) {
      const find = (q: string) => Object.entries(answers).find(([k]) => q.includes(k))?.[1] ?? '';
      return {
        prompt: async (q: string) => (asked.push(q), find(q)),
        promptSecret: async (q: string) => (asked.push(q), find(q)),
      };
    }

    /** Everything an observer could see: arguments, logs, the local config, the secrets file. */
    function observed(state: { calls: string[] }, lines: string[]): string {
      const files = [localConfigPath(workerDir, 'agility-bridge-staging'), join(dir, 'staging.secrets')]
        .filter((f) => existsSync(f))
        .map((f) => readFileSync(f, 'utf8'));
      return [...state.calls, ...lines, ...files].join('\n');
    }

    const varsOf = () =>
      readJsonc(readFileSync(localConfigPath(workerDir, 'agility-bridge-staging'), 'utf8'))['vars'];

    it('environment path: variables in the local config, secrets only on stdin, callback URLs printed', async () => {
      const { state, wrangler } = fakeWrangler();
      const lines: string[] = [];
      const env = {
        AB_GOOGLE_CLIENT_ID: 'google-client.apps.example',
        AB_GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
        AB_GOOGLE_HOSTED_DOMAIN: 'example.test',
        AB_OIDC_ISSUER: 'https://idp.example.test',
        AB_OIDC_CLIENT_ID: 'oidc-client',
        AB_OIDC_CLIENT_SECRET: OIDC_SECRET,
        AB_OIDC_NAME: 'corp',
        AB_LOGIN_ALLOW_DOMAINS: 'example.test',
        AB_LOGIN_AUTO_PROVISION: 'member',
      };
      const result = await setup(options(wrangler, { signIn: true, env, domain, log: (l) => lines.push(l) }));
      expect(result.created).toEqual([
        'database',
        'AB_MASTER_KEY',
        'AB_ADMIN_TOKEN',
        'AB_GOOGLE_CLIENT_SECRET',
        'AB_OIDC_CLIENT_SECRET',
      ]);
      expect(varsOf()).toMatchObject({
        AB_PUBLIC_URL: `https://${domain}`,
        AB_GOOGLE_CLIENT_ID: 'google-client.apps.example',
        AB_GOOGLE_HOSTED_DOMAIN: 'example.test',
        AB_OIDC_ISSUER: 'https://idp.example.test',
        AB_OIDC_NAME: 'corp',
        AB_LOGIN_AUTO_PROVISION: 'member',
      });
      expect(JSON.stringify(varsOf())).not.toMatch(/CLIENT_SECRET/);
      expect(state.puts.find((p) => p.name === 'AB_GOOGLE_CLIENT_SECRET')?.input).toBe(GOOGLE_SECRET);
      expect(state.puts.find((p) => p.name === 'AB_OIDC_CLIENT_SECRET')?.input).toBe(OIDC_SECRET);
      const seen = observed(state, lines);
      expect(seen).not.toContain(GOOGLE_SECRET);
      expect(seen).not.toContain(OIDC_SECRET);
      expect(lines).toContain(`  https://${domain}/auth/callback/google`);
      expect(lines).toContain(`  https://${domain}/auth/callback/oidc-corp`);
    });

    it('prompts: asks which providers, reads the secret hidden, never echoes it', async () => {
      const { state, wrangler } = fakeWrangler();
      const lines: string[] = [];
      const asked: string[] = [];
      const hidden: string[] = [];
      const tty = terminal(
        {
          'providers to configure': 'github',
          'GitHub client id': 'gh-client',
          'GitHub client secret': GOOGLE_SECRET,
          'GitHub organizations': 'example-org',
          'Auto-provision': 'member',
        },
        asked,
      );
      await setup(
        options(wrangler, {
          signIn: true,
          domain,
          prompt: tty.prompt,
          promptSecret: async (q) => (hidden.push(q), tty.promptSecret(q)),
          log: (l) => lines.push(l),
        }),
      );
      expect(hidden).toHaveLength(1);
      expect(hidden[0]).toContain('GitHub client secret');
      expect(asked.some((q) => q.includes('Google'))).toBe(false);
      expect(varsOf()).toMatchObject({
        AB_GITHUB_CLIENT_ID: 'gh-client',
        AB_LOGIN_ALLOW_GITHUB_ORGS: 'example-org',
        AB_LOGIN_AUTO_PROVISION: 'member',
      });
      expect(state.puts.map((p) => p.name)).toContain('AB_GITHUB_CLIENT_SECRET');
      expect(observed(state, [...lines, ...asked])).not.toContain(GOOGLE_SECRET);
      expect(lines).toContain(`  https://${domain}/auth/callback/github`);
    });

    it('idempotent: a plain re-run keeps the variables; empty answers keep variables and the stored secret', async () => {
      const { state, wrangler } = fakeWrangler();
      const env = {
        AB_GOOGLE_CLIENT_ID: 'google-client',
        AB_GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
        AB_LOGIN_ALLOW_EMAILS: 'a@example.test',
      };
      await setup(options(wrangler, { signIn: true, env, domain }));
      const putsAfterFirst = state.puts.length;
      const path = localConfigPath(workerDir, 'agility-bridge-staging');
      const first = readFileSync(path, 'utf8');
      // No --sign-in: nothing is asked and nothing changes.
      await setup(options(wrangler, { secretsFile: join(dir, 'b.secrets'), domain }));
      expect(readFileSync(path, 'utf8')).toBe(first);
      expect(state.puts.length).toBe(putsAfterFirst);
      // --sign-in with empty answers: same values, the stored secret is kept.
      const lines: string[] = [];
      await setup(
        options(wrangler, {
          secretsFile: join(dir, 'c.secrets'),
          signIn: true,
          domain,
          ...terminal({}),
          log: (l) => lines.push(l),
        }),
      );
      expect(readFileSync(path, 'utf8')).toBe(first);
      expect(state.puts.length).toBe(putsAfterFirst);
      expect(lines.join('\n')).toContain('warning: An AB_LOGIN_ALLOW_* allowlist is set');
    });

    it('changing a value re-puts only the secret given; "-" clears an optional variable', async () => {
      const { state, wrangler } = fakeWrangler();
      await setup(
        options(wrangler, {
          signIn: true,
          domain,
          env: {
            AB_GITHUB_CLIENT_ID: 'gh-1',
            AB_GITHUB_CLIENT_SECRET: GOOGLE_SECRET,
            AB_LOGIN_ALLOW_DOMAINS: 'example.test',
          },
        }),
      );
      const rotated = secret('rotated');
      await setup(
        options(wrangler, {
          secretsFile: join(dir, 'd.secrets'),
          signIn: true,
          domain,
          env: { AB_GITHUB_CLIENT_ID: 'gh-2', AB_GITHUB_CLIENT_SECRET: rotated, AB_LOGIN_ALLOW_DOMAINS: '-' },
        }),
      );
      expect(varsOf()).toMatchObject({ AB_GITHUB_CLIENT_ID: 'gh-2' });
      expect(varsOf()).not.toHaveProperty('AB_LOGIN_ALLOW_DOMAINS');
      expect(state.secrets.get('AB_GITHUB_CLIENT_SECRET')).toBe(rotated);
    });

    it('validates with the server parser: a bad value fails before anything is created', async () => {
      const github = { AB_GITHUB_CLIENT_ID: 'c', AB_GITHUB_CLIENT_SECRET: 'x' };
      const cases: [Record<string, string>, RegExp][] = [
        [
          { AB_OIDC_CLIENT_ID: 'c', AB_OIDC_CLIENT_SECRET: 'x', AB_OIDC_ISSUER: 'http://idp.example.test' },
          /AB_OIDC_ISSUER/,
        ],
        [{ AB_GOOGLE_CLIENT_ID: 'c' }, /AB_GOOGLE_CLIENT_SECRET/],
        [{ ...github, AB_LOGIN_AUTO_PROVISION: 'root' }, /AB_LOGIN_AUTO_PROVISION/],
        [{ ...github, AB_LOGIN_ALLOW_EMAILS: 'nope' }, /AB_LOGIN_ALLOW_EMAILS/],
        [{ AB_CF_ACCESS_TEAM: 'team', AB_CF_ACCESS_AUD: 'short' }, /AB_CF_ACCESS_AUD/],
        [{}, /no provider/],
      ];
      for (const [env, message] of cases) {
        const { state, wrangler } = fakeWrangler();
        await expect(setup(options(wrangler, { signIn: true, domain, env }))).rejects.toThrow(message);
        expect(state.databases).toEqual([]);
        expect(state.deploys).toBe(0);
        expect(state.puts).toEqual([]);
      }
      const { wrangler } = fakeWrangler();
      await expect(
        setup(options(wrangler, { signIn: true, publicUrl: 'http://bridge.example.test', env: github })),
      ).rejects.toThrow(/public URL/);
    });

    it('a failed validation never repeats a secret', async () => {
      const { state, wrangler } = fakeWrangler();
      const env = {
        AB_OIDC_CLIENT_ID: 'c',
        AB_OIDC_CLIENT_SECRET: GOOGLE_SECRET,
        AB_OIDC_ISSUER: 'http://idp.example.test',
      };
      const error = await setup(options(wrangler, { signIn: true, domain, env })).catch((e: Error) => e);
      expect((error as Error).message).not.toContain(GOOGLE_SECRET);
      expect(state.calls.join('\n')).not.toContain(GOOGLE_SECRET);
    });

    it('warns like the server: allowlist without auto-provisioning, and auto-provisioning as admin', async () => {
      const github = {
        AB_GITHUB_CLIENT_ID: 'c',
        AB_GITHUB_CLIENT_SECRET: 'x',
        AB_LOGIN_ALLOW_DOMAINS: 'example.test',
      };
      const first = fakeWrangler();
      const lines: string[] = [];
      await setup(options(first.wrangler, { signIn: true, domain, log: (l) => lines.push(l), env: github }));
      expect(lines.join('\n')).toContain('AB_LOGIN_AUTO_PROVISION=off');
      const second = fakeWrangler();
      const adminLines: string[] = [];
      await setup(
        options(second.wrangler, {
          secretsFile: join(dir, 'e.secrets'),
          signIn: true,
          domain,
          log: (l) => adminLines.push(l),
          env: { ...github, AB_LOGIN_AUTO_PROVISION: 'admin' },
        }),
      );
      expect(adminLines.join('\n')).toContain('becomes an administrator');
    });

    it('without a domain the callback URLs use the workers.dev address learnt from the first deploy', async () => {
      const { wrangler } = fakeWrangler();
      const lines: string[] = [];
      await setup(
        options(wrangler, {
          signIn: true,
          log: (l) => lines.push(l),
          env: { AB_GITHUB_CLIENT_ID: 'c', AB_GITHUB_CLIENT_SECRET: 'x' },
        }),
      );
      expect(lines).toContain('  https://agility-bridge-staging.example.workers.dev/auth/callback/github');
    });

    it('Cloudflare Access needs no secret and no callback URL', async () => {
      const { state, wrangler } = fakeWrangler();
      const lines: string[] = [];
      await setup(
        options(wrangler, {
          signIn: true,
          domain,
          log: (l) => lines.push(l),
          env: { AB_CF_ACCESS_TEAM: 'acme', AB_CF_ACCESS_AUD: 'a'.repeat(64) },
        }),
      );
      expect(state.puts.map((p) => p.name)).toEqual(['AB_MASTER_KEY', 'AB_ADMIN_TOKEN']);
      expect(lines.join('\n')).not.toContain('/auth/callback');
    });

    it('a dry run asks nothing and sends nothing', async () => {
      const { state, wrangler } = fakeWrangler();
      const asked: string[] = [];
      await setup(options(wrangler, { dryRun: true, signIn: true, ...terminal({}, asked) }));
      expect(asked).toEqual([]);
      expect(state.calls).toEqual(['whoami', 'd1 list --json']);
    });

    it('without --sign-in the environment is never read', async () => {
      const { state, wrangler } = fakeWrangler();
      await setup(
        options(wrangler, { env: { AB_GITHUB_CLIENT_ID: 'c', AB_GITHUB_CLIENT_SECRET: GOOGLE_SECRET } }),
      );
      expect(state.puts.map((p) => p.name)).toEqual(['AB_MASTER_KEY', 'AB_ADMIN_TOKEN']);
    });
  });
});
