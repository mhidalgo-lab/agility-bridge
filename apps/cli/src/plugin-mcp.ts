// SPDX-License-Identifier: Apache-2.0
// The Claude Code plugin's `.mcp.json` (plugins/agility-bridge, P8-06). Import-free on purpose: the release script
// (`scripts/release.ts sync-version`) runs it under plain Node to rewrite the file when the version changes.
//
// The plugin prompts for the instance address and a sensitive token (`userConfig` in its manifest) and Claude Code
// substitutes them: nothing secret is ever written in the file. The package version is pinned to the plugin's own.

export const PLUGIN_PATH = 'plugins/agility-bridge';

export function pluginMcpJson(version: string): string {
  // Written out by hand in the shape the repository's formatter keeps, so a formatted file equals the generated one.
  return `{
  "mcpServers": {
    "agility": {
      "command": "npx",
      "args": ["-y", "agility-bridge@${version}"],
      "env": {
        "AB_AGILITY_URL": "\${user_config.agility_url}",
        "AB_AGILITY_TOKEN": "\${user_config.agility_token}"
      }
    }
  }
}
`;
}

/** The Agent Plugins 1.0.0 manifest and MCP configuration at the repository root (P9-29). */
export const AGENT_PLUGIN_MANIFEST = 'plugin.json';
export const AGENT_PLUGIN_MCP = 'mcp.json';
export const AGENT_PLUGINS_SPEC_VERSION = '1.0.0';

/**
 * The root `mcp.json` (Agent Plugins 1.0.0). The spec has no user-input placeholders and forbids secrets in `env`
 * ("visible package data"), so the entry carries none: the client supplies `AB_AGILITY_URL` and `AB_AGILITY_TOKEN`
 * (or `AB_CONFIG`) the way it manages credentials, and the server only lists its tools until it has them. The settings
 * are described under the manifest's `extensions` entry.
 */
export function agentPluginMcpJson(version: string): string {
  return `{
  "$schema": "https://agent-plugins.org/schemas/${AGENT_PLUGINS_SPEC_VERSION}/mcp.schema.json",
  "mcpServers": {
    "agility": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agility-bridge@${version}"]
    }
  }
}
`;
}
