// SPDX-License-Identifier: Apache-2.0
// P0-12: what the read-only tenant offers for live tests, as size buckets per asset type (never exact counts, names or
// content). Agility returns no total on this instance (query.v1 ignores needTotal; rest-1.v1 reports only
// pageSize/pageStart), so a bucket is found by probing one row at offsets 0, 9, 99, 999 and 9,999.
import type { LiveFetch } from './readonly-fetch.ts';

export const ASSET_TYPES = [
  'Scope',
  'Team',
  'Timebox',
  'Member',
  'Story',
  'Defect',
  'Task',
  'Test',
  'Epic',
  'Issue',
  'Request',
  'RegressionTest',
  'RegressionPlan',
  'RegressionSuite',
  'TestSet',
  'Expression',
  'Attachment',
  'Link',
] as const;

export type Bucket = '0' | '1+' | '10+' | '100+' | '1000+' | '10000+' | 'error';
const STEPS: Array<[number, Bucket]> = [
  [0, '1+'],
  [9, '10+'],
  [99, '100+'],
  [999, '1000+'],
  [9999, '10000+'],
];

async function rowAt(
  live: LiveFetch,
  from: string,
  start: number,
  filter?: string[],
): Promise<boolean | 'error'> {
  const res = await live('query.v1', {
    method: 'POST',
    body: { from, select: ['ID'], page: { start, size: 1 }, ...(filter ? { filter } : {}) },
  });
  if (!res.ok) {
    await res.body?.cancel();
    return 'error';
  }
  const body = (await res.json()) as unknown[][];
  return (body[0]?.length ?? 0) > 0;
}

/** The size bucket of one asset type (optionally filtered), with at most five one-row reads. */
export async function bucket(live: LiveFetch, from: string, filter?: string[]): Promise<Bucket> {
  let result: Bucket = '0';
  for (const [offset, label] of STEPS) {
    const hit = await rowAt(live, from, offset, filter);
    if (hit === 'error') return offset === 0 ? 'error' : result;
    if (!hit) break;
    result = label;
  }
  return result;
}

/** Number of custom attributes on an asset type, from meta.v1 (names never returned). */
export async function customAttributeCount(live: LiveFetch, assetType: string): Promise<number | 'error'> {
  const res = await live(`meta.v1/${assetType}`, { accept: 'application/json' });
  if (!res.ok) {
    await res.body?.cancel();
    return 'error';
  }
  const meta = (await res.json()) as { Attributes?: Record<string, unknown> };
  return Object.keys(meta.Attributes ?? {}).filter((k) => /\.Custom_/.test(k) || k.startsWith('Custom_'))
    .length;
}
