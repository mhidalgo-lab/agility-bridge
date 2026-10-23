// SPDX-License-Identifier: Apache-2.0
// Admin identity (P4-01, ADR-0009 step 2): Google, GitHub, Cloudflare Access and generic OIDC providers, login
// transactions, setup links and the sign-in policy; admin sessions (P4-02).
export {
  CF_ACCESS_HEADER,
  type CloudflareAccessOptions,
  createCloudflareAccessProvider,
  isAccessAudience,
  normalizeAccessTeam,
} from './cf-access.ts';
export {
  createIdentityProviders,
  IDENTITY_SECRET_NAMES,
  IDENTITY_SETTING_NAMES,
  type IdentityEnv,
  type IdentitySettings,
  identitySettingsFromEnv,
  type ProviderSettings,
  parsePublicUrl,
  providerRouteId,
} from './config.ts';
export {
  IdentityConfigError,
  IdentityError,
  type IdentityErrorCode,
  isIdentityError,
} from './errors.ts';
export {
  createGitHubProvider,
  GITHUB_API_URL,
  GITHUB_AUTHORIZE_URL,
  GITHUB_ORG_RE,
  GITHUB_TOKEN_URL,
  type GitHubProviderOptions,
} from './github.ts';
export {
  createGoogleProvider,
  GOOGLE_ALT_ISSUER,
  GOOGLE_ISSUER,
  type GoogleProviderOptions,
} from './google.ts';
export { ASYMMETRIC_ALGORITHMS, CLOCK_SKEW_SECONDS, JWKS_COOLDOWN_MS, verifyJwt } from './jwt.ts';
export {
  consumeSetupLink,
  createSetupLink,
  DEFAULT_SETUP_LINK_TTL_MS,
  deriveLoginSecrets,
  type FinishedLogin,
  finishLogin,
  LOGIN_TTL_SECONDS,
  type LoginKeys,
  type LoginTransaction,
  MAX_SETUP_LINK_TTL_MS,
  MIN_SETUP_LINK_TTL_MS,
  pkceChallenge,
  randomValue,
  SETUP_CODE_RE,
  type SetupLink,
  type StartedLogin,
  setupCodeHash,
  setupLinkUsable,
  startLogin,
} from './login.ts';
export {
  createOidcProvider,
  ID_TOKEN_MAX_AGE_SECONDS,
  type OidcProviderOptions,
  parseDiscovery,
} from './oidc.ts';
export {
  type AllowlistMatch,
  type AutoProvision,
  EMPTY_LOGIN_POLICY,
  type LoginDecision,
  type LoginDenyReason,
  type LoginOutcome,
  type LoginPolicy,
  matchAllowlist,
  resolveLoginUser,
} from './policy.ts';
export {
  type AuthorizationRequest,
  type AuthorizationResult,
  type CompleteHooks,
  canonicalEmail,
  type HeaderIdentityProvider,
  type IdentityProvider,
  PROVIDER_ID_RE,
  type RedirectIdentityProvider,
  type VerifiedIdentity,
} from './types.ts';
