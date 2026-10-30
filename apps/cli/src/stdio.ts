// SPDX-License-Identifier: Apache-2.0
// stdio mode (P1-11): one MCP connection per process, one fresh context per tool call (ADR-0010, T21). stdout carries
// only MCP frames (L-021): logs go to stderr through the redacting logger.
import {
  AbError,
  ApprovalLedger,
  buildMcpServer,
  CircuitBreakers,
  CORE_TOOLS,
  CredentialLimiters,
  createBudget,
  createLogger,
  createWriteLimiter,
  DEFAULT_LIMITS,
  deprecatedEnv,
  ErrorCode,
  type FetchLike,
  type Logger,
  MetadataService,
  memoryCounterStore,
  memoryLedgerStore,
  PUBLIC_CATALOG_GROUPS,
  QueryCache,
  randomMac,
  Secret,
  type SelectOptions,
  silentLogger,
  stderrSink,
  systemClock,
  type ToolContext,
  type ToolDefinition,
  ToolRegistry,
  type WriteAuditSink,
  type WriteRuntime,
  webCryptoRandom,
} from '@agility-bridge/core';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createNodeFetch } from './agility-fetch.ts';
import { ConfigError, type LoadedConfig, type StdioConfig } from './config.ts';

/** Groups the stdio server can serve (docs/reference/tool-catalogue.md); `query` follows AB_GENERIC_QUERY. */
export const STDIO_GROUPS = [
  'core',
  'query',
  'work',
  'planning',
  'people',
  'collaboration',
  'attachments',
  'portfolio',
  'history',
  'reports',
  'writes',
] as const;

const SETUP_HINT =
  'Set AB_AGILITY_URL (the address you open Agility at) and AB_AGILITY_TOKEN (an access token from the Agility Applications page) in the env block of your MCP client, then restart the server. See docs/guide/configuration.md.';

/** The tools this configuration serves; an unknown name in the allowlist fails startup and lists the valid ones. */
export function selectTools(config: LoadedConfig, extra: readonly ToolDefinition[] = []): ToolDefinition[] {
  const { registry, options } = selection(config, extra);
  return registry.select(options);
}

/** The tools this configuration grants that the per-call budget hides (declared cost above it), for `whoami` (P6-36). */
export function hiddenTools(config: LoadedConfig): Array<{ name: string; cost: number }> {
  if (config.kind === 'setup') return [];
  const { registry, options } = selection(config);
  return registry
    .hiddenByBudget({ ...options, maxCost: config.callBudget })
    .map((t) => ({ name: t.name, cost: t.cost }));
}

