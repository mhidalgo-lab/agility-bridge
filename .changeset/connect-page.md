---
'agility-bridge': minor
---

Connect page (P4-06): every grant has a "Connect a client" page in the admin panel (under My access for the person who holds
it, and on the grant for owners and admins) with the workspace's MCP endpoint and a copy-paste configuration for GitHub Copilot
in VS Code, JetBrains and the CLI, Claude Code, Cursor, Windsurf / Devin Desktop and the MCP Inspector. The page never holds a
token; the one-time page that creates a device token repeats the snippets and fills the token in only where a client cannot read
it from a prompt or an environment variable. The client setup guide gains the same remote snippets.
