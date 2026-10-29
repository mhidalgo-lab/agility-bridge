// SPDX-License-Identifier: Apache-2.0
// The write group in the catalogue (P7-01, L-022, L-105): kept out of the default catalogue, inside the budgets with
// the group enabled, and shaped like the tool conventions ask.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_TOOLS, defineWriteTool, ToolRegistry } from '../../src/index.ts';
import {
  DEFAULT_CATALOGUE_MAX_BYTES,
  defaultCatalogue,
  FULL_CATALOGUE_MAX_BYTES,
  TOOL_MAX_BYTES,
  toolsListContract,
} from '../harness/index.ts';
import { FakeItems, makeTestWriteTool } from '../helpers/writes.ts';

describe('the write group in tools/list', () => {
  const write = makeTestWriteTool(new FakeItems());

  it('is not part of the default catalogue', async () => {
    expect(defaultCatalogue([...CORE_TOOLS, write])).toEqual(defaultCatalogue(CORE_TOOLS));
    const contract = await toolsListContract(defaultCatalogue([...CORE_TOOLS, write]));
    expect(contract.bytes).toBeLessThanOrEqual(DEFAULT_CATALOGUE_MAX_BYTES);
  });

  it('stays within the every-group budget with the write group enabled', async () => {
    const contract = await toolsListContract([...CORE_TOOLS, write]);
    expect(contract.bytes).toBeLessThanOrEqual(FULL_CATALOGUE_MAX_BYTES);
    expect(contract.count).toBeLessThan(40);
    const mine = contract.tools.find((t) => t.name === write.name);
    expect(mine?.bytes).toBeLessThanOrEqual(TOOL_MAX_BYTES);
    // The framework adds dry_run and confirm: a few hundred bytes per write tool, budgeted.
    expect(mine?.bytes ?? 0).toBeLessThan(1_200);
  });

  it('is derived from the tool kind: write annotations, never read-only', async () => {
    const contract = await toolsListContract([write]);
    expect(contract.tools[0]?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });

  it('is never selected unless the caller asks for write kinds by name (registry default is read only)', () => {
    const r = new ToolRegistry({ allowNonRead: true }).register(write);
    expect(r.select()).toEqual([]);
    expect(r.select({ allowed: [write.name] })).toEqual([]);
    expect(r.select({ allowed: [write.name], kinds: ['read', 'write'] }).map((t) => t.name)).toEqual([
      write.name,
    ]);
  });

  it('refuses a spec that declares dry_run or confirm itself', () => {
    expect(() =>
      defineWriteTool({
        name: 'update_x',
        title: 'x',
        description: 'Update something in a test.',
        kind: 'write',
        cost: 1,
        inputSchema: z.object({ confirm: z.boolean() }),
        allowedFields: { Story: ['Status'] },
        plan: async () => {
          throw new Error('unused');
        },
        send: async () => ({}),
      }),
    ).toThrow(/added by the write framework/);
  });
});
