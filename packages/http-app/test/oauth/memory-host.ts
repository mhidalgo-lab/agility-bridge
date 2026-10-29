// SPDX-License-Identifier: Apache-2.0
// The OAuth host on Node with memory storage (P5-01): the app built by `world()`, a clock that follows the real one so
// the provider's own `Date.now()` and ours agree, and the consent stand-in.
import { generateMasterKey, Keyring } from '@agility-bridge/auth';
import { DEFAULT_LIMITS } from '@agility-bridge/core';
import { vi } from 'vitest';
import type { HttpWrites, OAuthOptions } from '../../src/index.ts';
import { ADMIN_BASE, createHttpWrites } from '../../src/index.ts';
import { ORIGIN, TOOL_INFO, world } from '../helpers/world.ts';
import { testConsent } from './consent.ts';
import { createFakeDocuments } from './documents.ts';
import type { OAuthHost } from './suite.ts';

export async function memoryHost(
  shape: {
    request?: boolean;
    cache?: boolean;
    oauth?: Partial<OAuthOptions>;
    /** The server switch for write tools (`AB_WRITE_TOOLS=on`) and the write wiring (P7-24). */
    writes?: boolean;
  } = {},
): Promise<OAuthHost> {
  const documents = createFakeDocuments();
  let writes: HttpWrites | undefined;
  const w = await world(
    {
      publicUrl: ORIGIN,
      // Tests choose the client address with a header (P5-09); no header = one shared address.
      clientIp: (c) => c.req.header('x-test-ip') ?? 'unknown',
      accessCacheTtlSeconds: shape.cache === true ? 30 : 0,
      ...(shape.writes === true
        ? {
            access: {
              tools: TOOL_INFO,
              writesEnabled: true,
              environment: 'live' as const,
              limits: {
                defaults: {
                  ...DEFAULT_LIMITS,
                  maxResponseBytes: 8 * 1024 * 1024,
                  callBudget: 1_000,
                  genericQuery: true,
                },
                ceilings: {},
              },
            },
            writes: {
              runtimeFor: (a: Parameters<HttpWrites['runtimeFor']>[0]) =>
                (writes as HttpWrites).runtimeFor(a),
            },
          }
        : {}),
      oauth: { consent: testConsent, clientMetadataFetch: documents.fetcher, ...(shape.oauth ?? {}) },
      // The Workers shape (L-096): per-request isolation, linear routers, a detached audit writer.
      ...(shape.request === true ? { isolation: 'request' as const } : {}),
    },
    { admin: true, liveClock: true, ...(shape.request === true ? { detachedAudit: true } : {}) },
  );
  if (shape.writes === true) {
    writes = createHttpWrites({
      storage: w.storage,
      audit: w.audit,
      keyring: await Keyring.create(generateMasterKey(1)),
      clock: { now: () => Date.now() },
    });
  }
  // A service grant (no user) on a shared, read-only credential: OAuth must never bind a token to one.
  const shared = await w.services.credentials.create({
    instanceId: w.ids.instance,
    ownerUserId: null,
    label: 'shared',
    token: '1.SharedAgilityTokenNotRealAbCdEfGh0003',
  });
  await w.storage.credentials.update(shared.id, { validationStatus: 'valid' });
  const service = (
    await w.services.grants.create({
      workspaceId: w.ids.workspaceA,
      userId: null,
      label: 'ci',
      credentialId: shared.id,
    })
  ).record;
  return {
    origin: ORIGIN,
    documents,
    ...(w.app.oauthRegistrations === undefined ? {} : { registrations: w.app.oauthRegistrations }),
    call: (url, init) => Promise.resolve(w.app.fetch(new Request(url, init))),
    storage: w.storage,
    ids: {
      alice: w.ids.alice,
      bob: w.ids.bob,
      workspaceA: w.ids.workspaceA,
      workspaceB: w.ids.workspaceB,
      aliceGrantA: w.ids.aliceGrant,
      aliceGrantB: w.ids.aliceGrantB,
      bobGrantB: w.ids.bobGrant,
      serviceGrantA: service.id,
      aliceDeviceTokenA: w.tokens.alice,
    },
    agilityRequests: () => w.agilityTokens.length,
    logs: () => w.logs,
    adminApi: (method, path, body) =>
      Promise.resolve(
        w.app.fetch(
          new Request(`${ORIGIN}${ADMIN_BASE}${path}`, {
            method,
            headers: {
              'x-test-actor': 'break_glass',
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        ),
      ),
    address: (ip) => ({ 'x-test-ip': ip }),
    advance: (ms) => vi.setSystemTime(Date.now() + ms),
    close: async () => {
      await w.audit.flush();
    },
  };
}
