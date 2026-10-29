// SPDX-License-Identifier: Apache-2.0
// MCP contract of the catalogue (P1-12): what tools/list shows, its count and size budgets. Tool tasks extend the
// snapshot when they add a tool; the naming, description and schema lints are in lint.test.ts (P1-13).
import { describe, expect, it } from 'vitest';
import { buildMcpServer, createBudget, MetadataService } from '../src/index.ts';
import { CORE_TOOLS } from '../src/tools/index.ts';
import snapshotJson from './fixtures/agility/meta-snapshot.json' with { type: 'json' };
import {
  DEFAULT_CATALOGUE_MAX_BYTES,
  DEFAULT_CATALOGUE_MAX_TOOLS,
  DEFAULT_CATALOGUE_TARGET_BYTES,
  defaultCatalogue,
  FakeAgility,
  FULL_CATALOGUE_MAX_BYTES,
  makeContext,
  TOOL_MAX_BYTES,
  toolsListContract,
} from './harness/index.ts';
import { rpc } from './helpers/mcp.ts';

describe('tools/list contract', () => {
  it('stays within the default catalogue budgets', async () => {
    // Opt-in groups (attachments, reports, writes) count only against the full-catalogue budget below.
    const contract = await toolsListContract(defaultCatalogue(CORE_TOOLS));
    expect(contract.count).toBeLessThanOrEqual(DEFAULT_CATALOGUE_MAX_TOOLS);
    expect(contract.bytes).toBeLessThanOrEqual(DEFAULT_CATALOGUE_MAX_BYTES);
  });

  it('keeps real headroom: the default catalogue under its target, no tool above the per-tool cap (P6-12)', async () => {
    const contract = await toolsListContract(defaultCatalogue(CORE_TOOLS));
    expect(contract.bytes).toBeLessThanOrEqual(DEFAULT_CATALOGUE_TARGET_BYTES);
    const all = await toolsListContract(CORE_TOOLS);
    for (const t of all.tools)
      expect(t.bytes, `${t.name} is ${t.bytes} bytes`).toBeLessThanOrEqual(TOOL_MAX_BYTES);
  });

  it('counts: every read group plus the nine planned Phase 7 write tools stays below 40 tools (L-155)', async () => {
    const all = await toolsListContract(CORE_TOOLS);
    const PLANNED_WRITE_TOOLS = 9;
    expect(all.count + PLANNED_WRITE_TOOLS).toBeLessThan(40);
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
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Query assets",
          },
          "name": "query_assets",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Get assets",
          },
          "name": "get_assets",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Search work items",
          },
          "name": "search_work_items",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Get a work item",
          },
          "name": "get_work_item",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "List my work",
          },
          "name": "list_my_work",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "List teams",
          },
          "name": "list_teams",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Get a team",
          },
          "name": "get_team",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "List sprints",
          },
          "name": "list_sprints",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Get a sprint",
          },
          "name": "get_sprint",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Get velocity",
          },
          "name": "get_velocity",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "List members",
          },
          "name": "list_members",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Get asset history",
          },
          "name": "get_asset_history",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "List recent changes",
          },
          "name": "list_recent_changes",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Get comments on an asset",
          },
          "name": "get_conversations",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "List attachments and links of an asset",
          },
          "name": "list_attachments",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Get the text of an attachment",
          },
          "name": "get_attachment",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "List portfolio items",
          },
          "name": "list_portfolio_items",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Get a portfolio tree",
          },
          "name": "get_portfolio_tree",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Sprint health",
          },
          "name": "sprint_health",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Standup summary",
          },
          "name": "standup_summary",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Release readiness",
          },
          "name": "release_readiness",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Defect triage",
          },
          "name": "defect_triage",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Work item quality",
          },
          "name": "work_item_quality",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
            "readOnlyHint": true,
            "title": "Quality scan",
          },
          "name": "quality_scan",
        },
      ]
    `,
    );
  });

  // The first conventions checks; P1-13 turns them into the full naming and description lints.
  it.each(CORE_TOOLS.map((t) => [t.name, t] as const))(
    '%s follows the naming and description conventions',
    (_n, tool) => {
      expect(tool.name).toMatch(
        /^(?:list|search|get|query|describe)_[a-z0-9_]+$|^(?:whoami|sprint_health|standup_summary|release_readiness|defect_triage|work_item_quality|quality_scan)$/,
      );
      expect(tool.description.length).toBeLessThanOrEqual(450);
      expect(tool.description).not.toMatch(/^(?:This tool|Use this|A tool)/i);
      expect(tool.description).toMatch(/Paged: pass nextCursor back as cursor\.|Not paged\./);
      if (tool.cost >= 8) expect(tool.description).toMatch(/\d+ Agility requests/);
      const shape = (tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      for (const arg of Object.keys(shape)) expect(arg).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
    },
  );

  it('stays within the budget with every optional group (writes and reports join in later phases)', async () => {
    const contract = await toolsListContract(CORE_TOOLS);
    expect(contract.bytes).toBeLessThanOrEqual(FULL_CATALOGUE_MAX_BYTES);
    expect(contract.count).toBeLessThan(40);
  });

  it('is static: instance metadata never reaches tool definitions (THREAT_MODEL A12)', async () => {
    const before = JSON.stringify(
      await rpc(() => buildMcpServer({ tools: CORE_TOOLS, ctx: makeContext() }), 'tools/list'),
    );
    // Load an instance's metadata, custom fields and statuses through the tools, then list again.
    const fake = new FakeAgility({
      meta: snapshotJson as unknown as Record<string, unknown>,
      assets: { StoryStatus: [{ _oid: 'StoryStatus:1', Name: 'Synthetic Ready For Review', Order: 1 }] },
    });
    const ctx = makeContext({
      fetch: fake.fetch,
      metadata: new MetadataService(),
      budget: createBudget(100),
    });
    await rpc(() => buildMcpServer({ tools: CORE_TOOLS, ctx }), 'tools/call', {
      name: 'describe_asset_type',
      arguments: { asset_type: 'Story' },
    });
    const after = JSON.stringify(await rpc(() => buildMcpServer({ tools: CORE_TOOLS, ctx }), 'tools/list'));
    expect(after).toBe(before);
    expect(after).not.toMatch(/Custom_|Synthetic Ready|v1host|example\.com/);
  });
});
