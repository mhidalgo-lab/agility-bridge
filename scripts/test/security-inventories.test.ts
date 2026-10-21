// SPDX-License-Identifier: Apache-2.0
// The security inventories stay living documents (P2-15, L-120, L-010): every key purpose, log message, audit column
// and stored person-related column appears in them, and every link to code or tests resolves.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KeyPurpose } from '../../packages/auth/src/index.ts';
import { schema } from '../../packages/storage/src/index.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCS = ['cryptography', 'logging', 'data-protection'].map((n) =>
  join(ROOT, 'docs/security', `${n}.md`),
);
const read = (path: string) => readFileSync(path, 'utf8');

/** Column property names of a Drizzle table (`createdAt`, …). */
function columns(table: object): string[] {
  return Object.entries(table)
    .filter(
      ([, v]) =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as { name?: unknown }).name === 'string' &&
        'columnType' in v,
    )
    .map(([k]) => k);
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return entry === 'node_modules' || entry === 'dist' ? [] : sources(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('security inventories', () => {
  it('cryptography.md names every key purpose', () => {
    const doc = read(DOCS[0] as string);
    for (const purpose of Object.values(KeyPurpose)) expect(doc, purpose).toContain(`\`${purpose}\``);
  });

  it('logging.md lists every fixed log message of the code and every audit column', () => {
    const doc = read(DOCS[1] as string);
    const dirs = [
      'packages/core/src',
      'packages/auth/src',
      'packages/http-app/src',
      'packages/storage-sqlite/src',
      'apps/cli/src',
    ];
    const messages = new Set<string>();
    for (const file of dirs.flatMap((d) => sources(join(ROOT, d)))) {
      for (const m of read(file).matchAll(/\.(?:debug|info|warn|error)\(\s*'([^']{3,120})'/g))
        messages.add(m[1] as string);
    }
    expect(messages.size).toBeGreaterThan(15);
    for (const message of messages) expect(doc, message).toContain(`\`${message}\``);
    for (const column of columns(schema.auditLog)) expect(doc, column).toMatch(new RegExp(`\`${column}\``));
  });

  it('data-protection.md lists every column of the tables that hold personal data', () => {
    const doc = read(DOCS[2] as string);
    for (const table of [schema.users, schema.credentials, schema.accessTokens]) {
      for (const column of columns(table)) expect(doc, column).toContain(`\`${column}\``);
    }
  });

  it('every relative link in the inventories resolves', () => {
    for (const doc of DOCS) {
      for (const m of read(doc).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = m[1] as string;
        if (/^https?:/.test(target)) continue;
        expect(existsSync(resolve(dirname(doc), target)), `${doc}: ${target}`).toBe(true);
      }
    }
  });
});
