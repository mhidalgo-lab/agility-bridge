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
export { canonicalInstanceUrl } from './agility/instance.ts';
export { CredentialLimiters, Semaphore } from './agility/limiter.ts';
export { parseXml, type XmlElement } from './agility/xml.ts';
export {
  type AssetTypeScope,
  type Breaker,
  type Budget,
  type Clock,
  type Credential,
  closedBreaker,
  createBudget,
  DEFAULT_LIMITS,
  type FetchLike,
  freezeContext,
  type InstanceRef,
  type Limiter,
  type Limits,
  type MetadataServiceRef,
  type ProjectScope,
  type Random,
  systemClock,
  type ToolContext,
  unboundedLimiter,
  webCryptoRandom,
} from './context.ts';
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
  createLogger,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  type LogSink,
  silentLogger,
  stderrSink,
} from './logger.ts';
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
export { isSecretKeyName, REDACTED, redact, redactValue } from './redact.ts';
export {
  collectPropertyNames,
  inputJsonSchema,
  RegistryError,
  SECRET_FIELD_RE,
  ToolRegistry,
} from './registry.ts';
export { Secret } from './secret.ts';
export {
  type BuildServerOptions,
  buildMcpServer,
  DEFAULT_SERVER_INFO,
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
export { VERSION } from './version.ts';
