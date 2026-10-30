# Client setup

Every client starts the same local server: `npx -y agility-bridge` with `AB_AGILITY_URL` and `AB_AGILITY_TOKEN` in its
environment ([quickstart](quickstart-local.md) explains both). Secrets go in the client's `env` block, never in flags
(they leak through process listings, L-026). Where the client can keep the token out of plain-text files, the snippet
does so. What each client supports is tracked in [client compatibility](../reference/client-compatibility.md); this page
says which snippets were verified, with the client version and the date.

Where a client's configuration file would hold the token in plain text, you can write `"AB_AGILITY_TOKEN": "keychain:agility-token"`
instead and keep the token in the operating system's keychain (`agility-bridge keychain set agility-token`; see
[secrets](secrets.md#keeping-secrets-in-the-os-keychain)).

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
use the [remote server](#remote-server-device-token).

## Claude Desktop

*Settings → Developer → Edit Config* opens `claude_desktop_config.json`; add the `mcpServers` entry from the Claude Code
section with the token written in place of `${AGILITY_TOKEN}`, then restart Claude Desktop. The file is plain text.
Claude Desktop cannot start a server inside WSL; on Windows install Node 24 on Windows itself.

## Cursor and Windsurf

Both read the same `mcpServers` shape as Claude Code: Cursor in `~/.cursor/mcp.json` (or `.cursor/mcp.json`), Windsurf
in `~/.config/devin/mcp_config.json` (formerly `~/.codeium/windsurf/mcp_config.json`). Cursor shows at most 40 tools across all servers; agility-bridge offers 13.
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

## Remote server (device token)

A shared agility-bridge server (`agility-bridge serve`, Docker or Cloudflare) gives every member one URL per workspace:
`https://<host>/w/<workspace>/mcp`, with a **device token** in an `Authorization: Bearer` header. The
[admin panel](admin-panel.md) generates the snippets below for your grant: open *My access*, pick the grant and choose
*Connect a client* (owners and admins find the same page on the grant). Create one device token per device; the token is
shown once, on the page that creates it.

The snippets use the placeholders `my-team` and `https://agility-bridge.example.com`: the panel fills in your workspace and
the server's configured public address. A token is never part of a snippet except for JetBrains, which can neither prompt
for it nor read it from a variable; the panel fills it in there only on the one-time page right after you create it. The
other snippets read it from a password prompt (VS Code) or from the `AGILITY_BRIDGE_TOKEN` environment variable. The
address must be `https`.

Clients that need OAuth (claude.ai on the web, Claude Desktop connectors and Claude mobile) have no snippet: they take the
workspace address in their own connector screen ([connect claude.ai and a phone](oauth-phone.md)). IDEs and CLIs can also
sign in with OAuth instead of a token ([connect an IDE or CLI](oauth-ides.md)). Formats follow each vendor's documentation (checked 2026-10-23, see the
[client matrix](../reference/client-compatibility.md#remote-snippets-p4-06)); the owner's runs against `serve` are
recorded there too.

### GitHub Copilot in VS Code

.vscode/mcp.json, or "MCP: Open User Configuration" for every workspace.

<!-- snippet: vscode -->
```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "agility-bridge-token",
      "description": "agility-bridge device token",
      "password": true
    }
  ],
  "servers": {
    "agility-my-team": {
      "type": "http",
      "url": "https://agility-bridge.example.com/w/my-team/mcp",
      "headers": {
        "Authorization": "Bearer ${input:agility-bridge-token}"
      }
    }
  }
}
```

- VS Code asks for the token once and keeps it in its secret storage, out of the file.
- Servers that use ${input:…} are not forwarded to Copilot agent sessions started outside the editor: use the user configuration there.

### GitHub Copilot in JetBrains IDEs

Settings > Tools > GitHub Copilot > Model Context Protocol > Configure (mcp.json).

<!-- snippet: jetbrains -->
```json
{
  "servers": {
    "agility-my-team": {
      "url": "https://agility-bridge.example.com/w/my-team/mcp",
      "requestInit": {
        "headers": {
          "Authorization": "Bearer ab_<your device token>"
        }
      }
    }
  }
}
```

- This client cannot read the token from a variable or a prompt: paste it in place of the placeholder when you create it.
- Use a short lifetime for this device token: the IDE stores the file unencrypted.

### GitHub Copilot CLI

Run in a terminal on the device (bash or zsh).

<!-- snippet: copilot-cli -->
```sh
read -rs AGILITY_BRIDGE_TOKEN   # paste the token, press Enter: nothing is echoed or kept in history
export AGILITY_BRIDGE_TOKEN
copilot mcp add --transport http --header "Authorization: Bearer $AGILITY_BRIDGE_TOKEN" \
  agility-my-team https://agility-bridge.example.com/w/my-team/mcp
```

- The command writes the header, with the token, to ~/.copilot/mcp-config.json: keep that file readable only by you (chmod 600).
- Inside the CLI, /mcp add opens the same form (type HTTP, the URL, the header as JSON).

### Claude Code (command)

Run in a terminal on the device (bash or zsh).

<!-- snippet: claude-code -->
```sh
read -rs AGILITY_BRIDGE_TOKEN   # paste the token, press Enter: nothing is echoed or kept in history
export AGILITY_BRIDGE_TOKEN
claude mcp add --transport http --scope user agility-my-team https://agility-bridge.example.com/w/my-team/mcp \
  --header "Authorization: Bearer $AGILITY_BRIDGE_TOKEN"
```

- Claude Code stores the header, with the token, in ~/.claude.json (user scope). Check with claude mcp list or /mcp.
- The command does not check the token: a wrong one fails later.

### Claude Code (command, Windows PowerShell)

Run in PowerShell 7 on the device.

<!-- snippet: claude-code-powershell -->
```powershell
$env:AGILITY_BRIDGE_TOKEN = Read-Host -MaskInput 'Device token'
claude mcp add --transport http --scope user 'agility-my-team' 'https://agility-bridge.example.com/w/my-team/mcp' `
  --header "Authorization: Bearer $env:AGILITY_BRIDGE_TOKEN"
```

- Read-Host -MaskInput needs PowerShell 7.1 or later.

### Claude Code (.mcp.json)

.mcp.json in a project (safe to commit: it holds no token).

<!-- snippet: claude-code-json -->
```json
{
  "mcpServers": {
    "agility-my-team": {
      "type": "http",
      "url": "https://agility-bridge.example.com/w/my-team/mcp",
      "headers": {
        "Authorization": "Bearer ${AGILITY_BRIDGE_TOKEN}"
      }
    }
  }
}
```

- Claude Code expands ${AGILITY_BRIDGE_TOKEN}: define it where Claude Code starts (your shell profile) and restart it.
- Credential-looking variables referenced from a project file can resolve to empty for remote servers: keep the variable name above, and use the command (user scope) if the header arrives empty.
- A configured Authorization header is not replaced by OAuth: remove it if the server later offers OAuth.

### Cursor

~/.cursor/mcp.json (all projects) or .cursor/mcp.json.

<!-- snippet: cursor -->
```json
{
  "mcpServers": {
    "agility-my-team": {
      "url": "https://agility-bridge.example.com/w/my-team/mcp",
      "headers": {
        "Authorization": "Bearer ${env:AGILITY_BRIDGE_TOKEN}"
      }
    }
  }
}
```

- Cursor expands ${env:AGILITY_BRIDGE_TOKEN}: set the variable before starting Cursor.
- Cursor shows at most 40 tools across all servers.

### Windsurf / Devin Desktop

~/.config/devin/mcp_config.json (Windows: %APPDATA%\devin\mcp_config.json).

<!-- snippet: windsurf -->
```json
{
  "mcpServers": {
    "agility-my-team": {
      "serverUrl": "https://agility-bridge.example.com/w/my-team/mcp",
      "headers": {
        "Authorization": "Bearer ${env:AGILITY_BRIDGE_TOKEN}"
      }
    }
  }
}
```

- The client expands ${env:AGILITY_BRIDGE_TOKEN} (an unset variable becomes empty): set it before starting the app.
- Older builds dropped custom headers; this form is from the vendor documentation and not yet run against agility-bridge.

### MCP Inspector (command line, for testing)

Run in a terminal; lists the tools the workspace offers.

<!-- snippet: inspector -->
```sh
read -rs AGILITY_BRIDGE_TOKEN   # paste the token, press Enter: nothing is echoed or kept in history
export AGILITY_BRIDGE_TOKEN
npx -y @modelcontextprotocol/inspector --cli https://agility-bridge.example.com/w/my-team/mcp --transport http \
  --header "Authorization: Bearer $AGILITY_BRIDGE_TOKEN" --method tools/list
```

- Add --protocol-era modern to test the 2026-07-28 revision (the default speaks a 2025-era one).
