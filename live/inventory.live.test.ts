// SPDX-License-Identifier: Apache-2.0
// P0-12 live suite: validates the token and records the tenant inventory as size buckets. Read-only (every request goes
// through readOnlyFetch), prints nothing from the tenant, and writes the buckets only to the git-ignored live/results/.
// Skips without a live target.
// Run: pnpm test:live   (CI: the `live` workflow, environment `live`)
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { liveTarget } from './env.ts';
import { ASSET_TYPES, bucket, customAttributeCount } from './inventory.ts';
import { readOnlyFetch } from './readonly-fetch.ts';

const target = liveTarget();

describe.skipIf(!target)('live tenant (read-only)', () => {
  const live = target ? readOnlyFetch(target) : (undefined as never);

  it('accepts the access token on query.v1', async () => {
    const res = await live('query.v1', {
      method: 'POST',
      body: { from: 'Member', select: ['ID'], where: { IsSelf: 'true' } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[][];
    expect(body[0]).toHaveLength(1);
  });

  it('records the inventory as size buckets', { timeout: 300_000 }, async () => {
    const types: Record<string, string> = {};
    for (const t of ASSET_TYPES) types[t] = await bucket(live, t);
    const extra: Record<string, string> = {
      'Scope with a parent': await bucket(live, 'Scope', ['Parent!=""']),
      'Epic categories (distinct)': await bucket(live, 'EpicCategory'),
    };
    const custom: Record<string, number | string> = {};
    for (const t of ['Story', 'Defect', 'Task', 'Test', 'Epic'])
      custom[t] = await customAttributeCount(live, t);
    const report = { date: new Date().toISOString().slice(0, 10), types, extra, customAttributes: custom };
    mkdirSync('live/results', { recursive: true });
    writeFileSync('live/results/inventory.json', `${JSON.stringify(report, null, 2)}\n`);
    expect(Object.values(types)).not.toContain('error');
  });
});
