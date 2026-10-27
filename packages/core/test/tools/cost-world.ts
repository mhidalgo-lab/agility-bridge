// SPDX-License-Identifier: Apache-2.0
// The shared world plus comments, attachments, links, a version history and the content endpoint: what the worst-case
// fixtures (worst-case.ts) need to run every tool, used by the cost test and the consistency test.
import { FakeAgility, type FakeAgilityOptions } from '../harness/index.ts';
import { history, SNAPSHOT, world } from './reports-world.ts';

const version = (oid: string, moment: number, at: string, attrs: Record<string, unknown>) => ({
  _type: 'Asset',
  href: `/SyntheticInstance/rest-1.v1/Data/${oid.replace(':', '/')}/${moment}`,
  id: `${oid}:${moment}`,
  Attributes: Object.fromEntries(
    Object.entries({ ChangeDateUTC: at, ...attrs }).map(([name, value]) => [
      name,
      { _type: 'Attribute', name, value },
    ]),
  ),
});

/** The shared world plus comments, attachments and a version history, with the content endpoint served. */
export function costFakeOptions(): FakeAgilityOptions {
  const base = world();
  return {
    meta: SNAPSHOT,
    assets: {
      ...base,
      Expression: [
        {
          _oid: 'Expression:1',
          Mentions: ['Story:1001'],
          'Mentions:Workitem.Scope': ['Scope:1001'],
          Author: 'Member:20',
          'Author.Name': 'Ann Example',
          AuthoredAt: '2026-10-01T09:00:00Z',
          Content: '<p>First</p>',
          BelongsTo: 'Conversation:7',
          AssetState: 64,
        },
      ],
      Attachment: [
        {
          _oid: 'Attachment:1',
          Asset: 'Story:1001',
          'Asset:Workitem.Scope': 'Scope:1001',
          Name: 'notes.txt',
          Filename: 'notes.txt',
          ContentType: 'text/plain; charset=utf-8',
          Description: 'Notes',
          CreatedBy: 'Member:20',
          'CreatedBy.Name': 'Ann Example',
          CreateDateUTC: '2026-10-01T10:00:00.0000000Z',
          AssetState: 64,
        },
      ],
      Link: [
        {
          _oid: 'Link:1',
          Name: 'Spec',
          URL: 'https://example.com/spec',
          Asset: 'Story:1001',
          'Asset:Workitem.Scope': 'Scope:1001',
          AssetState: 64,
        },
      ],
    },
    history: history() as NonNullable<FakeAgilityOptions['history']>,
    override: (_req, call) => {
      if (call.path.startsWith('attachments.img/'))
        return new Response('Hello', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      if (call.path.startsWith('rest-1.v1/Hist/')) {
        const versions = [
          version('Story:1001', 5001, '2026-10-01T09:00:00.000Z', { Name: 'Sign in', Estimate: null }),
          version('Story:1001', 5002, '2026-10-20T10:00:00.000Z', { Name: 'Sign in', Estimate: 3 }),
        ];
        return new Response(
          JSON.stringify({ _type: 'History', pageSize: 2147483647, pageStart: 0, Assets: versions }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return undefined;
    },
  };
}

/** `costFakeOptions` as a ready Agility fake. */
export const costRig = (): FakeAgility => new FakeAgility(costFakeOptions());
