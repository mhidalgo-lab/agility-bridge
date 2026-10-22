// SPDX-License-Identifier: Apache-2.0
// Self-hosted → Worker (P3-09, L-078): copies a backup made with `agility-bridge backup` into the Worker's D1, which
// must be empty, on the same schema version and with the same master key (or the server's key as
// AB_MASTER_KEY_PREVIOUS). Explicit and one-way; the SQL file is written 0600 and deleted afterwards.
//   pnpm cf:migrate --name agility-bridge-staging --from ./agility-bridge-backup.db
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS } from '../packages/storage/src/index.ts';
import { configBelongsTo, localConfigPath, NAME_RE, type Wrangler } from './cf-setup.ts';

/** In dependency order. `kv` keeps only the key-check values; everything else in it is transient. */
export const TABLES = [
  'users',
  'instances',
  'credentials',
  'workspaces',
  'grants',
  'access_tokens',
  'settings',
  'audit_log',
  'kv',
] as const;
/**
 * Tables that must be empty on the target (L-078). Not the audit log: an internet-facing Worker records refused probes
 * within minutes of its first deploy (L-181); its rows stay and the server's are added.
 */
const MUST_BE_EMPTY = TABLES.filter((t) => t !== 'kv' && t !== 'audit_log');
const KV_KEPT = "key LIKE 'crypto:%'";

export class MigrationRefused extends Error {
  override name = 'MigrationRefused';
}

/** A SQL literal for a value read from SQLite: NULL, a number, a quoted string, or a blob as X'..'. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

export interface Export {
  readonly statements: string[];
  readonly counts: Record<string, number>;
  readonly schemaVersion: number;
  /** Key-check values by version, for the versions the credentials use. */
  readonly keyChecks: Record<number, string>;
}

/** Reads a backup and returns the INSERTs that recreate it. Refuses what `restore` would refuse. */
export function exportBackup(db: DatabaseSync): Export {
  const ok = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
  if (ok?.integrity_check !== 'ok')
    throw new MigrationRefused('The backup fails the SQLite integrity check.');
  const hasHistory = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (hasHistory === undefined) throw new MigrationRefused('This is not an agility-bridge database.');
  const { v } = db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number };
  const latest = Math.max(...MIGRATIONS.map((m) => m.version));
  if (v > latest)
    throw new MigrationRefused('The backup was written by a newer agility-bridge; upgrade first.');
  if (v < latest) {
    throw new MigrationRefused(
      'The backup is on an older schema: start the server once on this version, then back up.',
    );
  }
  const statements: string[] = [];
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    const where = table === 'kv' ? ` WHERE ${KV_KEPT}` : '';
    const rows = db.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM "${table}"${where}`);
    rows.setReturnArrays(true);
    let n = 0;
    for (const row of rows.all() as unknown as unknown[][]) {
      statements.push(
        `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${row.map(sqlLiteral).join(', ')})`,
      );
      n++;
    }
    counts[table] = n;
  }
  const versions = (
    db.prepare('SELECT DISTINCT key_version AS v FROM credentials').all() as { v: number }[]
  ).map((r) => r.v);
  const keyChecks: Record<number, string> = {};
  for (const version of versions) {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(`crypto:kcv:v${version}`) as
      | { value: string }
      | undefined;
    if (row === undefined)
      throw new MigrationRefused(`The backup has no key-check value for key version ${version}.`);
    keyChecks[version] = row.value;
  }
  return { statements, counts, schemaVersion: v, keyChecks };
}

/** The target's state as the checks need it. */
export interface TargetState {
  readonly schemaVersion: number | null;
  readonly rows: number;
  readonly keyChecks: Record<number, string>;
}

/** Everything that must hold before writing (L-078). */
export function checkTarget(source: Export, target: TargetState): void {
  if (target.schemaVersion === null) {
    throw new MigrationRefused(
      'The target database is not migrated: deploy the Worker and open /health once.',
    );
  }
  if (target.schemaVersion !== source.schemaVersion) {
    throw new MigrationRefused(
      `The target is on schema ${target.schemaVersion}, the backup on ${source.schemaVersion}; use the same release.`,
    );
  }
  if (target.rows > 0)
    throw new MigrationRefused('The target deployment is not empty; migrations only go into an empty one.');
  for (const [version, kcv] of Object.entries(source.keyChecks)) {
    if (target.keyChecks[Number(version)] !== kcv) {
      throw new MigrationRefused(
        `The Worker does not run with the server's master key version ${version}: set it as AB_MASTER_KEY (or ` +
          'AB_MASTER_KEY_PREVIOUS next to a new key) and open /health once.',
      );
    }
  }
}