function selection(
  config: LoadedConfig,
  extra: readonly ToolDefinition[] = [],
): { registry: ToolRegistry; options: SelectOptions } {
  // Write tools are always registered (so AB_TOOLS can name them) and selected only with AB_WRITE_TOOLS=on below.
  const registry = new ToolRegistry({ allowNonRead: true });
  for (const tool of [...CORE_TOOLS, ...extra]) registry.register(tool);
  if (config.kind === 'setup')
    return {
      registry,
      options: {
        // The same set the public catalogue lists (P8-11): an unconfigured server shows what a registry may see.
        groups: STDIO_GROUPS.filter((g) => PUBLIC_CATALOG_GROUPS.includes(g)),
      },
    };
  const valid = registry.list().map((t) => t.name);
  const unknown = (config.tools ?? []).filter((t) => !valid.includes(t));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown tool${unknown.length === 1 ? '' : 's'} in AB_TOOLS: ${unknown.join(', ')}. Valid tools: ${valid.join(', ')}.`,
    );
  }
  const groups = STDIO_GROUPS.filter(
    (g) =>
      (g !== 'query' || config.genericQuery) &&
      (g !== 'attachments' || config.attachmentDownload) &&
      (g !== 'reports' || config.reports) &&
      (g !== 'writes' || config.writeTools),
  );
  return {
    registry,
    options: {
      groups,
      maxCost: config.callBudget,
      ...(config.tools === undefined ? {} : { allowed: config.tools }),
      // A write tool is offered only with AB_WRITE_TOOLS=on and when AB_TOOLS names it: "every tool" never includes one.
      ...(config.writeTools && config.tools !== undefined
        ? { kinds: ['read', 'write', 'destructive'] as const }
        : {}),
    },
  };
}

export interface StdioServices {
  readonly fetch: FetchLike;
  readonly logger: Logger;
}

/**
 * The write runtime of a stdio process (ADR-0013): an in-process ledger that lives as long as the process, a random
 * per-process key that seals multi round-trip state, and intent and outcome logged to stderr. That log is the whole
 * audit here (no audit table in stdio): documented as weaker than the remote durable rows.
 */
function stdioWrites(config: StdioConfig, logger: Logger, tools: readonly string[]): WriteRuntime {
  const audit: WriteAuditSink = {
    durable: false,
    async intent(record) {
      logger.info('write intent', { ...record });
      return null;
    },
    async outcome(record) {
      logger.info('write outcome', { ...record });
    },
  };
  return {
    approval: config.writeApproval,
    tools,
    actor: { id: 'stdio' },
    ledger: new ApprovalLedger(memoryLedgerStore(systemClock), systemClock),
    audit,
    stateKey: webCryptoRandom.bytes(32),
    // One process, one actor: the grant limit is the process limit and nothing is shared (fails closed like the rest).
    limiter: createWriteLimiter({
      counters: memoryCounterStore(systemClock),
      clock: systemClock,
      limits: { perGrant: config.writeRatePerHour, deployment: null },
      onError: () => logger.error('write limiter failed; the write is refused'),
    }),
  };
}

/** A fresh, complete context for every tool call. */
export function contextFactory(
  config: StdioConfig,
  services: StdioServices,
  tools: readonly ToolDefinition[],
  hiddenByBudget: ReadonlyArray<{ name: string; cost: number }> = [],
): () => ToolContext {
  const limiters = new CredentialLimiters({ concurrency: 5 });
  const breakers = new CircuitBreakers();
  const metadata = new MetadataService();
  // One cache per process (P8-01); entry ids are keyed with a random per-process key and bind the scope of every call.
  const queryCache =
    (config.queryCacheTtlSeconds ?? 0) > 0
      ? new QueryCache({
          ttlMs: (config.queryCacheTtlSeconds ?? 0) * 1000,
          mac: randomMac(),
          clock: systemClock,
          logger: services.logger,
        })
      : undefined;
  const instanceId = config.workspace.id;
  const groups = [...new Set(tools.map((t) => t.group))];
  const writeNames = tools.filter((t) => t.kind !== 'read').map((t) => t.name);
  const writes = writeNames.length === 0 ? undefined : stdioWrites(config, services.logger, writeNames);
  return () => ({
    requestId: webCryptoRandom.uuid(),
    instance: { id: instanceId, baseUrl: config.instanceUrl },
    workspace: {
      id: config.workspace.id,
      name: config.workspace.name,
      groups,
      writes: {
        enabled: writes !== undefined,
        approval: 'unavailable',
        ...(writes !== undefined && config.writeCustomFields.length > 0
          ? { customFields: [...config.writeCustomFields] }
          : {}),
      },
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
      reports: config.reports,
      attachmentMaxBytes: config.attachmentMaxBytes,
      attachmentTypes: config.attachmentTypes,
    },
    budget: createBudget(config.callBudget),
    limiter: limiters.for(instanceId, 'stdio'),
    breaker: breakers.for(instanceId, 'stdio'),
    fetch: services.fetch,
    metadata,
    ...(queryCache === undefined
      ? {}
      : { queryCache: { cache: queryCache, grantId: 'stdio', principal: 'cred:stdio' } }),
    logger: services.logger,
    clock: systemClock,
    random: webCryptoRandom,
    ...(hiddenByBudget.length === 0 ? {} : { hiddenByBudget }),
    ...(writes === undefined ? {} : { writes }),
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
  if (config.kind === 'configured') {
    if (config.writeTools && config.writeApproval === 'off') {
      logger.warn(
        'AB_WRITE_APPROVAL=off: write tools change Agility without asking a person first. Use it only with your own token on your own machine.',
      );
    }
    if (config.writeTools && !tools.some((t) => t.kind !== 'read')) {
      logger.warn('AB_WRITE_TOOLS is on, but AB_TOOLS names no write tool, so none is offered.');
    }
  }
  if (config.kind === 'setup') {
    logger.warn(
      'Not configured: tools are listed, and every call explains how to set AB_AGILITY_URL and AB_AGILITY_TOKEN.',
    );
    const ctx = setupContext(silentLogger);
    return serveStdio(() => buildMcpServer({ tools: setupTools(tools), ctx }));
  }
  const fetch =
    options.fetch ?? createNodeFetch(config.caFile === undefined ? {} : { caFile: config.caFile });
  const ctx = contextFactory(config, { fetch, logger }, tools, hiddenTools(config));
  logger.info('serving', {
    tools: tools.length,
    source: config.source,
    workspace: config.workspace.id,
    projects: config.projects.length,
  });
  return serveStdio(() => buildMcpServer({ tools, ctx }));
}
