// SPDX-License-Identifier: Apache-2.0
// The OAuth suites on Node with memory storage (P5-01, P5-03): the host is `memory-host.ts`.
import { defineOAuthClientSuite } from './clients-suite.ts';
import { memoryHost } from './memory-host.ts';
import { defineOAuthCacheSuite, defineOAuthSuite, defineRefreshFamilySuite } from './suite.ts';

defineOAuthSuite('memory storage', () => memoryHost());
defineOAuthClientSuite('memory storage', () => memoryHost());
defineOAuthClientSuite('memory storage, per-request isolation (the Workers shape)', () =>
  memoryHost({ request: true }),
);
defineOAuthSuite('memory storage, per-request isolation (the Workers shape)', () =>
  memoryHost({ request: true }),
);
defineOAuthCacheSuite('memory storage', () => memoryHost({ cache: true }));
defineRefreshFamilySuite('memory storage', (shape) =>
  memoryHost({ oauth: { refreshReuseWindowSeconds: shape.reuseWindowSeconds } }),
);
defineRefreshFamilySuite('memory storage, per-request isolation (the Workers shape)', (shape) =>
  memoryHost({ request: true, oauth: { refreshReuseWindowSeconds: shape.reuseWindowSeconds } }),
);
