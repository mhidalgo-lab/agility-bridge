// SPDX-License-Identifier: Apache-2.0
// Connected apps of everyone and registered clients (P5-08, THREAT_MODEL T15), written once against `OAuthHost` and run on
// Node with memory storage (http-app), Node with SQLite (cli) and workerd with D1 (worker). The admin API is called as the
// break-glass token (an owner); who may call what is tested with real sessions in `admin-oauth.test.ts`.
import type { OAuthClientInformationFull } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { APPROVE_HEADER } from './consent.ts';
import {
  auditRows,
  connectWorkspace,
  kvText,
  mcp,
  type OAuthHost,
  register,
  resourceOf,
  tokenEndpoint,
  WHOAMI,
} from './suite.ts';

const DOC_URL = 'https://client.example.org/oauth/client-metadata.json';
const LOOPBACK = 'http://127.0.0.1:53682/callback';
const HOSTILE = '<img src=x onerror=alert(1)>"\'&';

interface DeviceRow {
  readonly id: string;
  readonly userId: string;
  readonly clientName: string | null;
  readonly redirectHost: string;
  readonly workspaceName: string | null;
  readonly userRole: string | null;
}
interface ClientRow {
  readonly clientId: string;
  readonly kind: string;
  readonly name: string | null;
  readonly redirectHosts: string[];
  readonly devices: number | null;
}
interface ClientList {
  readonly data: ClientRow[];
  readonly blocked: { clientId: string; kind: string; name: string | null }[];
  readonly next: string | null;
}

