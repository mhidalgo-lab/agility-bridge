// SPDX-License-Identifier: Apache-2.0
// stdio mode (P1-11): one MCP connection per process, one fresh context per tool call (ADR-0010, T21). stdout carries
// only MCP frames (L-021): logs go to stderr through the redacting logger.
import {
  AbError,
  buildMcpServer,
  CircuitBreakers,
  CORE_TOOLS,
  CredentialLimiters,
  createBudget,
  createLogger,
  DEFAULT_LIMITS,
  deprecatedEnv,
  ErrorCode,
  type FetchLike,
  type Logger,
  MetadataService,
  Secret,
  silentLogger,
  stderrSink,
  systemClock,
  type ToolContext,
  type ToolDefinition,
  ToolRegistry,
  webCryptoRandom,
} from '@agility-bridge/core';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createNodeFetch } from './agility-fetch.ts';
import { ConfigError, type LoadedConfig, type StdioConfig } from './config.ts';

/** Groups served in Phase 1 (docs/reference/tool-catalogue.md); `query` follows AB_GENERIC_QUERY. */
export const STDIO_GROUPS = [
  'core',
  'query',
  'work',
  'planning',
  'people',
  'collaboration',
  'attachments',
] as const;

const SETUP_HINT =
  'Set AB_AGILITY_URL (the address you open Agility at) and AB_AGILITY_TOKEN (an access token from the Agility Applications page) in the env block of your MCP client, then restart the server. See docs/guide/configuration.md.';

/** The tools this configuration serves; an unknown name in the allowlist fails startup and lists the valid ones. */
export function selectTools(config: LoadedConfig): ToolDefinition[] {
  const registry = new ToolRegistry();
  for (const tool of CORE_TOOLS) registry.register(tool);
  if (config.kind === 'setup')
    return registry.select({ groups: STDIO_GROUPS.filter((g) => g !== 'attachments') });
  const valid = registry.list().map((t) => t.name);
  const unknown = (config.tools ?? []).filter((t) => !valid.includes(t));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown tool${unknown.length === 1 ? '' : 's'} in AB_TOOLS: ${unknown.join(', ')}. Valid tools: ${valid.join(', ')}.`,
    );
  }
  const groups = STDIO_GROUPS.filter(
    (g) => (g !== 'query' || config.genericQuery) && (g !== 'attachments' || config.attachmentDownload),
  );
  return registry.select({
    groups,
    maxCost: config.callBudget,
    ...(config.tools === undefined ? {} : { allowed: config.tools }),
  });
}

export interface StdioServices {
  readonly fetch: FetchLike;
  readonly logger: Logger;
}

/** A fresh, complete context for every tool call. */
export function contextFactory(
  config: StdioConfig,
  services: StdioServices,
  tools: readonly ToolDefinition[],
): () => ToolContext {
  const limiters = new CredentialLimiters({ concurrency: 5 });
  const breakers = new CircuitBreakers();
  const metadata = new MetadataService();
  const instanceId = config.workspace.id;
  const groups = [...new Set(tools.map((t) => t.group))];
  return () => ({
    requestId: webCryptoRandom.uuid(),
    instance: { id: instanceId, baseUrl: config.instanceUrl },
    workspace: {
      id: config.workspace.id,
      name: config.workspace.name,
      groups,
      writes: { enabled: false, approval: 'unavailable' },
    },
    credential: { id: 'stdio', kind: 'personal', token: config.token },
    projects: { allowed: [...config.projects], includeChildren: config.includeChildProjects },
    assetTypes: {
      ...(config.assetTypes.allow === undefined ? {} : { allow: [...config.assetTypes.allow] }),
      deny: [...config.assetTypes.deny],
    },
    limits: {
      ...DEFAULT_LIMITS,
      maxRows: config.maxRows,
      maxResponseBytes: config.maxResponseBytes,
      memberEmails: config.memberEmails,
      attachmentDownload: config.attachmentDownload,
      attachmentMaxBytes: config.attachmentMaxBytes,
      attachmentTypes: config.attachmentTypes,
    },
    budget: createBudget(config.callBudget),
    limiter: limiters.for(instanceId, 'stdio'),
    breaker: breakers.for(instanceId, 'stdio'),
    fetch: services.fetch,
    metadata,
    logger: services.logger,
    clock: systemClock,
    random: webCryptoRandom,
  });
}

/** Tools that answer every call with setup guidance (no configuration at all). */
function setupTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.map((t) => ({
    ...t,
    handler: async () => {
      throw new AbError(ErrorCode.AuthUnauthorized, 'agility-bridge is not configured yet.', {
        hint: SETUP_HINT,
      });
    },
  }));
}

function setupContext(logger: Logger): ToolContext {
  return {
    requestId: webCryptoRandom.uuid(),
    instance: { id: 'unconfigured', baseUrl: 'https://agility.invalid' },
    workspace: {
      id: 'unconfigured',
      name: 'Not configured',
      groups: [],
      writes: { enabled: false, approval: 'unavailable' },
    },
    credential: { id: 'none', kind: 'personal', token: new Secret('') },
    projects: { allowed: [], includeChildren: true },
    assetTypes: { deny: [] },
    limits: DEFAULT_LIMITS,
    budget: createBudget(0),
    limiter: new CredentialLimiters().for('unconfigured', 'none'),
    breaker: new CircuitBreakers().for('unconfigured', 'none'),
    fetch: () => Promise.reject(new Error('not configured')),
    logger,
    clock: systemClock,
    random: webCryptoRandom,
  };
}

export interface StartOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: FetchLike;
  readonly sink?: (line: string) => void;
}

/** Starts serving MCP on stdin/stdout. Throws ConfigError before anything is served. */
export function startStdio(config: LoadedConfig, options: StartOptions): { close(): Promise<void> } {
  const logger = createLogger({
    level: config.logLevel,
    sink: options.sink ?? stderrSink,
    fields: { mode: 'stdio' },
  });
  for (const d of deprecatedEnv(options.env)) {
    logger.warn(
      `${d.name} is deprecated${d.replacement === undefined ? '' : `; use ${d.replacement}`}. It is removed in ${d.removeIn}.`,
    );
  }
  const tools = selectTools(config);
  if (config.kind === 'setup') {
    logger.warn(
      'Not configured: tools are listed, and every call explains how to set AB_AGILITY_URL and AB_AGILITY_TOKEN.',
    );
    const ctx = setupContext(silentLogger);
    return serveStdio(() => buildMcpServer({ tools: setupTools(tools), ctx }));
  }
  const fetch =
    options.fetch ?? createNodeFetch(config.caFile === undefined ? {} : { caFile: config.caFile });
  const ctx = contextFactory(config, { fetch, logger }, tools);
  logger.info('serving', {
    tools: tools.length,
    source: config.source,
    workspace: config.workspace.id,
    projects: config.projects.length,
  });
  return serveStdio(() => buildMcpServer({ tools, ctx }));
}
