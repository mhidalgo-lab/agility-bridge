// SPDX-License-Identifier: Apache-2.0
// The OAuth host on Node with memory storage (P5-01): the app built by `world()`, a clock that follows the real one so
// the provider's own `Date.now()` and ours agree, and the consent stand-in.
import { vi } from 'vitest';
import type { OAuthOptions } from '../../src/index.ts';
import { ORIGIN, world } from '../helpers/world.ts';
import { testConsent } from './consent.ts';
import { createFakeDocuments } from './documents.ts';
import type { OAuthHost } from './suite.ts';

export async function memoryHost(
  shape: { request?: boolean; cache?: boolean; oauth?: Partial<OAuthOptions> } = {},
): Promise<OAuthHost> {
  const documents = createFakeDocuments();
  const w = await world(
    {
      publicUrl: ORIGIN,
      accessCacheTtlSeconds: shape.cache === true ? 30 : 0,
      oauth: { consent: testConsent, clientMetadataFetch: documents.fetcher, ...(shape.oauth ?? {}) },
      // The Workers shape (L-096): per-request isolation, linear routers, a detached audit writer.
      ...(shape.request === true ? { isolation: 'request' as const } : {}),
    },
    { liveClock: true, ...(shape.request === true ? { detachedAudit: true } : {}) },
  );
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
    advance: (ms) => vi.setSystemTime(Date.now() + ms),
    close: async () => {
      await w.audit.flush();
    },
  };
}
