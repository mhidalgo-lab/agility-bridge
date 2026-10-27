// SPDX-License-Identifier: Apache-2.0
// Public surface of @agility-bridge/core: contracts every tool and host relies on (P1-01) and the Agility client (P1-02).

export { readCapped } from './agility/body.ts';
export { type CircuitBreakerOptions, CircuitBreakers } from './agility/breaker.ts';
export {
  AgilityClient,
  type AgilityClientOptions,
  type AgilityResponse,
  agilityClient,
  type QueryBody,
} from './agility/client.ts';
export {
  type AddressClass,
  addressClass,
  canonicalInstanceUrl,
  type InstanceUrlOptions,
} from './agility/instance.ts';
export { CredentialLimiters, Semaphore } from './agility/limiter.ts';
export { parseXml, type XmlElement } from './agility/xml.ts';
export {
  ACTIVE_ATTACHMENT_TYPES,
  type ApprovalChannel,
  type AssetTypeScope,
  type Breaker,
  type Budget,
  type Clock,
  type Credential,
  capBudget,
  closedBreaker,
  createBudget,
  DEFAULT_ATTACHMENT_TYPES,
  DEFAULT_LIMITS,
  type FetchLike,
  freezeContext,
  type InstanceRef,
  type Limiter,
  type Limits,
  type ProjectScope,
  type Random,
  systemClock,
  type ToolContext,
  unboundedLimiter,
  type WorkspaceInfo,
  webCryptoRandom,
} from './context.ts';
export { DEPRECATIONS, type Deprecation, deprecatedEnv } from './deprecations.ts';
export {
  AbError,
  type AbErrorOptions,
  ERROR_META_KEY,
  ErrorCode,
  isAbError,
  type ToolErrorOptions,
  toProtocolError,
  toToolErrorResult,
  type UntrustedRenderer,
} from './errors.ts';
export {
  type Candidate,
  type MatchResult,
  matchName,
  type Named,
  normalizeName,
  noSingleMatch,
  similarity,
} from './identity/match.ts';
export { type AssetRef, parseAssetRef } from './identity/refs.ts';
export {
  type Page,
  type ResolvedAsset,
  resolveAsset,
  resolveByName,
  resolveMember,
  resolveProject,
  resolveSprint,
  resolveStatus,
  resolveTeam,
  runPage,
  runQuery,
  type SprintOptions,
} from './identity/resolve.ts';
export { inScope, oidsOf, sanitizeRow } from './identity/scope.ts';
export {
  createLogger,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  type LogSink,
  silentLogger,
  stderrSink,
} from './logger.ts';
export {
  assertManifest,
  availableEntries,
  isAvailable,
  type ManifestEntry,
} from './manifest.ts';
export { metadataDrift } from './metadata/drift.ts';
export {
  ASSET_TYPE_NAME_RE,
  type AssetTypeMeta,
  ATTRIBUTE_KINDS,
  ATTRIBUTE_NAME_RE,
  type AttributeKind,
  type AttributeMeta,
  NUMBER_PREFIX_RE,
  parseAssetType,
} from './metadata/model.ts';
export {
  type Aggregation,
  DERIVED_SCOPE_PATHS,
  type FieldTiers,
  InstanceMetadata,
  MAX_PATH_SEGMENTS,
  MetadataService,
  type MetadataServiceOptions,
  metadataFor,
  NUMBERED_TYPES,
  type ResolvedPath,
  type ScopeStrategy,
  type StatusCategory,
  type StatusEntry,
} from './metadata/service.ts';
export {
  envelope,
  envelopeRenderer,
  neutralise,
  newEnvelopeId,
  UNTRUSTED_NOTICE,
} from './output/envelope.ts';
export {
  DEFAULT_OUTPUT_CAPS,
  type FormatRowsOptions,
  type FormattedRows,
  formatRows,
  IDENTITY_COLUMNS,
  MAX_OUTPUT_CAPS,
  OUTPUT_FORMATS,
  type OutputCaps,
  type OutputFormat,
  type RenderedFormat,
  resolveCaps,
  safeText,
  TABLE_MAX_COLUMNS,
  truncateText,
} from './output/format.ts';
export {
  type AssetState,
  assetState,
  type Block,
  type Line,
  type ListSpec,
  minimiseEmails,
  type OutputSpec,
  RESULT_META_KEY,
  type ShapedOutput,
  shapeList,
  shapeOutput,
  type Untrusted,
  untrusted,
} from './output/result.ts';
export { cleanText, decodeEntities, htmlToText, richText, utcIso } from './output/text.ts';
export {
  type CompiledQuery,
  type CompileOptions,
  compileQuery,
  FILTER_OPS,
  type FilterInput,
  type FilterOp,
  MAX_OFFSET,
  type QueryInput,
  recheckFields,
  type SortInput,
} from './query/compiler.ts';
export {
  bindFixed,
  CURSOR_MAX_AGE_MS,
  type CursorFixed,
  type CursorState,
  cursorBinding,
  decodeCursor,
  encodeCursor,
} from './query/cursor.ts';
export { invalid, limitError } from './query/limits.ts';
export { parseInstant, parseTimeRange, type TimeWindow } from './query/time.ts';
export { OTHER_ASSET_RECIPES } from './recipes/other-assets.ts';
export {
  QUALITY_RECIPE_RESOURCES,
  QUALITY_RECIPES,
  type Recipe,
  type RecipeExample,
  renderRecipe,
} from './recipes/quality.ts';
export { isSecretKeyName, REDACTED, redact, redactValue } from './redact.ts';
export {
  collectPropertyNames,
  inputJsonSchema,
  RegistryError,
  SECRET_FIELD_RE,
  ToolRegistry,
} from './registry.ts';
export {
  isTemplate,
  type ListedResource,
  RESOURCE_MANIFEST,
  RESOURCE_SCHEME,
  type ResourceBody,
  type ResourceDefinition,
  type ResourceReader,
} from './resources.ts';
export { BACKLOG_ITEM_QUALITY_RUBRIC, type QualityRubric, type RubricCriterion } from './rubric.ts';
export { Secret } from './secret.ts';
export {
  auditFacts,
  type BuildServerOptions,
  buildMcpServer,
  DEFAULT_SERVER_INFO,
  prewarmToolSchemas,
  type ServerInfo,
  type ToolCallEvent,
  toCallToolResult,
  withCachedJsonSchema,
} from './server.ts';
export {
  annotationsFor,
  defineTool,
  type InputSchema,
  type ToolDefinition,
  type ToolKind,
  type ToolOutput,
} from './tool.ts';
export { CORE_TOOLS } from './tools/index.ts';
export { VERSION } from './version.ts';
