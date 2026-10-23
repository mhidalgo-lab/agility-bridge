// SPDX-License-Identifier: Apache-2.0
// The admin panel's asset generator (P4-03): hashed names, SRI values that match the bytes, and `--check` drift detection.
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAsset, generate, isCurrent, SOURCES } from '../gen-admin-assets.ts';

const ASSETS = fileURLToPath(new URL('../../packages/admin-ui/assets/', import.meta.url));
const GENERATED = fileURLToPath(new URL('../../packages/admin-ui/src/assets.generated.ts', import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const copyOfAssets = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-assets-'));
  dirs.push(dir);
  cpSync(ASSETS, dir, { recursive: true });
  return dir;
};

describe('buildAsset', () => {
  it('names the file by a content hash and computes SHA-384 integrity of exactly the body', () => {
    const a = buildAsset('admin.css', 'text/css; charset=utf-8', 'body{}');
    expect(a.file).toMatch(/^admin\.[0-9a-f]{16}\.css$/);
    expect(a.file).toBe(`admin.${createHash('sha256').update('body{}').digest('hex').slice(0, 16)}.css`);
    expect(a.integrity).toBe(`sha384-${createHash('sha384').update('body{}').digest('base64')}`);
    expect(buildAsset('admin.css', 'text/css', 'body{ }').file).not.toBe(a.file);
  });
});

describe('--check', () => {
  it('accepts the committed generated module', () => {
    expect(isCurrent(readFileSync(GENERATED, 'utf8'))).toBe(true);
    expect(Object.keys(SOURCES).sort()).toEqual(['css', 'js']);
  });

  it('detects a changed stylesheet, a changed script and a hand-edited generated file', () => {
    const committed = readFileSync(GENERATED, 'utf8');
    for (const name of ['admin.css', 'admin.js']) {
      const dir = copyOfAssets();
      expect(isCurrent(committed, dir)).toBe(true);
      writeFileSync(join(dir, name), `${readFileSync(join(dir, name), 'utf8')}\n/* drift */\n`);
      expect(isCurrent(committed, dir), name).toBe(false);
    }
    // Someone edits the generated body or its integrity by hand.
    expect(isCurrent(committed.replace('sha384-', 'sha384-A'))).toBe(false);
    expect(isCurrent(committed.replace('border-radius', 'border-radius '))).toBe(false);
    expect(isCurrent('')).toBe(false);
  });

  it('regenerates deterministically', () => {
    expect(generate()).toBe(generate());
  });
});
