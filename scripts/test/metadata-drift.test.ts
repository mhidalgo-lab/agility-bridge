// SPDX-License-Identifier: Apache-2.0
// P1-03: the drift script compares the snapshot with an instance's meta.v1 (here a fake fetch).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { driftAgainst } from '../metadata-drift.ts';

const SNAPSHOT = JSON.parse(
  readFileSync(
    new URL('../../packages/core/test/fixtures/agility/meta-snapshot.json', import.meta.url),
    'utf8',
  ),
) as Record<string, { Attributes: Record<string, Record<string, unknown>> }>;

function fakeFetch(
  change: (type: string, body: (typeof SNAPSHOT)[string]) => unknown = (_t, b) => b,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const type = decodeURIComponent(String(input).split('/meta.v1/')[1] ?? '');
    const body = SNAPSHOT[type];
    if (body === undefined) return new Response('', { status: 404 });
    const changed = change(type, structuredClone(body));
    return changed === undefined
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify(changed), {
          headers: { 'content-type': 'application/json', etag: '"26.2.6.29.1"' },
        });
  }) as typeof fetch;
}

describe('driftAgainst', () => {
  it('finds no drift when the instance matches the snapshot', async () => {
    expect(await driftAgainst('https://agility.example.com/Inst', fakeFetch())).toEqual({
      version: '"26.2.6.29.1"',
      drift: [],
    });
  });

  it('reports changed, missing and removed product attributes and types', async () => {
    const { drift } = await driftAgainst(
      'https://agility.example.com/Inst',
      fakeFetch((type, body) => {
        if (type === 'Goal') return undefined;
        if (type === 'Task') {
          delete body.Attributes['Task.ToDo'];
          (body.Attributes['Task.Parent'] as Record<string, unknown>)['RelatedAsset'] = { nameref: 'Story' };
        }
        return body;
      }),
    );
    expect(drift).toEqual([
      'Task.ToDo: missing',
      'Task.Parent: relation PrimaryWorkitem → Story',
      'Goal: asset type missing',
    ]);
  }, 20_000);
});
