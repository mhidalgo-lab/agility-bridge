// SPDX-License-Identifier: Apache-2.0
// P7-13: a workspace where `update_status` may be called, and a client that cannot elicit, against the throwaway server
// of the browser suites. The synthetic Agility serves no write endpoint, so everything here stops at the recorded
// approval: the page under test is `/admin/approve/<id>`. Nothing real: fake tokens, loopback only.
import { fakeAgilityToken, type TestServer } from './server.ts';

export const WRITE_SLUG = 'writes';
/** The environment a server needs for writes (the server switch; a warning is logged at start). */
export const WRITES_ENV: Readonly<Record<string, string>> = { AB_WRITE_TOOLS: 'on' };

const TOOLS = ['whoami', 'get_work_item', 'update_status'];

async function must(what: string, call: ReturnType<TestServer['api']>): Promise<Record<string, unknown>> {
  const r = await call;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json as Record<string, unknown>;
}

export interface WritesSetup {
  /** The device token of the owner's grant (shown once at creation). */
  readonly deviceToken: string;
  readonly workspaceId: string;
  readonly ownerId: string;
}

/**
 * A call to the admin API as the signed-in person (session cookie plus the CSRF token of `GET /session`, `Origin` and
 * fetch metadata as a browser sends them): the calls only the person themselves may make (their own token).
 */
function asPerson(server: TestServer, cookie: string): TestServer['api'] {
  let csrf: string | undefined;
  return async (method, path, body) => {
    const headers: Record<string, string> = { cookie };
    if (method !== 'GET') {
      if (csrf === undefined) {
        const session = await fetch(`${server.base}/api/admin/v1/session`, { headers });
        csrf = ((await session.json()) as { csrfToken?: string }).csrfToken;
        if (csrf === undefined) throw new Error('GET /session has no CSRF token');
      }
      headers['x-csrf-token'] = csrf;
      headers['origin'] = new URL(server.base).origin;
      headers['sec-fetch-site'] = 'same-origin';
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${server.base}/api/admin/v1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text === '' ? null : JSON.parse(text) };
  };
}

/**
 * Instance, a personal credential for the owner (a shared one never writes), a workspace that allows writes and names
 * `update_status`, a grant for the owner with the same tool and a device token. `cookie` is the owner's session cookie
 * (`name=value`): only the person themselves may store a personal token, use it on a grant and issue its device tokens.
 */
export async function setupWrites(server: TestServer, cookie: string): Promise<WritesSetup> {
  const me = asPerson(server, cookie);
  const users = (await server.api('GET', '/users')).json as { id: string; role: string }[];
  const owner = users.find((u) => u.role === 'owner');
  if (owner === undefined) throw new Error('setupWrites needs the owner to have signed in');
  const instance = await must(
    'instance',
    server.api('POST', '/instances', { label: 'Writes', baseUrl: server.agilityUrl }),
  );
  const shared = await must(
    'shared credential',
    server.api('POST', '/credentials', {
      instanceId: instance['id'],
      ownerUserId: null,
      label: 'Team read-only',
      token: fakeAgilityToken('shared'),
    }),
  );
  await must('validate', server.api('POST', `/credentials/${shared['id']}/validate`));
  const workspace = await must(
    'workspace',
    server.api('POST', '/workspaces', {
      slug: WRITE_SLUG,
      name: 'Writes workspace',
      instanceId: instance['id'],
      allowedScopeIds: ['Scope:1001'],
      enabledTools: TOOLS,
      defaultCredentialId: shared['id'],
      writePolicy: { enabled: true },
    }),
  );
  const grant = await must(
    'grant',
    server.api('POST', '/grants', {
      workspaceId: workspace['id'],
      userId: owner.id,
      label: 'Owner writes',
      tools: ['whoami'],
    }),
  );
  const grantId = (grant['record'] as { id: string }).id;
  const credential = await must(
    'personal credential',
    me('POST', '/credentials', {
      instanceId: instance['id'],
      ownerUserId: owner.id,
      label: 'Owner personal',
      token: fakeAgilityToken('writer'),
    }),
  );
  await must('validate', me('POST', `/credentials/${credential['id']}/validate`));
  await must(
    'use the token',
    me('POST', `/me/grants/${grantId}/credential`, { credentialId: credential['id'] }),
  );
  await must('write tool', server.api('PATCH', `/grants/${grantId}`, { tools: TOOLS }));
  const issued = await must('device token', me('POST', `/grants/${grantId}/tokens`, { label: 'writer' }));
  return {
    deviceToken: issued['token'] as string,
    workspaceId: workspace['id'] as string,
    ownerId: owner.id,
  };
}

const LINK = /\/admin\/approve\/\d{14}-[A-Za-z0-9_-]{22}/;

/**
 * A client without elicitation (a bare HTTP request, no `initialize`) asks for the status change. Returns the path of
 * the approval page the pending answer names. A decline leaves one refusal behind, so the call is repeated until a
 * pending answer appears.
 */
export async function requestApproval(server: TestServer, deviceToken: string): Promise<string> {
  let last = '';
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${server.base}/w/${WRITE_SLUG}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deviceToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'update_status', arguments: { asset: 'B-01001', new_status: 'Done', confirm: true } },
      }),
    });
    last = await res.text();
    const link = LINK.exec(last)?.[0];
    if (link !== undefined) return link;
  }
  throw new Error(`no approval link in the answer: ${last.slice(0, 600)}`);
}
