# Quickstart (local)

From an Agility access token to an agent that reads your Agility work, in about five minutes. agility-bridge runs on
your machine, started by your MCP client; it needs Node.js 24 or later (`node --version`).

## 1. Create an access token

1. In Agility, open your avatar menu → **Applications** and add an access token.
2. Name it `agility-bridge` and copy it: Agility shows it only once.

The token acts fully as you and **does not expire**: revoke it on the same page when you no longer need it. agility-bridge
never changes Agility in this version (every tool is read-only).

You also need your **instance URL**: the address you open Agility at, up to the instance name, e.g.
`https://www7.v1host.com/YourInstance` (no `/Default.aspx`, no login page).

## 2. Check that it runs

<!-- doc-test -->
```sh
npx -y agility-bridge --version
```

## 3. Add it to your client

Add a server named `agility` that runs `npx -y agility-bridge` with two environment variables, `AB_AGILITY_URL` and
`AB_AGILITY_TOKEN`. In VS Code (GitHub Copilot), with the token asked once and stored by VS Code instead of written in a
file, create `.vscode/mcp.json`:

```json
{
  "inputs": [{ "type": "promptString", "id": "agility-token", "description": "Agility access token", "password": true }],
  "servers": {
    "agility": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agility-bridge"],
      "env": {
        "AB_AGILITY_URL": "https://www7.v1host.com/YourInstance",
        "AB_AGILITY_TOKEN": "${input:agility-token}"
      }
    }
  }
}
```

Every other client (Claude Code, Copilot CLI, JetBrains, Claude Desktop, Cursor, Windsurf):
[client setup](clients.md).

## 4. Try it

Ask your agent:

- "Who am I connected as in Agility?" (`whoami`)
- "List my open work in Agility." (`list_my_work`)
- "Show B-01234 with its acceptance criteria." (`get_work_item`)
- "Which defects are in progress in the current sprint?" (`search_work_items`)

To keep the agent inside some Agility projects, add `AB_PROJECTS` (`Scope:1234,Scope:5678`); every setting is in the
[configuration guide](configuration.md).

## Privacy

Tool results (work-item names, descriptions, comments, member names) are sent to the model your MCP client uses, under
that client's terms. agility-bridge marks Agility text as untrusted data for the model, never sends member emails unless
you enable them, and logs only to your machine's stderr, with tokens redacted.

Something not working? [Troubleshooting](troubleshooting.md).
