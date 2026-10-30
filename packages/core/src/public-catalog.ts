// SPDX-License-Identifier: Apache-2.0
// The public, read-only tool catalogue (P8-11, THREAT_MODEL T33): what an unauthenticated `tools/list` shows when the
// operator turned `AB_PUBLIC_TOOL_CATALOG` on, and what an unconfigured stdio server lists. It is a function of the
// tool registry and nothing else: no workspace, grant, instance, storage row or request value reaches it (D-64, D-201).
import {
  closedBreaker,
  createBudget,
  DEFAULT_LIMITS,
  systemClock,
  type ToolContext,
  unboundedLimiter,
  webCryptoRandom,
} from './context.ts';
import { AbError, ErrorCode } from './errors.ts';
import { silentLogger } from './logger.ts';
import { Secret } from './secret.ts';
import type { ToolDefinition } from './tool.ts';

/**
 * Groups the public catalogue lists. The opt-in groups (`attachments`, `reports`, `writes`) are never in it: whether a
 * deployment offers them is exactly the kind of thing the catalogue must not reveal.
 */
export const PUBLIC_CATALOG_GROUPS: readonly string[] = Object.freeze([
  'core',
  'query',
  'work',
  'planning',
  'people',
  'collaboration',
  'portfolio',
  'history',
]);

/**
 * The MCP methods answered without a credential when the catalogue is public. `notifications/initialized` has no
 * effect; it is here so that a client's handshake is not cut by a `401` in its middle.
 */
export const PUBLIC_CATALOG_METHODS: readonly string[] = Object.freeze([
  'initialize',
  'server/discover',
  'ping',
  'tools/list',
  'notifications/initialized',
]);

/** Whether `method` may be answered without a credential on a public-catalogue deployment. */
export function isPublicCatalogMethod(method: string | null): boolean {
  return method !== null && PUBLIC_CATALOG_METHODS.includes(method);
}

/**
 * The tools of the public catalogue from a registry's tools: read-only tools of the default groups, whatever the
 * caller, with handlers that refuse. `tools/call` is never forwarded to them; the refusal is the second lock.
 */
export function publicCatalogTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools
    .filter((t) => t.kind === 'read' && PUBLIC_CATALOG_GROUPS.includes(t.group))
    .map((t) => ({
      ...t,
      handler: async () => {
        throw new AbError(ErrorCode.AuthUnauthorized, 'Sign in to call this tool.');
      },
    }));
}

/**
 * A fixed context for the public catalogue's server: no credential, no budget, no instance. Built once; nothing in it
 * comes from a request (T21).
 */
export function publicCatalogContext(): ToolContext {
  return Object.freeze({
    requestId: 'public-catalog',
    instance: { id: 'public-catalog', baseUrl: 'https://agility.invalid' },
    workspace: {
      id: 'public-catalog',
      name: 'Public catalogue',
      groups: [],
      writes: { enabled: false, approval: 'unavailable' as const },
    },
    credential: { id: 'none', kind: 'personal' as const, token: new Secret('') },
    projects: { allowed: [], includeChildren: true },
    assetTypes: { deny: [] },
    limits: DEFAULT_LIMITS,
    budget: createBudget(0),
    limiter: unboundedLimiter,
    breaker: closedBreaker,
    fetch: () => Promise.reject(new Error('the public catalogue makes no Agility requests')),
    logger: silentLogger,
    clock: systemClock,
    random: webCryptoRandom,
  });
}
