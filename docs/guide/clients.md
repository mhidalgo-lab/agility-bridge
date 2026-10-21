# Client setup

Every client starts the same local server: `npx -y agility-bridge` with `AB_AGILITY_URL` and `AB_AGILITY_TOKEN` in its
environment ([quickstart](quickstart-local.md) explains both). Secrets go in the client's `env` block, never in flags
(they leak through process listings, L-026). Where the client can keep the token out of plain-text files, the snippet
does so. What each client supports is tracked in [client compatibility](../reference/client-compatibility.md); this page
says which snippets were verified, with the client version and the date.

After upgrading agility-bridge, restart or reconnect the server in your client: clients cache the tool list (L-027).

## GitHub Copilot in VS Code

`.vscode/mcp.json` in the workspace (or *MCP: Open User Configuration* for every workspace). VS Code asks for the token
once and stores it in its secret storage:

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

With VS Code connected to WSL, the server runs inside WSL: install Node 24 there.

## Claude Code

`.mcp.json` in the project (shared with the repository, so the token stays in your environment):

```json
{
  "mcpServers": {
    "agility": {
      "command": "npx",
      "args": ["-y", "agility-bridge"],
      "env": {
        "AB_AGILITY_URL": "https://www7.v1host.com/YourInstance",
        "AB_AGILITY_TOKEN": "${AGILITY_TOKEN}"
      }
    }
  }
}
```

Claude Code expands `${AGILITY_TOKEN}` from the environment it was started in. For every project at once, add it to
your user configuration instead (`claude mcp add agility --scope user -e AB_AGILITY_URL=… -e AB_AGILITY_TOKEN=… -- npx -y
agility-bridge`); that command stores the token in plain text in `~/.claude.json`. Check with `/mcp`.

## GitHub Copilot CLI

`~/.copilot/mcp-config.json` (or `/mcp add` inside the CLI):

```json
{
  "mcpServers": {
    "agility": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "agility-bridge"],
      "env": {
        "AB_AGILITY_URL": "https://www7.v1host.com/YourInstance",
        "AB_AGILITY_TOKEN": "<your access token>"
      },
      "tools": ["*"]
    }
  }
}
```

The file holds the token in plain text: keep it readable only by you (`chmod 600 ~/.copilot/mcp-config.json`).

## GitHub Copilot in JetBrains IDEs

*Settings → Tools → GitHub Copilot → Model Context Protocol → Configure* opens `mcp.json`:

```json
{
  "servers": {
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

The IDE stores the file in plain text. With the IDE on Windows and Node in WSL, run the server through
`wsl.exe` (`"command": "wsl.exe"`, `"args": ["npx", "-y", "agility-bridge"]`) and pass the variables with `WSLENV`, or
use the remote server once Phase 2 ships.

## Claude Desktop

*Settings → Developer → Edit Config* opens `claude_desktop_config.json`; add the `mcpServers` entry from the Claude Code
section with the token written in place of `${AGILITY_TOKEN}`, then restart Claude Desktop. The file is plain text.
Claude Desktop cannot start a server inside WSL; on Windows install Node 24 on Windows itself.

## Cursor and Windsurf

Both read the same `mcpServers` shape as Claude Code: Cursor in `~/.cursor/mcp.json` (or `.cursor/mcp.json`), Windsurf
in `~/.codeium/windsurf/mcp_config.json`. Cursor shows at most 40 tools across all servers; agility-bridge offers 13.
Not verified yet (no subscription available to the maintainers): reports through the client-compatibility issue
template are welcome.

## MCP Inspector (testing)

<!-- doc-test -->
```sh
npx -y agility-bridge --help
```

```sh
npx -y @modelcontextprotocol/inspector --cli -e AB_AGILITY_URL=https://www7.v1host.com/YourInstance \
  -e AB_AGILITY_TOKEN="$AGILITY_TOKEN" npx -y agility-bridge --method tools/list
```

## Remote (Phase 2 onwards)

A shared agility-bridge server (`agility-bridge serve`, Docker or Cloudflare) gives every member one URL per workspace
with a device token or OAuth sign-in; this page gains those snippets when it ships.
