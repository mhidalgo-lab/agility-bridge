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
