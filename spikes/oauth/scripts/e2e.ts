// SPDX-License-Identifier: Apache-2.0
// P0-08 end-to-end OAuth client against the spike: discovery → DCR → PKCE authorize → token → MCP call →
// cross-workspace rejection → refresh (incl. parallel refreshes) → revocation, plus negative checks and a storage
// test (a workspace added at runtime must work on every following request, whichever isolate serves it).
// Usage: SPIKE_ADMIN=<secret> node scripts/e2e.ts [baseUrl]
import { createHash, randomBytes } from 'node:crypto';

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const BASE = process.argv[2] ?? 'http://127.0.0.1:8797';
const ADMIN = process.env['SPIKE_ADMIN'] ?? '';
const REDIRECT = 'http://127.0.0.1:53682/callback';
let failures = 0;
const notes: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64u(randomBytes(32));
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) };
}

const form = (url: string, body: Record<string, string>): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });

async function readMcp(res: Response): Promise<unknown> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    return data.length ? JSON.parse(data[data.length - 1] as string) : null;
  }
  return text ? JSON.parse(text) : null;
}

function mcpCall(
  slug: string,
  token: string | undefined,
  method: string,
  params: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  };
  if (token) headers['authorization'] = `Bearer ${token}`;
  return fetch(`${BASE}/w/${slug}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

interface AsMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
  client_id_metadata_document_supported?: boolean;
  protected_resources?: string[];
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  resource?: string;
  iss: string | null;
}

async function authorizeAndToken(as: AsMeta, clientId: string, resource: string): Promise<Tokens> {
  const { verifier, challenge } = pkce();
  const state = b64u(randomBytes(8));
  const u = new URL(as.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'mcp:read offline_access',
    resource,
  }).toString();
  const res = await fetch(u, { redirect: 'manual' });
  const loc = new URL(res.headers.get('location') ?? 'http://invalid/');
  if (loc.searchParams.get('state') !== state) throw new Error(`state mismatch (status ${res.status})`);
  const code = loc.searchParams.get('code');
  if (!code) throw new Error(`no code: ${loc.search}`);
  const tok = await form(as.token_endpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource,
  });
  const json = (await tok.json()) as Omit<Tokens, 'iss'>;
  if (!tok.ok) throw new Error(`token failed: ${JSON.stringify(json)}`);
  return { ...json, iss: loc.searchParams.get('iss') };
}

const refresh = (as: AsMeta, clientId: string, token: string, extra: Record<string, string> = {}) =>
  form(as.token_endpoint, {
    grant_type: 'refresh_token',
    refresh_token: token,
    client_id: clientId,
    ...extra,
  });

async function main(): Promise<void> {
  const resTeam = `${BASE}/w/team/mcp`;
  const resOps = `${BASE}/w/ops/mcp`;

  // 1. Unauthenticated → 401 challenge naming the per-workspace PRM (RFC 9728 §5.1).
  const unauth = await mcpCall('team', undefined, 'tools/list', {});
  const challenge = unauth.headers.get('www-authenticate') ?? '';
  const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  check('401 without token', unauth.status === 401, challenge);
  check(
    'challenge points at the per-workspace PRM',
    prmUrl === `${BASE}/.well-known/oauth-protected-resource/w/team/mcp`,
  );

  // 2. Unknown workspace: same status and challenge shape as a missing token (T19).
  const unknown = await mcpCall('nope', undefined, 'tools/list', {});
  const unknownChallenge = unknown.headers.get('www-authenticate') ?? '';
  check(
    'unknown workspace → same 401 challenge shape as a missing token (T19)',
    unknown.status === 401 && unknownChallenge.replace('/w/nope/', '/w/team/') === challenge,
    unknownChallenge,
  );

  // 3. Protected Resource Metadata per workspace.
  const prm = (await (await fetch(prmUrl ?? '')).json()) as {
    resource: string;
    authorization_servers: string[];
  };
  check('PRM resource = /w/team/mcp', prm.resource === resTeam);
  const prmOps = (await (await fetch(`${BASE}/.well-known/oauth-protected-resource/w/ops/mcp`)).json()) as {
    resource: string;
  };
  check('PRM for ops is distinct', prmOps.resource === resOps);

  // 4. Authorization server metadata (RFC 8414).
  const issuer = prm.authorization_servers[0] ?? '';
  const as = (await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json()) as AsMeta;
  check('AS metadata: issuer', as.issuer === issuer, as.issuer);
  check('AS metadata: PKCE S256 only', JSON.stringify(as.code_challenge_methods_supported) === '["S256"]');
  check('AS metadata: RFC 9207 iss supported', as.authorization_response_iss_parameter_supported === true);
  check('AS metadata: CIMD advertised', as.client_id_metadata_document_supported === true);
  check('AS metadata: protected_resources lists both workspaces', !!as.protected_resources?.includes(resOps));

  // 5. Dynamic Client Registration (RFC 7591), public client.
  const reg = await fetch(as.registration_endpoint ?? '', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'spike e2e',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const client = (await reg.json()) as { client_id: string };
  check('DCR registered a public client', reg.status === 201 && !!client.client_id, `status ${reg.status}`);
  const cid = client.client_id;

  // 6. Authorize (PKCE) + token for team.
  const team = await authorizeAndToken(as, cid, resTeam);
  check('authorization response carries iss = issuer (RFC 9207)', team.iss === issuer, String(team.iss));
  check('token response names the team resource', team.resource === resTeam, String(team.resource));

  // 7. MCP call with the team token at team.
  const call = await mcpCall('team', team.access_token, 'tools/call', { name: 'whoami', arguments: {} });
  const callJson = (await readMcp(call)) as { result?: { content?: { text: string }[] } };
  const who = JSON.parse(callJson.result?.content?.[0]?.text ?? '{}') as { workspace?: string };
  check(
    'whoami sees a grant bound to team',
    call.status === 200 && who.workspace === 'team',
    JSON.stringify(who),
  );

  // 8. Cross-workspace: the team token at ops.
  const cross = await mcpCall('ops', team.access_token, 'tools/list', {});
  check(
    'team token rejected at /w/ops/mcp (RFC 8707 audience)',
    cross.status === 401,
    `status ${cross.status}`,
  );

  // 9. A second grant for ops, same client; the team grant must survive.
  const ops = await authorizeAndToken(as, cid, resOps);
  check(
    'ops token accepted at /w/ops/mcp',
    (await mcpCall('ops', ops.access_token, 'tools/list', {})).status === 200,
  );
  check(
    'team grant not revoked by the ops grant',
    (await mcpCall('team', team.access_token, 'tools/list', {})).status === 200,
  );

  // 10. Refresh: cannot retarget; rotates; new token works.
  const retarget = (await (await refresh(as, cid, team.refresh_token, { resource: resOps })).json()) as {
    error?: string;
  };
  check('refresh cannot retarget team → ops', retarget.error === 'invalid_target', JSON.stringify(retarget));
  const ref = await refresh(as, cid, team.refresh_token);
  const refJson = (await ref.json()) as { access_token?: string; refresh_token?: string };
  check(
    'refresh issues new tokens',
    ref.ok && !!refJson.access_token && refJson.refresh_token !== team.refresh_token,
  );
  check(
    'refreshed access token works',
    (await mcpCall('team', refJson.access_token, 'tools/list', {})).status === 200,
  );

  // 11. Parallel refreshes with the same refresh token (L-029: clients refresh concurrently). A separate client, so
  // this grant does not replace the team grant above (re-authorizing a client for a resource revokes its old grant).
  const reg2 = await fetch(as.registration_endpoint ?? '', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'spike e2e parallel',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    }),
  });
  const cid2 = ((await reg2.json()) as { client_id: string }).client_id;
  const fresh = await authorizeAndToken(as, cid2, resTeam);
  const N = 5;
  const parallel = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const r = await refresh(as, cid2, fresh.refresh_token);
      const json = (await r.json()) as { access_token?: string; refresh_token?: string; error?: string };
      return { i, status: r.status, json };
    }),
  );
  const ok = parallel.filter((p) => p.status === 200);
  notes.push(
    `parallel refresh: ${ok.length}/${N} succeeded, ${new Set(ok.map((p) => p.json.refresh_token)).size} distinct new ` +
      `refresh tokens; errors: ${JSON.stringify(parallel.filter((p) => p.status !== 200).map((p) => p.json.error ?? p.status))}`,
  );
  const accessOk = await Promise.all(
    ok.map(async (p) => (await mcpCall('team', p.json.access_token, 'tools/list', {})).status),
  );
  notes.push(
    `access tokens from the race that work: ${accessOk.filter((s) => s === 200).length}/${ok.length}`,
  );
  check('parallel refreshes: at least one succeeds', ok.length >= 1);
  check(
    'parallel refreshes: every issued access token works',
    accessOk.every((s) => s === 200),
    `${accessOk.join(',')}`,
  );
  // Which refresh tokens survive the race? Try each new one (without using up the survivor list: one refresh each).
  const survivors: number[] = [];
  for (const p of ok) {
    const r = await refresh(as, cid2, p.json.refresh_token ?? '');
    if (r.ok) survivors.push(p.i);
    await r.body?.cancel();
  }
  notes.push(`new refresh tokens still usable after the race: ${survivors.length}/${ok.length}`);
  check('the grant survives a parallel refresh (some refresh token still works)', survivors.length >= 1);
  const reuse = await refresh(as, cid2, fresh.refresh_token);
  notes.push(`the original refresh token after the race: HTTP ${reuse.status}`);
  await reuse.body?.cancel();

  // 12. Unknown resource at authorize → no code.
  const { challenge: c2 } = pkce();
  const bad = new URL(as.authorization_endpoint);
  bad.search = new URLSearchParams({
    response_type: 'code',
    client_id: cid,
    redirect_uri: REDIRECT,
    code_challenge: c2,
    code_challenge_method: 'S256',
    state: 's',
    resource: `${BASE}/w/zzz/mcp`,
  }).toString();
  const badRes = await fetch(bad, { redirect: 'manual' });
  const badLoc = badRes.headers.get('location') ?? '';
  check(
    'unknown resource rejected at authorize',
    badLoc.includes('error=invalid_target') || badRes.status === 400,
    badLoc || String(badRes.status),
  );

  // 13. PKCE plain / missing must fail for a public client.
  const plain = new URL(bad);
  plain.searchParams.set('resource', resTeam);
  plain.searchParams.set('code_challenge_method', 'plain');
  check(
    'PKCE plain rejected',
    !((await fetch(plain, { redirect: 'manual' })).headers.get('location') ?? '').includes('code='),
  );
  const nopkce = new URL(plain);
  nopkce.searchParams.delete('code_challenge');
  nopkce.searchParams.delete('code_challenge_method');
  check(
    'missing PKCE rejected',
    !((await fetch(nopkce, { redirect: 'manual' })).headers.get('location') ?? '').includes('code='),
  );

  // 14. Storage, not isolate memory: add a workspace at runtime, then use it on 30 consecutive requests.
  const denied = await fetch(`${BASE}/_spike/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-spike-admin': 'wrong' },
    body: JSON.stringify({ slug: 'late' }),
  });
  check('adding a workspace without the admin secret is refused', denied.status === 403);
  const slug = `late-${b64u(randomBytes(3))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')}`;
  const add = await fetch(`${BASE}/_spike/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-spike-admin': ADMIN },
    body: JSON.stringify({ slug }),
  });
  check(`workspace ${slug} added at runtime`, add.ok, `status ${add.status}`);
  const late = await authorizeAndToken(as, cid, `${BASE}/w/${slug}/mcp`);
  let lateOk = 0;
  for (let i = 0; i < 30; i++)
    if ((await mcpCall(slug, late.access_token, 'tools/list', {})).status === 200) lateOk++;
  check('the new workspace works on 30/30 later requests (state in storage)', lateOk === 30, `${lateOk}/30`);
  check(
    'existing team token still valid after the list changed',
    (await mcpCall('team', refJson.access_token, 'tools/list', {})).status === 200,
  );

  // 15. Revocation (RFC 7009).
  const revUrl = as.revocation_endpoint ?? as.token_endpoint;
  const rev = await form(revUrl, { token: refJson.access_token ?? '', client_id: cid });
  check('revocation accepted', rev.ok, `status ${rev.status}`);
  check(
    'revoked access token rejected',
    (await mcpCall('team', refJson.access_token, 'tools/list', {})).status === 401,
  );

  for (const n of notes) console.log(`  • ${n}`);
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
