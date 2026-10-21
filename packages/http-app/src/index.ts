// SPDX-License-Identifier: Apache-2.0
// Hono app with per-workspace MCP endpoints and the admin API (ARCHITECTURE §2, §5).
export { AccessCache, MAX_ACCESS_CACHE_TTL_MS } from './access-cache.ts';
export { ADMIN_BASE, type AdminApiOptions, adminTokenAuthenticator, createAdminApi } from './admin/api.ts';
export { AdminError, type AdminErrorBody, type AdminErrorCode, toAdminError } from './admin/errors.ts';
export {
  createHttpApp,
  EXCHANGE_DEADLINE_MS,
  type HostServices,
  type HttpApp,
  type HttpAppOptions,
  type HttpObserver,
  type LimitDecision,
  MAX_BODY_BYTES,
  type RefusalReason,
  type RequestEvent,
  type RequestLimits,
  type ToolCallRecord,
} from './app.ts';
export {
  type AdminChange,
  type AuditOptions,
  AuditWriter,
  purgeAudit,
  scheduleAuditRetention,
} from './audit.ts';
export { createEdge, type Edge, type EdgeOptions } from './edge.ts';
export {
  type ClassifiedRequest,
  classifyMcpMessage,
  type McpMethodClass,
  readMcpBody,
} from './mcp-request.ts';
export {
  addressKey,
  clientAddress,
  createRequestLimits,
  DEFAULT_RATE_LIMITS,
  MemoryRateLimiter,
  type Rate,
  type RateLimitConfig,
  type RateLimiter,
} from './rate-limit.ts';
