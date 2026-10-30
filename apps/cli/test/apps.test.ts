// SPDX-License-Identifier: Apache-2.0
// P8-03: the stdio setting for MCP Apps views (on by default; `AB_MCP_APPS=off` is the kill switch).
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, type StdioConfig } from '../src/config.ts';

const base = {
  AB_AGILITY_URL: 'https://agility.example.com/SyntheticInstance',
  AB_AGILITY_TOKEN: 'FAKE-token',
};

describe('AB_MCP_APPS on stdio', () => {
  it('is on by default and off with the switch', () => {
    expect((loadConfig(base) as StdioConfig).mcpApps).toBe(true);
    expect((loadConfig({ ...base, AB_MCP_APPS: 'on' }) as StdioConfig).mcpApps).toBe(true);
    expect((loadConfig({ ...base, AB_MCP_APPS: 'off' }) as StdioConfig).mcpApps).toBe(false);
  });

  it('refuses another value, naming the setting', () => {
    try {
      loadConfig({ ...base, AB_MCP_APPS: 'sure-secret' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('AB_MCP_APPS');
    }
  });
});
