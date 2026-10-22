// SPDX-License-Identifier: Apache-2.0
// One idempotent command per Cloudflare deployment (P3-05, L-100, THREAT_MODEL T34): the D1 database, an ignored local
// wrangler config with its id, the deploy, the missing secrets (through stdin), and a health check. Everything is named
// after --name, so staging and production never share a resource. wrangler must be logged in (`wrangler login`); no
// Cloudflare token is read here.
//   pnpm cf:setup --name agility-bridge-staging --secrets-file ~/.config/agility-bridge/staging.secrets [--plan free]
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAdminToken, generateMasterKey } from '../packages/auth/src/index.ts';

const WORKER_DIR = fileURLToPath(new URL('../apps/worker/', import.meta.url));
export const NAME_RE = /^agility-bridge(?:-[a-z0-9]+)*$/;

/** Whether a local config text belongs to deployment `name` (worker and database named after it, T34). */
export function configBelongsTo(text: string, name: string): boolean {
  const config = readJsonc(text);
  const db = ((config['d1_databases'] as Record<string, unknown>[] | undefined) ?? []).find(
    (d) => d['binding'] === 'DB',
  );
  return config['name'] === name && (db === undefined || db['database_name'] === name);
}
const SECRETS = ['AB_MASTER_KEY', 'AB_ADMIN_TOKEN'] as const;

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
/** Runs wrangler with arguments (and stdin); tests pass a fake. */
export type Wrangler = (args: readonly string[], options?: { input?: string; cwd?: string }) => RunResult;

export interface SetupOptions {
  readonly name: string;
  readonly plan: 'free' | 'paid';
  readonly secretsFile?: string | undefined;
  readonly showSecrets: boolean;
  readonly dryRun: boolean;
  /** `AB_PUBLIC_URL`; default: the deployment's workers.dev address, learnt from the first deploy. */
  readonly publicUrl?: string;
  /** A Workers custom domain (P3-07): the only address; `AB_PUBLIC_URL` becomes `https://<domain>`. */
  readonly domain?: string;
  /** Where the worker app lives (the committed wrangler.jsonc and the local configs). */
  readonly workerDir: string;
  readonly wrangler: Wrangler;
  readonly fetchHealth: (url: string) => Promise<number>;
  readonly log: (line: string) => void;
}

export class SetupError extends Error {
  override name = 'SetupError';
}

