// SPDX-License-Identifier: Apache-2.0
// A stand-in for the consent screen (P5-04) that the OAuth suites share on every host: it approves what the test
// asks for in the `x-test-approve` header (`<user id>|<access grant id>`, or `deny`) and reports a refused approval as
// `403 {"refused": reason}`. Test code only; no host ships it.
import type { OAuthConsentHandler } from '../../src/index.ts';

export const APPROVE_HEADER = 'x-test-approve';

export const testConsent: OAuthConsentHandler = async (c, api) => {
  const who = c.req.header(APPROVE_HEADER);
  if (who === undefined || who === 'deny') {
    return new Response(null, { status: 302, headers: { location: api.deny() } });
  }
  const [userId, grantId] = who.split('|') as [string, string];
  const result = await api.approve({ userId, grantId });
  if (!result.ok) {
    return new Response(JSON.stringify({ refused: result.reason }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(null, { status: 302, headers: { location: result.redirectTo } });
};
