// SPDX-License-Identifier: Apache-2.0
// P0-12: one read-only probe that validates the token. Prints the HTTP status, the number of rows and the response
// shape only. Usage: node live/probe-token.ts
import { liveTarget } from './env.ts';
import { readOnlyFetch } from './readonly-fetch.ts';
import { shape } from './shape.ts';

const target = liveTarget();
if (!target) {
  console.error('no live target configured (AB_LIVE_AGILITY_URL / AB_LIVE_AGILITY_TOKEN or live.env)');
  process.exit(2);
}
const live = readOnlyFetch(target);
const res = await live('query.v1', {
  method: 'POST',
  body: { from: 'Member', select: ['Name', 'IsSelf'], where: { IsSelf: 'true' } },
});
const body: unknown = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
const rows = Array.isArray(body) && Array.isArray(body[0]) ? body[0].length : undefined;
console.log(
  JSON.stringify({
    status: res.status,
    contentType: res.headers.get('content-type'),
    rows,
    shape: shape(body),
  }),
);
