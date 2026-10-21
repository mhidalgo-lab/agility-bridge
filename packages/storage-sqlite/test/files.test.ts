// SPDX-License-Identifier: Apache-2.0
// The file-backed adapter (P2-02): safe creation, permissions, symbolic links, WAL, backups and restores (L-076,
// THREAT_MODEL T7, T35). Mode and symlink checks run on POSIX only; Windows runs the rest (L-104).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, MigrationError } from '@agility-bridge/storage';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storageContract } from '../../storage/test/contract.ts';
import { openSqliteStorage, restoreSqliteBackup, type SqliteStorage, UnsafeFileError } from '../src/index.ts';

const posix = process.platform !== 'win32';

/** Best effort: Windows may hold a lock on a just-closed file for a moment (L-104). */
function cleanUp(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // temporary directory; the OS cleans it up
  }
}
const mode = (path: string) => statSync(path).mode & 0o777;

let dir: string;
const open: SqliteStorage[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-files-'));
});
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  cleanUp(dir);
});

async function openAt(
  path: string,
  options: { onWarning?: (m: string) => void } = {},
): Promise<SqliteStorage> {
  const s = await openSqliteStorage({ path, ...options });
  open.push(s);
  return s;
}

describe('openSqliteStorage', () => {
  it('creates the directory and the database privately, in WAL mode, migrated', async () => {
    const path = join(dir, 'nested', 'data', 'agility-bridge.db');
    const s = await openAt(path);
    await s.users.create({ id: 'u', email: 'u@example.test', role: 'owner' });
    expect(s.path).toBe(path);
    expect(existsSync(`${path}-wal`)).toBe(true);
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect((db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(
      MIGRATIONS.length,
    );
    db.close();
    if (posix) {
      expect(mode(join(dir, 'nested', 'data'))).toBe(0o700);
      expect(mode(path)).toBe(0o600);
      expect(mode(`${path}-wal`)).toBe(0o600);
      expect(mode(`${path}-shm`)).toBe(0o600);
    }
  });

  it('reopens an existing database with its data', async () => {
    const path = join(dir, 'a.db');
    const first = await openSqliteStorage({ path });
    await first.kv.set('k', 'v');
    await first.close();
    expect(await (await openAt(path)).kv.get('k')).toBe('v');
  });

  it.runIf(posix)('tightens an existing database that others can read to 0600', async () => {
    const path = join(dir, 'loose.db');
    writeFileSync(path, '');
    chmodSync(path, 0o644);
    await openAt(path);
    expect(mode(path)).toBe(0o600);
  });

  it.runIf(posix)('refuses a symbolic link as the database, and does not touch its target', async () => {
    const target = join(dir, 'elsewhere.db');
    writeFileSync(target, '');
    chmodSync(target, 0o644);
    const link = join(dir, 'link.db');
    symlinkSync(target, link);
    await expect(openSqliteStorage({ path: link })).rejects.toThrow(UnsafeFileError);
    await expect(openSqliteStorage({ path: link })).rejects.toThrow(/symbolic link/);
    expect(mode(target)).toBe(0o644);
    expect(statSync(target).size).toBe(0);
  });

  it.runIf(posix)('refuses a dangling symbolic link instead of creating its target', async () => {
    const link = join(dir, 'dangling.db');
    symlinkSync(join(dir, 'created-by-attacker.db'), link);
    await expect(openSqliteStorage({ path: link })).rejects.toThrow(UnsafeFileError);
    expect(existsSync(join(dir, 'created-by-attacker.db'))).toBe(false);
  });

  it('refuses a path that is not a regular file', async () => {
    const path = join(dir, 'a-directory');
    mkdirSync(path);
    await expect(openSqliteStorage({ path })).rejects.toThrow();
  });

  it.runIf(posix)('warns when the data directory is writable by others', async () => {
    const shared = join(dir, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const warnings: string[] = [];
    await openAt(join(shared, 'a.db'), { onWarning: (m) => warnings.push(m) });
    expect(warnings).toEqual([expect.stringContaining('writable by other users')]);
  });

  it('serves two connections to one file (busy timeout, WAL)', async () => {
    const path = join(dir, 'shared.db');
    const a = await openAt(path);
    const b = await openAt(path);
    await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).kv.increment('n')));
    expect(await a.kv.get('n')).toBe('40');
  });
});

describe('backup and restore', () => {
  it('writes a consistent 0600 copy that restores to the data at backup time', async () => {
    const path = join(dir, 'live.db');
    const s = await openAt(path);
    await s.users.create({ id: 'u1', email: 'one@example.test', role: 'owner' });
    const backup = join(dir, 'backups', 'live-1.db');
    await s.backup(backup);
    await s.users.create({ id: 'u2', email: 'two@example.test', role: 'member' });
    if (posix) {
      expect(mode(backup)).toBe(0o600);
      expect(mode(join(dir, 'backups'))).toBe(0o700);
    }
    const restored = join(dir, 'restored', 'live.db');
    await restoreSqliteBackup(backup, restored);
    if (posix) expect(mode(restored)).toBe(0o600);
    const r = await openAt(restored);
    expect((await r.users.list()).map((u) => u.id)).toEqual(['u1']);
    expect((await s.users.list()).map((u) => u.id)).toEqual(['u1', 'u2']);
  });

  it('never overwrites: an existing backup target or restore target is refused', async () => {
    const s = await openAt(join(dir, 'live.db'));
    const backup = join(dir, 'b.db');
    await s.backup(backup);
    await expect(s.backup(backup)).rejects.toThrow(UnsafeFileError);
    const target = join(dir, 'target.db');
    writeFileSync(target, 'keep me');
    await expect(restoreSqliteBackup(backup, target)).rejects.toThrow(UnsafeFileError);
    expect(statSync(target).size).toBe(7);
  });

  it.runIf(posix)('refuses a symbolic link as the backup target', async () => {
    const s = await openAt(join(dir, 'live.db'));
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'x');
    symlinkSync(victim, join(dir, 'b.db'));
    await expect(s.backup(join(dir, 'b.db'))).rejects.toThrow(UnsafeFileError);
    expect(statSync(victim).size).toBe(1);
  });

  it('refuses to restore a damaged file, a foreign database or one from a newer release', async () => {
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, `SQLite format 3${String.fromCodePoint(0)} but not really`.padEnd(4096, 'x'));
    await expect(restoreSqliteBackup(junk, join(dir, 'r1.db'))).rejects.toThrow();
    expect(existsSync(join(dir, 'r1.db'))).toBe(false);

    const foreign = join(dir, 'foreign.db');
    const f = new DatabaseSync(foreign);
    f.exec('CREATE TABLE t (a)');
    f.close();
    await expect(restoreSqliteBackup(foreign, join(dir, 'r2.db'))).rejects.toThrow(
      /not an agility-bridge database/,
    );

    const s = await openAt(join(dir, 'live.db'));
    const newer = join(dir, 'newer.db');
    await s.backup(newer);
    const n = new DatabaseSync(newer);
    n.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
      MIGRATIONS.length + 1,
      'future',
      'x',
      1,
    );
    n.close();
    await expect(restoreSqliteBackup(newer, join(dir, 'r3.db'))).rejects.toThrow(MigrationError);
  });
});

// The whole contract once more on a real file (WAL, a busy timeout, the file checks).
const contractDir = mkdtempSync(join(tmpdir(), 'ab-contract-'));
let n = 0;
afterAll(() => cleanUp(contractDir));
storageContract('sqlite (file)', (clock) =>
  openSqliteStorage({ path: join(contractDir, `c${n++}.db`), now: clock.now }),
);