/** The committed config without comments (JSONC → JSON). */
export function readJsonc(text: string): Record<string, unknown> {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

/** The file's text, or undefined when it does not exist (one read: no check-then-use race). */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function localConfigPath(workerDir: string, name: string): string {
  return join(workerDir, `wrangler.${name}.local.jsonc`);
}

function must(result: RunResult, what: string): string {
  if (result.code !== 0) throw new SetupError(`${what} failed: ${result.stderr.trim().slice(0, 400)}`);
  return result.stdout;
}

/** The deployment's local config: the committed one, named after --name, with its database id and plan. */
export function localConfig(
  base: Record<string, unknown>,
  name: string,
  databaseId: string,
  plan: string,
  publicUrl?: string,
  domain?: string,
) {
  const d1 = (base['d1_databases'] as Record<string, unknown>[] | undefined) ?? [];
  return {
    ...base,
    $schema: 'node_modules/wrangler/config-schema.json',
    name,
    main: 'src/index.ts',
    // With a custom domain it is the only address (one host for the Host allowlist, T24).
    workers_dev: domain === undefined,
    ...(domain === undefined ? {} : { routes: [{ pattern: domain, custom_domain: true }] }),
    // Variables set in the dashboard survive a deploy.
    keep_vars: true,
    vars: {
      ...((base['vars'] as Record<string, string> | undefined) ?? {}),
      AB_PLAN: plan,
      // Only production issues ab_live_ tokens; every other deployment's tokens are recognisably ab_test_ (T34).
      AB_ENVIRONMENT: name === 'agility-bridge' ? 'production' : 'test',
      // The server answers only its public host (DNS rebinding, T24): without it, workers.dev gets 403.
      ...(publicUrl === undefined ? {} : { AB_PUBLIC_URL: publicUrl }),
    },
    d1_databases: d1.map((d) =>
      d['binding'] === 'DB' ? { ...d, database_name: name, database_id: databaseId } : d,
    ),
  };
}

export async function setup(o: SetupOptions): Promise<{ created: string[]; url: string | null }> {
  if (
    o.domain !== undefined &&
    !/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(o.domain)
  ) {
    throw new SetupError('--domain must be a lower-case host name, e.g. mcp.example.com.');
  }
  if (o.domain !== undefined && o.publicUrl !== undefined && o.publicUrl !== `https://${o.domain}`) {
    throw new SetupError(
      '--public-url and --domain disagree; with --domain the public URL is https://<domain>.',
    );
  }
  if (!NAME_RE.test(o.name) || o.name.length > 54) {
    throw new SetupError(
      '--name must be agility-bridge or agility-bridge-<suffix> (lower case, at most 54 characters).',
    );
  }
  const created: string[] = [];
  const configPath = localConfigPath(o.workerDir, o.name);
  // A local config of another deployment is never reused (T34).
  const existingText = readIfPresent(configPath);
  if (existingText !== undefined) {
    const existing = readJsonc(existingText);
    const db = ((existing['d1_databases'] as Record<string, unknown>[] | undefined) ?? []).find(
      (d) => d['binding'] === 'DB',
    );
    if (existing['name'] !== o.name || (db !== undefined && db['database_name'] !== o.name)) {
      throw new SetupError(`${configPath} belongs to another deployment; refusing to mix them.`);
    }
  }
  if (o.secretsFile !== undefined && existsSync(o.secretsFile)) {
    throw new SetupError(
      `${o.secretsFile} already exists; choose a new file (secrets are never overwritten).`,
    );
  }
  must(o.wrangler(['whoami']), 'wrangler whoami (run `wrangler login`)');

  // D1 database of the same name.
  const list = (): { name: string; uuid: string }[] =>
    JSON.parse(must(o.wrangler(['d1', 'list', '--json']), 'wrangler d1 list')) as {
      name: string;
      uuid: string;
    }[];
  let database = list().find((d) => d.name === o.name);
  if (database === undefined) {
    o.log(`create D1 database ${o.name}`);
    if (!o.dryRun) {
      // From an empty directory: wrangler must not edit the committed config.
      const scratch = mkdtempSync(join(tmpdir(), 'ab-cf-setup-'));
      try {
        must(o.wrangler(['d1', 'create', o.name], { cwd: scratch }), 'wrangler d1 create');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      database = list().find((d) => d.name === o.name);
      if (database === undefined)
        throw new SetupError(`D1 database ${o.name} was not found after creating it.`);
      created.push('database');
    }
  }
  const base = readJsonc(readFileSync(join(o.workerDir, 'wrangler.jsonc'), 'utf8'));
  const previous =
    existingText === undefined
      ? undefined
      : (readJsonc(existingText)['vars'] as Record<string, string> | undefined)?.['AB_PUBLIC_URL'];
  /** Writes the local config when it changed; true when it did. */
  const writeConfig = (publicUrl: string | undefined): boolean => {
    const config = localConfig(base, o.name, database?.uuid ?? 'dry-run', o.plan, publicUrl, o.domain);
    const text = `// Generated by scripts/cf-setup.ts for ${o.name}; ignored by git (it holds the D1 database id).\n${JSON.stringify(config, null, 2)}\n`;
    if (readIfPresent(configPath) === text) return false;
    o.log(`write ${configPath}`);
    if (!o.dryRun) writeFileSync(configPath, text, { mode: 0o600 });
    return true;
  };
  let publicUrl = o.domain === undefined ? (o.publicUrl ?? previous) : `https://${o.domain}`;
  writeConfig(publicUrl);

  o.log(`deploy ${o.name}`);
  if (o.dryRun) return { created, url: null };
  const deploy = () => must(o.wrangler(['deploy', '--config', configPath]), 'wrangler deploy');
  const deployed = deploy();
  let url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deployed)?.[0] ?? null;
  if (publicUrl === undefined && url !== null && writeConfig(url)) {
    // First deploy: now the workers.dev address is known.
    publicUrl = url;
    o.log(`deploy ${o.name} with AB_PUBLIC_URL=${url}`);
    deploy();
  }
  url = publicUrl ?? url;

  // Only the missing secrets, through stdin (never arguments or vars).
  const present = new Set(
    (
      JSON.parse(
        must(
          o.wrangler(['secret', 'list', '--config', configPath, '--format', 'json']),
          'wrangler secret list',
        ),
      ) as {
        name: string;
      }[]
    ).map((s) => s.name),
  );
  const missing = SECRETS.filter((s) => !present.has(s));
  if (missing.length > 0) {
    if (o.secretsFile === undefined && !o.showSecrets) {
      throw new SetupError(
        `${missing.join(', ')} must be generated: pass --secrets-file <new file> (and/or --show-secrets) to keep them.`,
      );
    }
    // The file exists (0600, exclusive) before any secret is generated.
    const fd =
      o.secretsFile === undefined
        ? undefined
        : openSync(resolve(o.secretsFile), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      for (const secret of missing) {
        const value = secret === 'AB_MASTER_KEY' ? generateMasterKey(1) : generateAdminToken();
        // Kept (and on disk) before Cloudflare has it: a secret only Cloudflare holds can never be read back, and a
        // rerun would see it as present (P3-11 review).
        if (fd !== undefined) {
          writeSync(fd, `${secret}=${value}\n`);
          fsyncSync(fd);
        }
        if (o.showSecrets) o.log(`${secret}=${value}`);
        must(
          o.wrangler(['secret', 'put', secret, '--config', configPath], { input: value }),
          `wrangler secret put ${secret}`,
        );
        created.push(secret);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  if (url !== null) {
    const status = await o.fetchHealth(`${url}/health`);
    if (status !== 200) throw new SetupError(`${url}/health answered ${status}.`);
    o.log(`${url}/health: ok`);
  }
  return { created, url };
}

function arg(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const plan = arg(argv, '--plan') ?? 'free';
  const name = arg(argv, '--name');
  if (name === undefined || (plan !== 'free' && plan !== 'paid')) {
    console.error(
      'usage: pnpm cf:setup --name <worker> [--plan free|paid] [--domain <host> | --public-url <origin>] [--secrets-file <new file>] [--show-secrets] [--dry-run]',
    );
    process.exit(2);
  }
  const bin = join(WORKER_DIR, 'node_modules', '.bin', 'wrangler');
  setup({
    name,
    plan,
    ...(arg(argv, '--secrets-file') === undefined
      ? {}
      : { secretsFile: arg(argv, '--secrets-file') as string }),
    showSecrets: argv.includes('--show-secrets'),
    ...(arg(argv, '--public-url') === undefined ? {} : { publicUrl: arg(argv, '--public-url') as string }),
    ...(arg(argv, '--domain') === undefined ? {} : { domain: arg(argv, '--domain') as string }),
    dryRun: argv.includes('--dry-run'),
    workerDir: WORKER_DIR,
    wrangler: (args, options = {}) => {
      const r = spawnSync(bin, args, {
        cwd: options.cwd ?? WORKER_DIR,
        input: options.input ?? '',
        encoding: 'utf8',
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    fetchHealth: async (url) => {
      for (let i = 0; i < 10; i++) {
        const res = await fetch(url).catch(() => null);
        if (res?.status === 200) return 200;
        await new Promise((r) => setTimeout(r, 2_000));
      }
      return (await fetch(url).catch(() => null))?.status ?? 0;
    },
    log: (line) => console.error(line),
  })
    .then((r) =>
      console.error(
        `done: ${r.created.length === 0 ? 'nothing created' : `created ${r.created.join(', ')}`}`,
      ),
    )
    .catch((error: unknown) => {
      console.error(`✗ ${(error as Error).message}`);
      process.exit(1);
    });
}
