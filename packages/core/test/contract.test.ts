// SPDX-License-Identifier: Apache-2.0
// MCP contract of the catalogue (P1-12): what tools/list shows, its count and size budgets. Tool tasks extend the
// snapshot when they add a tool; P1-13 adds the naming and description lints.
import { describe, expect, it } from 'vitest';
import { CORE_TOOLS } from '../src/tools/index.ts';
import {
  DEFAULT_CATALOGUE_MAX_BYTES,
  DEFAULT_CATALOGUE_MAX_TOOLS,
  toolsListContract,
} from './harness/index.ts';

describe('tools/list contract', () => {
  it('stays within the default catalogue budgets', async () => {
    const contract = await toolsListContract(CORE_TOOLS);
    expect(contract.count).toBeLessThanOrEqual(DEFAULT_CATALOGUE_MAX_TOOLS);
    expect(contract.bytes).toBeLessThanOrEqual(DEFAULT_CATALOGUE_MAX_BYTES);
  });

  it('lists exactly the catalogue, with derived annotations', async () => {
    const contract = await toolsListContract(CORE_TOOLS);
    expect(contract.tools.map((t) => ({ name: t.name, annotations: t.annotations }))).toMatchInlineSnapshot(
      `
      [
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Who am I",
          },
          "name": "whoami",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "List Agility projects",
          },
          "name": "list_projects",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "List asset types",
          },
          "name": "list_asset_types",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Describe an asset type",
          },
          "name": "describe_asset_type",
        },
      ]
    `,
    );
  });

  // The first conventions checks; P1-13 turns them into the full naming and description lints.
  it.each(CORE_TOOLS.map((t) => [t.name, t] as const))(
    '%s follows the naming and description conventions',
    (_n, tool) => {
      expect(tool.name).toMatch(/^(?:list|search|get|query|describe)_[a-z0-9_]+$|^whoami$/);
      expect(tool.description.length).toBeLessThanOrEqual(450);
      expect(tool.description).not.toMatch(/^(?:This tool|Use this|A tool)/i);
      expect(tool.description).toMatch(/Paged: pass nextCursor back as cursor\.|Not paged\./);
      if (tool.cost >= 8) expect(tool.description).toMatch(/\d+ Agility requests/);
      const shape = (tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      for (const arg of Object.keys(shape)) expect(arg).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
    },
  );
});
