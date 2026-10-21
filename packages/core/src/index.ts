// SPDX-License-Identifier: Apache-2.0
// Public surface of @agility-bridge/core (P1-01): contracts every tool and host relies on.
export {
  type AssetTypeScope,
  type Budget,
  type Clock,
  type Credential,
  createBudget,
  DEFAULT_LIMITS,
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
