// SPDX-License-Identifier: Apache-2.0
// Write tools in stdio mode (P7-01, ADR-0013): AB_WRITE_TOOLS, AB_WRITE_APPROVAL and what the process gives the write
// pipeline (in-process ledger, stderr audit). Off unless asked for; "all tools" never includes a write tool.
import { createLogger, type Logger, type ToolDefinition } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import { FakeItems, makeTestWriteTool, TEST_TOOL } from '../../../packages/core/test/helpers/writes.ts';
import { ConfigError, loadConfig, type StdioConfig } from '../src/config.ts';
import { contextFactory, selectTools } from '../src/stdio.ts';

const URL = 'https://agility.example.com/SyntheticInstance';
const base = { AB_AGILITY_URL: URL, AB_AGILITY_TOKEN: 'FAKE-token' };
const write = (): ToolDefinition => makeTestWriteTool(new FakeItems());
const configured = (env: Record<string, string>): StdioConfig => {
  const c = loadConfig({ ...base, ...env });
  if (c.kind !== 'configured') throw new Error('expected a configured server');
  return c;
};

describe('configuration', () => {
  it('keeps writes off and approval required by default', () => {
    expect(configured({})).toMatchObject({ writeTools: false, writeApproval: 'required' });
  });

  it('reads AB_WRITE_TOOLS and AB_WRITE_APPROVAL and refuses other values', () => {
    expect(configured({ AB_WRITE_TOOLS: 'on', AB_WRITE_APPROVAL: 'off' })).toMatchObject({
      writeTools: true,
      writeApproval: 'off',
    });
    expect(() => loadConfig({ ...base, AB_WRITE_APPROVAL: 'sometimes' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, AB_WRITE_TOOLS: 'maybe' })).toThrow(ConfigError);
  });
});

describe('tool selection', () => {
  const names = (env: Record<string, string>) => selectTools(configured(env), [write()]).map((t) => t.name);

  it('never offers a write tool unless AB_WRITE_TOOLS is on and AB_TOOLS names it', () => {
    expect(names({})).not.toContain(TEST_TOOL);
    expect(names({ AB_TOOLS: `whoami,${TEST_TOOL}` })).not.toContain(TEST_TOOL);
    expect(names({ AB_WRITE_TOOLS: 'on' })).not.toContain(TEST_TOOL);
    expect(names({ AB_WRITE_TOOLS: 'on', AB_TOOLS: 'whoami' })).not.toContain(TEST_TOOL);
    expect(names({ AB_WRITE_TOOLS: 'on', AB_TOOLS: `whoami,${TEST_TOOL}` })).toContain(TEST_TOOL);
  });
});

describe('the process write runtime', () => {
  const lines: string[] = [];
  const logger: Logger = createLogger({ sink: (l) => lines.push(l), level: 'debug' });
  const ctxFor = (env: Record<string, string>) => {
    const config = configured(env);
    const tools = selectTools(config, [write()]);
    return contextFactory(config, { fetch: () => Promise.reject(new Error('no network')), logger }, tools)();
  };

  it('has no write runtime without writes', () => {
    const ctx = ctxFor({});
    expect(ctx.writes).toBeUndefined();
    expect(ctx.workspace.writes.enabled).toBe(false);
  });

  it('gives the pipeline a ledger, a per-process key, an stderr audit and the approval mode', async () => {
    const ctx = ctxFor({ AB_WRITE_TOOLS: 'on', AB_TOOLS: `whoami,${TEST_TOOL}` });
    expect(ctx.writes).toMatchObject({ approval: 'required', tools: [TEST_TOOL], actor: { id: 'stdio' } });
    expect(ctx.writes?.audit.durable).toBe(false);
    expect(ctx.writes?.stateKey.length).toBe(32);
    expect(ctx.workspace.writes.enabled).toBe(true);
    expect(ctx.credential.kind).toBe('personal');
    // The audit is a log line (stderr), and holds no value.
    await ctx.writes?.audit.intent({
      phase: 'intent',
      requestId: 'r',
      tool: TEST_TOOL,
      operation: 'update_status',
      actor: { id: 'stdio' },
      workspaceId: 'default',
      instanceId: 'default',
      hash: 'a'.repeat(64),
      target: { assetType: 'Story', oid: 'Story:1' },
      fields: ['Status'],
      approval: 'not_required',
    });
    expect(lines.join('\n')).toContain('write intent');
    // Two calls share the ledger and the key (one process) but not the context.
    const again = ctxFor({ AB_WRITE_TOOLS: 'on', AB_TOOLS: `whoami,${TEST_TOOL}` });
    expect(again.requestId).not.toBe(ctx.requestId);
  });

  it('carries AB_WRITE_APPROVAL=off into the runtime', () => {
    const ctx = ctxFor({ AB_WRITE_TOOLS: 'on', AB_WRITE_APPROVAL: 'off', AB_TOOLS: `whoami,${TEST_TOOL}` });
    expect(ctx.writes?.approval).toBe('off');
  });
});
