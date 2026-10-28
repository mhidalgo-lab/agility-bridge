// SPDX-License-Identifier: Apache-2.0
// The OAuth suites on Node with memory storage (P5-01, P5-03): the host is `memory-host.ts`.
import { defineOAuthAdminSuite } from './admin-suite.ts';
import { defineOAuthClientSuite } from './clients-suite.ts';
import { memoryHost } from './memory-host.ts';
import {
  defineDeviceActivitySuite,
  defineOAuthCacheSuite,
  defineOAuthSuite,
  defineRefreshFamilySuite,
} from './suite.ts';

defineOAuthSuite('memory storage', () => memoryHost());
defineOAuthClientSuite('memory storage', () => memoryHost());
defineOAuthAdminSuite('memory storage', () => memoryHost());
defineOAuthAdminSuite('memory storage, per-request isolation (the Workers shape)', () =>
  memoryHost({ request: true }),
);
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
defineDeviceActivitySuite(
  'memory storage',
  (shape) =>
    memoryHost({ oauth: shape.idleTtlSeconds === undefined ? {} : { idleTtlSeconds: shape.idleTtlSeconds } }),
  { throttle: true },
);
defineDeviceActivitySuite('memory storage, per-request isolation (the Workers shape)', (shape) =>
  memoryHost({
    request: true,
    oauth: shape.idleTtlSeconds === undefined ? {} : { idleTtlSeconds: shape.idleTtlSeconds },
  }),
);
