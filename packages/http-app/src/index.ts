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
  createOAuthRuntime,
  looksLikeOAuthToken,
  MCP_SCOPE,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_METADATA_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_RESOURCE_METADATA_PREFIX,
  OAUTH_SCOPES,
  OAUTH_TOKEN_PATH,
  type OAuthApproval,
  type OAuthAuthentication,
  type OAuthAuthorizationRequest,
  type OAuthConsentApi,
  type OAuthConsentHandler,
  type OAuthGrantProps,
  type OAuthOptions,
  type OAuthRuntime,
} from './oauth/server.ts';
export {
  OAUTH_SETTING_NAMES,
  OAuthConfigError,
  type OAuthSettings,
  oauthSettingsFromEnv,
} from './oauth/settings.ts';
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
