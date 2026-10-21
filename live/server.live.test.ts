// SPDX-License-Identifier: Apache-2.0
// P2-17 live check: the Phase 2 server path against the read-only tenant — instance probe, credential validation,
// workspace and grant, device token, MCP over HTTP in both protocol eras, and a pass-through workspace. Every request to
// the tenant goes through guardedFetch (P0-12: GET and query.v1/meta.v1 reads only, no redirects). Asserts on statuses
// and counts only; prints nothing from the tenant; keeps no ids, names or content. About 15 read requests.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  accessServices,
  credentialValidator,
  generateMasterKey,
  Keyring,
} from '../packages/auth/src/index.ts';
import {
  CircuitBreakers,
  CORE_TOOLS,
  CredentialLimiters,
  createLogger,
  DEFAULT_LIMITS,
  MetadataService,
  systemClock,
  webCryptoRandom,
} from '../packages/core/src/index.ts';
import { AuditWriter, createHttpApp } from '../packages/http-app/src/index.ts';
import { createMemoryStorage } from '../packages/storage/src/index.ts';
import { liveTarget } from './env.ts';
import { guardedFetch } from './guarded-fetch.ts';

const target = liveTarget();

describe.skipIf(!target)('the server against the live tenant (read-only)', () => {
  it('validates, serves a workspace to a device token in both eras, and serves a pass-through workspace', async () => {
    if (target === undefined) return;
    const fetch = guardedFetch(target);
    const logs: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (l) => logs.push(l) });
    const host = {
      fetchFor: () => fetch,
      limiters: new CredentialLimiters({ concurrency: 1 }),
      breakers: new CircuitBreakers(),
      metadata: new MetadataService(),
      logger,
      clock: systemClock,
      random: webCryptoRandom,
    };
    const tools = new Map(CORE_TOOLS.map((t) => [t.name, { kind: t.kind, group: t.group }]));
    const storage = createMemoryStorage();
    const keyring = await Keyring.create(generateMasterKey(1));
    const validator = credentialValidator(host);
    const svc = accessServices({ storage, keyring, tools, validator, environment: 'test' });

    // The origin probe (unauthenticated meta.v1) and the validation (query.v1) against the tenant.
    const instance = await svc.instances.create({ label: 'Live', baseUrl: target.baseUrl });
    expect(instance.metaFingerprint).not.toBeNull();
    const credential = await svc.credentials.create({
      instanceId: instance.id,
      ownerUserId: null,
      label: 'live',
      token: target.token,
    });
    expect(credential.validationStatus).toBe('valid');
    expect(credential.reachableScopeIds?.length ?? 0).toBeGreaterThan(0);
    const project = (credential.reachableScopeIds as string[])[0] as string;

    const ws = await svc.workspaces.create({
      slug: 'live',
      name: 'Live',
      instanceId: instance.id,
      allowedScopeIds: [project],
      includeChildScopes: true,
      defaultCredentialId: credential.id,
      enabledTools: ['whoami', 'search_work_items', 'list_projects'],
    });
    const grant = await svc.grants.create({ workspaceId: ws.id, userId: null, label: 'live check' });
    const { token } = await svc.tokens.issue({ grantId: grant.record.id, label: 'live', expiresInDays: 1 });
    await svc.workspaces.create({
      slug: 'live-pt',
      name: 'Live pass-through',
      instanceId: instance.id,
      allowedScopeIds: [project],
      includeChildScopes: true,
      enabledTools: ['whoami'],
      credentialSource: 'passthrough',
    });

    const audit = new AuditWriter({ storage, logger, clock: systemClock, random: webCryptoRandom });
    const app = createHttpApp({
      storage,
      keyring,
      access: {
        tools,
        writesEnabled: false,
        environment: 'test',
        limits: { defaults: { ...DEFAULT_LIMITS, callBudget: 100, genericQuery: true }, ceilings: {} },
      },
      tools: CORE_TOOLS,
      services: host,
      passthrough: { validator, secure: () => true },
      observer: audit.observer(),
      version: 'live',
    });
    const inProcess = (url: string | URL, init?: RequestInit) =>
      Promise.resolve(app.fetch(new Request(url, init)));

    for (const mode of ['legacy', { pin: '2026-07-28' }] as const) {
      const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8787/w/live/mcp'), {
        fetch: inProcess,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: 'live', version: '0' }, { versionNegotiation: { mode } });
      await client.connect(transport);
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
        'list_projects',
        'search_work_items',
        'whoami',
      ]);
      expect((await client.callTool({ name: 'whoami', arguments: {} })).isError).toBeFalsy();
      const search = await client.callTool({ name: 'search_work_items', arguments: { limit: 3 } });
      expect(search.isError).toBeFalsy();
      await client.close();
    }

    const pt = await app.fetch(
      new Request('http://127.0.0.1:8787/w/live-pt/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
          'x-agility-token': target.token,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'whoami', arguments: {} },
        }),
      }),
    );
    expect(pt.status).toBe(200);
    expect(await pt.text()).not.toContain('"isError":true');

    await audit.flush();
    const rows = await storage.audit.query({ kind: 'tool_call', limit: 100 });
    expect(rows.length).toBe(5);
    expect(rows.every((r) => r.status === 'ok')).toBe(true);
    const dump = JSON.stringify([logs, rows]);
    expect(dump.includes(target.token)).toBe(false);
    expect(dump.includes(token)).toBe(false);
  });
});