/** Statements to insert, minus the key-check values the target already holds (same key, same value). */
export function statementsFor(source: Export, target: TargetState): string[] {
  return source.statements.filter((s) => {
    const m = /^INSERT INTO "kv" \("key", .*VALUES \('crypto:kcv:v(\d+)'/.exec(s);
    return m === null || target.keyChecks[Number(m[1])] === undefined;
  });
}

export const STATE_SQL = [
  'SELECT max(version) AS v FROM schema_migrations',
  `SELECT ${MUST_BE_EMPTY.map((t) => `(SELECT count(*) FROM "${t}")`).join(' + ')} AS n`,
  "SELECT key, value FROM kv WHERE key LIKE 'crypto:kcv:v%'",
];

/** Reads the target through `wrangler d1 execute --json`. */
export function readTarget(wrangler: Wrangler, name: string, config: string): TargetState {
  const query = (sql: string) => {
    const r = wrangler(['d1', 'execute', name, '--remote', '--json', '--config', config, '--command', sql]);
    if (r.code !== 0) return null;
    return (JSON.parse(r.stdout) as { results: Record<string, unknown>[] }[])[0]?.results ?? [];
  };
  const version = query(STATE_SQL[0] as string);
  if (version === null) return { schemaVersion: null, rows: 0, keyChecks: {} };
  // Once the schema is there, a failed count or key-check query is an error, never "empty" (P3-11 review).
  const count = query(STATE_SQL[1] as string);
  const checks = query(STATE_SQL[2] as string);
  if (count === null || checks === null || count[0]?.['n'] === undefined) {
    throw new MigrationRefused('Could not read the target database; nothing was written. Try again.');
  }
  const rows = Number(count[0]['n']);
  const keyChecks: Record<number, string> = {};
  for (const r of checks) {
    keyChecks[Number(String(r['key']).slice('crypto:kcv:v'.length))] = String(r['value']);
  }
  return { schemaVersion: Number(version[0]?.['v'] ?? 0) || null, rows, keyChecks };
}

export async function migrate(options: {
  readonly name: string;
  readonly from: string;
  readonly workerDir: string;
  readonly wrangler: Wrangler;
  readonly log: (line: string) => void;
}): Promise<Record<string, number>> {
  if (!NAME_RE.test(options.name) || options.name.length > 54) {
    throw new MigrationRefused('--name must be agility-bridge or agility-bridge-<suffix> (lower case).');
  }
  const config = localConfigPath(options.workerDir, options.name);
  let configText: string;
  try {
    configText = readFileSync(config, 'utf8');
  } catch {
    throw new MigrationRefused(`${config} is missing: run pnpm cf:setup --name ${options.name} first.`);
  }
  if (!configBelongsTo(configText, options.name)) {
    throw new MigrationRefused(`${config} belongs to another deployment; refusing to mix them (T34).`);
  }
  const db = new DatabaseSync(options.from, { readOnly: true });
  let source: Export;
  try {
    source = exportBackup(db);
  } finally {
    db.close();
  }
  const target = readTarget(options.wrangler, options.name, config);
  checkTarget(source, target);
  const dir = mkdtempSync(join(tmpdir(), 'ab-cf-migrate-'));
  const file = join(dir, 'migration.sql');
  try {
    writeFileSync(file, `${statementsFor(source, target).join(';\n')};\n`, {
      mode: 0o600,
    });
    options.log(
      `import ${Object.entries(source.counts)
        .map(([t, n]) => `${t} ${n}`)
        .join(', ')}`,
    );
    const r = options.wrangler([
      'd1',
      'execute',
      options.name,
      '--remote',
      '--config',
      config,
      '--file',
      file,
    ]);
    if (r.code !== 0)
      throw new MigrationRefused(`wrangler d1 execute failed: ${r.stderr.trim().slice(0, 300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const after = readTarget(options.wrangler, options.name, config);
  const expected = MUST_BE_EMPTY.reduce((sum, t) => sum + (source.counts[t] ?? 0), 0);
  if (after.rows !== expected)
    throw new MigrationRefused(`Imported ${after.rows} rows, expected ${expected}.`);
  return source.counts;
}

function arg(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const name = arg(argv, '--name');
  const from = arg(argv, '--from');
  if (name === undefined || from === undefined) {
    console.error('usage: pnpm cf:migrate --name <worker> --from <backup.db>');
    process.exit(2);
  }
  const workerDir = fileURLToPath(new URL('../apps/worker/', import.meta.url));
  const bin = join(workerDir, 'node_modules', '.bin', 'wrangler');
  migrate({
    name,
    from,
    workerDir,
    wrangler: (args, o = {}) => {
      const r = spawnSync(bin, args, { cwd: o.cwd ?? workerDir, input: o.input ?? '', encoding: 'utf8' });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    log: (line) => console.error(line),
  })
    .then((counts) => console.error(`done: ${JSON.stringify(counts)}`))
    .catch((error: unknown) => {
      console.error(`✗ ${(error as Error).message}`);
      process.exit(1);
    });
}