export function defineOAuthAdminSuite(name: string, makeHost: () => Promise<OAuthHost>): void {
  describe(`OAuth admin: connected apps and registered clients: ${name}`, () => {
    const open: OAuthHost[] = [];
    afterEach(async () => {
      await Promise.all(open.splice(0).map((h) => h.close()));
    });
    const host = async (): Promise<OAuthHost> => {
      const h = await makeHost();
      open.push(h);
      return h;
    };
    const api = (h: OAuthHost, method: 'GET' | 'POST', path: string, body?: unknown) =>
      (h.adminApi as NonNullable<OAuthHost['adminApi']>)(method, path, body);
    const devices = async (h: OAuthHost, query = ''): Promise<{ data: DeviceRow[]; next: string | null }> => {
      const res = await api(h, 'GET', `/oauth/devices${query}`);
      expect(res.status).toBe(200);
      return (await res.json()) as { data: DeviceRow[]; next: string | null };
    };
    const clients = async (h: OAuthHost, query = ''): Promise<ClientList> => {
      const res = await api(h, 'GET', `/oauth/clients${query}`);
      expect(res.status).toBe(200);
      return (await res.json()) as ClientList;
    };
    const refresh = (h: OAuthHost, client: OAuthClientInformationFull, token: string) =>
      tokenEndpoint(h, { grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id });
    /** Alice on team-a and Bob on team-b, each through an app of their own. */
    const twoPeople = async (h: OAuthHost, aliceApp = HOSTILE) => {
      const aliceClient = await register(h, { name: aliceApp });
      const alice = await connectWorkspace(h, 'team-a', undefined, aliceClient);
      const bob = await connectWorkspace(h, 'team-b', `${h.ids.bob}|${h.ids.bobGrantB}`, undefined);
      return { alice, bob };
    };
    const deviceOf = async (h: OAuthHost, userId: string): Promise<DeviceRow> => {
      const found = (await devices(h)).data.find((d) => d.userId === userId);
      expect(found).toBeDefined();
      return found as DeviceRow;
    };

    it("lists every person's connected apps, a page at a time, with no token in any answer", async () => {
      const h = await host();
      const { alice, bob } = await twoPeople(h);
      const all = await devices(h);
      expect(all.data.map((d) => d.userId).sort()).toEqual([h.ids.alice, h.ids.bob].sort());
      const a = all.data.find((d) => d.userId === h.ids.alice) as DeviceRow;
      expect(a.clientName).toBe(HOSTILE);
      expect(a.redirectHost).toBe('127.0.0.1:53682');
      expect(a.workspaceName).toBe('Team A');
      expect(a.userRole).toBe('member');
      // One at a time: two pages that together are the whole list.
      const first = await devices(h, '?limit=1');
      expect(first.data).toHaveLength(1);
      expect(first.next).not.toBeNull();
      const second = await devices(h, `?limit=1&after=${encodeURIComponent(first.next as string)}`);
      expect(second.data).toHaveLength(1);
      expect(second.next).toBeNull();
      expect([first.data[0]?.id, second.data[0]?.id].sort()).toEqual(all.data.map((d) => d.id).sort());
      // A malformed cursor is refused, not interpreted.
      expect((await api(h, 'GET', '/oauth/devices?after=not-a-cursor')).status).toBe(422);
      // Nothing the answer says is a token or a secret.
      const text = JSON.stringify(all);
      for (const t of [alice.tokens, bob.tokens]) {
        expect(text).not.toContain(t.access_token);
        expect(text).not.toContain(t.refresh_token as string);
      }
    });

    it('disconnecting a device ends its access and refresh tokens and nobody elses, and writes audit rows without tokens', async () => {
      const h = await host();
      const { alice, bob } = await twoPeople(h, 'Alice app');
      expect((await mcp(h, 'team-a', alice.tokens.access_token, WHOAMI)).status).toBe(200);
      const target = await deviceOf(h, h.ids.alice);
      const res = await api(h, 'POST', `/oauth/devices/${target.id}/revoke`, { userId: h.ids.alice });
      expect(res.status).toBe(200);
      expect((await mcp(h, 'team-a', alice.tokens.access_token, WHOAMI)).status).toBe(401);
      const refused = await refresh(h, alice.client, alice.tokens.refresh_token as string);
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toBe('invalid_grant');
      // Bob's device is untouched.
      expect((await mcp(h, 'team-b', bob.tokens.access_token, WHOAMI)).status).toBe(200);
      expect((await devices(h)).data.map((d) => d.userId)).toEqual([h.ids.bob]);
      // Audit: the device row (an `auth` row of the person) and the administrator's row, with no token anywhere.
      const device = await auditRows(h, (r) => r.action === 'oauth.device.revoke');
      expect(device).toHaveLength(1);
      expect((device[0] as { details?: { via?: string } }).details?.via).toBe('admin');
      const admin = await auditRows(h, (r) => r.action === 'oauth_device.revoke');
      expect(admin).toHaveLength(1);
      const rows = JSON.stringify(await h.storage.audit.query({ limit: 1000 }));
      expect(rows).not.toContain(alice.tokens.access_token);
      expect(rows).not.toContain(alice.tokens.refresh_token as string);
    });

    it("another person's id, an unknown device and a malformed id end nothing and answer 404 or 422", async () => {
      const h = await host();
      const { alice, bob } = await twoPeople(h, 'Alice app');
      const aliceDevice = await deviceOf(h, h.ids.alice);
      // Alice's device under Bob's id: not Bob's, so not found, and still connected.
      const wrong = await api(h, 'POST', `/oauth/devices/${aliceDevice.id}/revoke`, { userId: h.ids.bob });
      expect(wrong.status).toBe(404);
      const unknown = await api(h, 'POST', '/oauth/devices/AAAAAAAAAAAAAAAA/revoke', { userId: h.ids.alice });
      expect(unknown.status).toBe(404);
      const malformed = await api(h, 'POST', '/oauth/devices/short/revoke', { userId: h.ids.alice });
      expect(malformed.status).toBe(404);
      const noBody = await api(h, 'POST', `/oauth/devices/${aliceDevice.id}/revoke`, {});
      expect(noBody.status).toBe(422);
      expect((await mcp(h, 'team-a', alice.tokens.access_token, WHOAMI)).status).toBe(200);
      expect((await mcp(h, 'team-b', bob.tokens.access_token, WHOAMI)).status).toBe(200);
      expect((await auditRows(h, (r) => r.action === 'oauth.device.revoke', 0)).length).toBe(0);
    });

    it('lists registered clients with kind, name, redirect hosts and how many devices use them', async () => {
      const h = await host();
      const { alice } = await twoPeople(h);
      await connectWorkspace(h, 'team-a', undefined, alice.client);
      const list = await clients(h);
      const mine = list.data.find((k) => k.clientId === alice.client.client_id) as ClientRow;
      expect(mine.kind).toBe('dynamic');
      expect(mine.name).toBe(HOSTILE);
      expect(mine.redirectHosts).toEqual(['127.0.0.1:53682']);
      // The second approval of the same app replaces the first once redeemed: one device.
      expect(mine.devices).toBe(1);
      expect(list.data.length).toBeGreaterThanOrEqual(2);
      const one = await clients(h, '?limit=1');
      expect(one.data).toHaveLength(1);
      expect(one.next).not.toBeNull();
    });

    it('revoking a dynamic client ends every device of it, refuses it from then on, and frees nothing for the same id', async () => {
      const h = await host();
      const { alice, bob } = await twoPeople(h, 'Alice app');
      const res = await api(h, 'POST', '/oauth/clients/revoke', { clientId: alice.client.client_id });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { devices: number }).devices).toBe(1);
      // Tokens: the access token stops, the refresh token cannot be used.
      expect((await mcp(h, 'team-a', alice.tokens.access_token, WHOAMI)).status).toBe(401);
      const refused = await refresh(h, alice.client, alice.tokens.refresh_token as string);
      expect(refused.status).toBe(400);
      // A new authorization of the same client id is refused: no code, no redirect.
      const again = await h.call(
        `${h.origin}/oauth/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: alice.client.client_id,
          redirect_uri: LOOPBACK,
          code_challenge: 'a'.repeat(43),
          code_challenge_method: 'S256',
          state: 's',
          scope: 'mcp:read',
          resource: resourceOf(h, 'team-a'),
        })}`,
        { redirect: 'manual', headers: { [APPROVE_HEADER]: `${h.ids.alice}|${h.ids.aliceGrantA}` } },
      );
      expect(again.status).toBe(400);
      expect(again.headers.get('location')).toBeNull();
      expect(((await again.json()) as { error: string }).error).toBe('invalid_client');
      // Another app of another person is untouched.
      expect((await mcp(h, 'team-b', bob.tokens.access_token, WHOAMI)).status).toBe(200);
      expect(await h.storage.kv.get(`oauth:client:${alice.client.client_id}`)).toBeNull();
      // The devices themselves are gone, not just refused: only Bob's is left.
      expect((await devices(h)).data.map((d) => d.userId)).toEqual([h.ids.bob]);
      expect((await clients(h)).data.map((k) => k.clientId)).not.toContain(alice.client.client_id);
      // The refusal list shows it, and a revoked dynamic client has nothing to restore.
      expect((await clients(h)).blocked.map((k) => k.clientId)).toContain(alice.client.client_id);
      // Revoking again finishes the job without error, a client that never existed is 404.
      expect(
        (await api(h, 'POST', '/oauth/clients/revoke', { clientId: alice.client.client_id })).status,
      ).toBe(200);
      expect(
        (await api(h, 'POST', '/oauth/clients/revoke', { clientId: 'nobody-registered-this' })).status,
      ).toBe(404);
      // A new registration is a new client and works (D-74).
      const fresh = await register(h, { name: 'Alice app' });
      expect(fresh.client_id).not.toBe(alice.client.client_id);
      const reconnect = await connectWorkspace(h, 'team-a', undefined, fresh);
      expect((await mcp(h, 'team-a', reconnect.tokens.access_token, WHOAMI)).status).toBe(200);
      // Audit: one row per device, one for the client, and the administrator's row. Never a token.
      expect((await auditRows(h, (r) => r.action === 'oauth.client.revoked', 2)).length).toBe(2);
      expect((await auditRows(h, (r) => r.action === 'oauth.device.revoke')).length).toBeGreaterThanOrEqual(
        1,
      );
      expect((await auditRows(h, (r) => r.action === 'oauth_client.revoke')).length).toBe(3);
      const rows = JSON.stringify(await h.storage.audit.query({ limit: 1000 }));
      expect(rows).not.toContain(alice.tokens.access_token);
      expect(rows).not.toContain(alice.tokens.refresh_token as string);
      expect(await kvText(h)).not.toContain(alice.tokens.refresh_token as string);
    });

    it('a blocked client is refused everywhere even when its devices were not ended (a revoke cut short)', async () => {
      const h = await host();
      const { alice } = await twoPeople(h, 'Alice app');
      expect((await mcp(h, 'team-a', alice.tokens.access_token, WHOAMI)).status).toBe(200);
      // Only the block row exists, as after a revoke that stopped before it reached the grants.
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(alice.client.client_id)),
      );
      const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
      await h.storage.kv.set(
        `oauth-client-blocked:${hex}`,
        JSON.stringify({ clientId: alice.client.client_id, kind: 'dynamic', name: null, at: Date.now() }),
      );
      // The access token stops at the resource, the refresh token at the token endpoint, a new authorization at the front.
      expect((await mcp(h, 'team-a', alice.tokens.access_token, WHOAMI)).status).toBe(401);
      const refused = await refresh(h, alice.client, alice.tokens.refresh_token as string);
      expect(refused.status).toBe(400);
      const again = await h.call(
        `${h.origin}/oauth/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: alice.client.client_id,
          redirect_uri: LOOPBACK,
          code_challenge: 'a'.repeat(43),
          code_challenge_method: 'S256',
          state: 's',
          scope: 'mcp:read',
          resource: resourceOf(h, 'team-a'),
        })}`,
        { redirect: 'manual', headers: { [APPROVE_HEADER]: `${h.ids.alice}|${h.ids.aliceGrantA}` } },
      );
      expect(again.status).toBe(400);
      // Pressing revoke finishes the job: the device is gone from the list.
      expect(
        (await api(h, 'POST', '/oauth/clients/revoke', { clientId: alice.client.client_id })).status,
      ).toBe(200);
    });

    it('a revoked metadata-document client is refused until an owner allows it again', async () => {
      const h = await host();
      h.documents.serveClient(DOC_URL, { client_name: HOSTILE });
      const authorizeDocument = () =>
        h.call(
          `${h.origin}/oauth/authorize?${new URLSearchParams({
            response_type: 'code',
            client_id: DOC_URL,
            redirect_uri: LOOPBACK,
            code_challenge: 'a'.repeat(43),
            code_challenge_method: 'S256',
            state: 's',
            scope: 'mcp:read',
            resource: resourceOf(h, 'team-a'),
          })}`,
          { redirect: 'manual', headers: { [APPROVE_HEADER]: `${h.ids.alice}|${h.ids.aliceGrantA}` } },
        );
      expect((await authorizeDocument()).status).toBe(302);
      const listed = (await clients(h)).data.find((k) => k.clientId === DOC_URL) as ClientRow;
      expect(listed.kind).toBe('metadata_document');
      expect(listed.name).toBe(HOSTILE);
      expect((await api(h, 'POST', '/oauth/clients/revoke', { clientId: DOC_URL })).status).toBe(200);
      const refused = await authorizeDocument();
      expect(refused.status).toBe(400);
      expect(refused.headers.get('location')).toBeNull();
      expect((await clients(h)).blocked.map((k) => k.clientId)).toEqual([DOC_URL]);
      // Restoring something that is not revoked is a 404; restoring the client lets it back in.
      expect((await api(h, 'POST', '/oauth/clients/restore', { clientId: 'never-revoked' })).status).toBe(
        404,
      );
      expect((await api(h, 'POST', '/oauth/clients/restore', { clientId: DOC_URL })).status).toBe(200);
      expect((await authorizeDocument()).status).toBe(302);
      expect((await clients(h)).blocked).toEqual([]);
      expect((await auditRows(h, (r) => r.action === 'oauth.client.restored')).length).toBe(1);
    });
  });
}
