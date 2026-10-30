// SPDX-License-Identifier: Apache-2.0
// Hono app with per-workspace MCP endpoints and the admin API (ARCHITECTURE §2, §5).
export { AccessCache, MAX_ACCESS_CACHE_TTL_MS } from './access-cache.ts';
export {
  ADMIN_BASE,
  type AdminApiOptions,
  type AdminAuthResult,
  type AdminRefusal,
  adminAuthenticator,
  adminTokenAuthenticator,
  createAdminApi,
} from './admin/api.ts';
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
  type LoginEvent,
  type OAuthEvent,
  purgeAudit,
  scheduleAuditRetention,
} from './audit.ts';
export { createEdge, type Edge, type EdgeOptions } from './edge.ts';
export {
  type CompletedLogin,
  createIdentityRoutes,
  DEFAULT_LOGIN_NEXT,
  IDENTITY_BASE,
  type IdentityOptions,
  isLocalPath,
  safeNextPath,
} from './identity.ts';
export {
  type ClassifiedRequest,
  classifyMcpMessage,
  type McpMethodClass,
  readMcpBody,
} from './mcp-request.ts';
export {
  CIMD_MAX_BYTES,
  CIMD_TIMEOUT_MS,
  ClientMetadataError,
  type ClientMetadataFetch,
  fetchMetadataDocument,
} from './oauth/clients.ts';
export {
  type StorageHousekeepingOptions,
  SWEEP_SLICE,
  scheduleStorageHousekeeping,
  sweepRegistrations,
} from './oauth/housekeeping.ts';
export {
  createOAuthRuntime,
  looksLikeOAuthToken,
  MCP_SCOPE,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_METADATA_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_RESOURCE_METADATA_PREFIX,
  OAUTH_SCOPES,
  OAUTH_TOKEN_PATH,
  type OAuthAbuseOverview,
  type OAuthAdminDevice,
  type OAuthApproval,
  type OAuthAuthentication,
  type OAuthAuthorizationRequest,
  type OAuthBlockedClient,
  type OAuthClientPage,
  type OAuthClientRevocation,
  type OAuthClientSummary,
  type OAuthConsentApi,
  type OAuthConsentHandler,
  type OAuthDevicePage,
  type OAuthGrantProps,
  type OAuthOptions,
  type OAuthRegistrations,
  type OAuthRuntime,
} from './oauth/server.ts';
export {
  OAUTH_SETTING_NAMES,
  OAuthConfigError,
  type OAuthSettings,
  oauthSettingsFromEnv,
} from './oauth/settings.ts';
export {
  type CacheLike,
  DEFAULT_SHARED_ENTRY_CHARS,
  EdgeQueryTier,
  type EdgeTierOptions,
} from './query-cache-edge.ts';
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
export {
  type AssembledServer,
  assembleServer,
  type HostFeatures,
  parseServerSettings,
  parseSessionSettings,
  revalidateOnAuthErrors,
  SERVER_SETTING_NAMES,
  type ServerParts,
  type ServerSettings,
  type SettingDefaults,
  SettingsError,
  settingInteger,
  settingList,
  settingWarnings,
} from './server.ts';
export {
  CLEAR_SITE_DATA_VALUE,
  CSRF_FIELD,
  CSRF_HEADER,
  createSessionManager,
  type FetchOriginProblem,
  isUnsafeMethod,
  type SessionAuth,
  type SessionManager,
  type SessionOptions,
  type SessionPrincipal,
} from './session.ts';
export { createTaskService, TASK_TTL_MS, TASKS_EXTENSION, type TaskService } from './tasks.ts';
export { createHttpWrites, type HttpWrites, type HttpWritesOptions } from './writes.ts';
