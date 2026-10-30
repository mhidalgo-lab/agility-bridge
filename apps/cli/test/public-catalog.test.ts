// SPDX-License-Identifier: Apache-2.0
// P8-11: an unconfigured stdio server lists exactly the public catalogue the HTTP server offers when
// `AB_PUBLIC_TOOL_CATALOG` is on: read-only tools of the default groups, never a write, report or attachment tool.
import { CORE_TOOLS, PUBLIC_CATALOG_GROUPS, publicCatalogTools } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { selectTools } from '../src/stdio.ts';

describe('stdio without configuration', () => {
  it('lists exactly the public catalogue', () => {
    const listed = selectTools(loadConfig({}))
      .map((t) => t.name)
      .sort();
    const catalogue = publicCatalogTools(CORE_TOOLS)
      .map((t) => t.name)
      .sort();
    expect(listed).toEqual(catalogue);
    expect(listed.length).toBeGreaterThan(10);
  });

  it('lists no write, destructive, report or attachment tool', () => {
    const listed = new Set(selectTools(loadConfig({})).map((t) => t.name));
    for (const t of CORE_TOOLS) {
      if (t.kind !== 'read' || !PUBLIC_CATALOG_GROUPS.includes(t.group))
        expect(listed.has(t.name), t.name).toBe(false);
    }
  });

  it('knows the new setting name (no unknown-variable failure)', () => {
    expect(() =>
      loadConfig({
        AB_AGILITY_URL: 'https://agility.example.com/SyntheticInstance',
        AB_AGILITY_TOKEN: 'FAKE-token',
        AB_PUBLIC_TOOL_CATALOG: 'on',
      }),
    ).not.toThrow();
  });
});
