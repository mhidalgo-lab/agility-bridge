// SPDX-License-Identifier: Apache-2.0
// P1-03 drift check (L-053): compares the committed synthetic metadata snapshot with an instance's meta.v1 on product
// attributes (names, types, multi-value, relation targets, bases). Defaults to Digital.ai's public example instance,
// whose meta.v1 is public and needs no token; prints product names only. Exit 1 on drift.
// Run: node scripts/metadata-drift.ts [--instance https://www14.v1host.com/v1sdktesting]
import { readFileSync } from 'node:fs';
import { canonicalInstanceUrl, metadataDrift, parseAssetType } from '../packages/core/src/index.ts';

export const PUBLIC_INSTANCE = 'https://www14.v1host.com/v1sdktesting';
const SNAPSHOT_FILE = new URL('../packages/core/test/fixtures/agility/meta-snapshot.json', import.meta.url);

export async function driftAgainst(
  instance: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ version: string; drift: string[] }> {
  const base = canonicalInstanceUrl(instance);
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) as Record<string, unknown>;
  const drift: string[] = [];
  let version = '';
  for (const [type, body] of Object.entries(snapshot)) {
    // Synthetic custom types exist only in the fixture.
    if (type.startsWith('Custom_')) continue;
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetchImpl(`${base}/meta.v1/${encodeURIComponent(type)}`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    if (res.status === 404) {
      drift.push(`${type}: asset type missing`);
      continue;
    }
    if (!res.ok) throw new Error(`meta.v1/${type} answered HTTP ${res.status}`);
    version ||= res.headers.get('etag') ?? '';
    drift.push(...metadataDrift(parseAssetType(body), parseAssetType(await res.json())));
  }
  return { version, drift };
}

if (import.meta.main) {
  const i = process.argv.indexOf('--instance');
  const instance = i === -1 ? PUBLIC_INSTANCE : (process.argv[i + 1] ?? '');
  const { version, drift } = await driftAgainst(instance);
  console.error(
    `metadata drift against ${instance === PUBLIC_INSTANCE ? 'the public example instance' : 'the given instance'} (${version || 'no ETag'}):`,
  );
  console.error(drift.length === 0 ? 'none' : drift.map((d) => `  ${d}`).join('\n'));
  process.exitCode = drift.length === 0 ? 0 : 1;
}
