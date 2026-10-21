# agility-bridge

> **Pre-release.** The read-only stdio server works; the first published version is v0.1. Follow progress at
> <https://github.com/mhidalgo-lab/agility-bridge>.

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents work with
**Digital.ai Agility** through its public APIs, using each member's own access token: every asset type, read-only by
default, with opt-in writes approved by a person.

Use is subject to your organisation's Agility license and to Digital.ai's Terms of Use and Acceptable Use Policy. Tool
results are sent to whatever model your MCP client uses.

## Quick start

Add agility-bridge to your MCP client with your instance and access token in its `env` block:

```json
{
  "mcpServers": {
    "agility": {
      "command": "npx",
      "args": ["-y", "agility-bridge"],
      "env": {
        "AB_AGILITY_URL": "https://www7.v1host.com/YourInstance",
        "AB_AGILITY_TOKEN": "<your access token>"
      }
    }
  }
}
```

Every setting: [configuration guide](https://github.com/mhidalgo-lab/agility-bridge/blob/main/docs/guide/configuration.md).

## Disclaimer

agility-bridge is an unofficial, community project. It is not affiliated with, endorsed by, or supported by Digital.ai.
Digital.ai, Agility and VersionOne are trademarks of their respective owners.

## License

Apache-2.0
