# agility-bridge for Claude Code

A Claude Code plugin for [agility-bridge](https://github.com/mhidalgo-lab/agility-bridge), an unofficial MCP server for
Digital.ai Agility. It adds the MCP server (started with `npx`, Node 24), four commands and two skills.

```text
/plugin marketplace add mhidalgo-lab/agility-bridge
/plugin install agility-bridge@agility-bridge
```

Claude Code asks for your instance address and an Agility access token when you enable it; the token is stored in your
system's credential store, not in a file. Check with `/mcp`.

| Command | What it does |
|---|---|
| `/agility-bridge:my-work` | Your open work, by sprint and status |
| `/agility-bridge:find-item` | Open an item by number, or search by words |
| `/agility-bridge:sprint-status` | How a sprint is going |
| `/agility-bridge:standup` | A standup update from the data |

Everything is read-only unless you turn write tools on (and then each change needs your approval). The package version the
plugin starts is pinned to the plugin's own version; after an update, reconnect the server (clients cache tool lists).

Use is subject to your organisation's Agility license and Digital.ai's terms; tool results go to the model your client
uses. The source of truth for this plugin's `.mcp.json` is `apps/cli/src/client-snippets.ts`; do not edit it by hand.
