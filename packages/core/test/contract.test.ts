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
      `[]`,
    );
  });
});
