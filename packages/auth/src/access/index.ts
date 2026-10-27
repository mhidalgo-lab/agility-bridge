// SPDX-License-Identifier: Apache-2.0

export { DENY_CLASS, type DenyClass, isRecoverableDeny } from './deny-class.ts';
export {
  type Actor,
  ForbiddenError,
  type GuardContext,
  type GuardedServices,
  guardedServices,
  ReauthRequiredError,
  TOKEN_PAGE_DEFAULT,
  TOKEN_PAGE_MAX,
  type TokenListItem,
} from './guards.ts';
export { loadAccessRecords } from './load.ts';
export {
  type AssetTypePolicy,
  assetTypePolicySchema,
  type DeploymentLimits,
  type EffectiveLimits,
  effectiveAssetTypes,
  effectiveLimits,
  type GrantPolicy,
  grantPolicySchema,
  type LimitsPolicy,
  limitsPolicySchema,
  type RateLimitPolicy,
  rateLimitPolicySchema,
  type WorkspacePolicy,
  type WritePolicy,
  workspacePolicySchema,
  writePolicySchema,
} from './policy.ts';
export {
  type AccessDecision,
  type AccessRecords,
  type AccessSettings,
  DENY_REASONS,
  type DenyReason,
  type EffectiveAccess,
  type Principal,
  resolveAccess,
  resolvePassthroughAccess,
  type ToolInfo,
} from './resolve.ts';
export {
  type AccessServices,
  type AccessServicesOptions,
  accessServices,
  checkNumberPrefixes,
  type GrantPatchInput,
  MAX_NUMBER_PREFIXES,
  type NewGrantInput,
  type NewWorkspaceInput,
  type WithWarnings,
  type WorkspacePatchInput,
} from './services.ts';
export {
  type CredentialValidator,
  credentialValidator,
  type ProbeResult,
  probeInstance,
  UpstreamCheckError,
  type ValidationResult,
  type ValidatorServices,
  validateAgilityToken,
} from './validate.ts';
