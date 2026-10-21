# Configuration (stdio)

agility-bridge runs as a local stdio server started by your MCP client. It reads its configuration from the
**environment your MCP client sets** (the `env` block of its server entry), or from a YAML file. It never takes
settings or secrets as command-line flags: flags show up in process listings (L-026).

Every setting starts with `AB_` and is checked at startup: an unknown `AB_` name (usually a typo), an invalid value, or
a half-finished configuration stops the server with one clear line on stderr and exit code 1.

## Environment mode

The smallest working configuration:

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

| Variable | Default | Meaning |
|---|---|---|
| `AB_AGILITY_URL` | — | The address you open Agility at, e.g. `https://www7.v1host.com/YourInstance` (HTTPS only). |
| `AB_AGILITY_TOKEN` | — | Your access token (Agility → your avatar → Applications). It acts fully as you and does not expire: revoke it there when you no longer need it. |
| `AB_PROJECTS` | every project you can see | Allowed Agility projects as OID tokens: `Scope:1234,Scope:5678`. |
| `AB_INCLUDE_CHILD_PROJECTS` | `on` | Include the sub-projects of `AB_PROJECTS`. |
| `AB_TOOLS` | every read tool | Tool allowlist, comma-separated. An unknown name stops startup and lists the valid ones. |
| `AB_ASSET_TYPES_ALLOW` / `AB_ASSET_TYPES_DENY` | all / none | Asset types the tools may read (`Story,Defect,Task`). A global type such as `Member` is readable through `query_assets` only when the allow list names it. |
| `AB_GENERIC_QUERY` | `on` | `off` removes `query_assets` and `get_assets`. |
| `AB_MEMBER_EMAILS` | `off` | `on` includes member emails in results. |
| `AB_LIMITS_MAX_LIMIT` | `100` | Most rows one call may ask for (1–1000). |
| `AB_LIMITS_MAX_RESPONSE_BYTES` | `8388608` | Largest Agility response read (bytes). |
| `AB_CALL_BUDGET` | `1000` | Agility requests one tool call may make; tools that need more are not offered. |
| `AB_CA_FILE` | unset | PEM file with the CA of an on-premises instance (added to the public roots). |
| `AB_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs go to stderr, redacted. |

Boolean values accept `on`/`off`, `true`/`false`, `1`/`0`. With **nothing** set, the server still starts: your client
lists the tools, and every call answers `AB_AUTH_UNAUTHORIZED` with these setup steps. Setting only one of
`AB_AGILITY_URL` and `AB_AGILITY_TOKEN` is an error.

## YAML mode

Set `AB_CONFIG` to a YAML file, and `AB_WORKSPACE` to the workspace to serve when the file has more than one. With
`AB_CONFIG` set, the environment-mode variables above must not be set (put them in the file). `AB_LOG_LEVEL` still
overrides the file.

```yaml
version: 1
log_level: info
workspaces:
  mobile:
    name: Mobile team
    instance:
      url: https://www7.v1host.com/YourInstance
      token: ${AGILITY_TOKEN}              # from the environment
      # token: ${keychain:agility/ann}     # or the OS keychain (macOS security, Linux secret-tool)
      # ca_file: /etc/ssl/agility-ca.pem
    projects: [Scope:1234]
    include_child_projects: true
    tools: [whoami, list_projects, search_work_items, get_work_item]
    asset_types: { allow: [Story, Defect, Task, Test] }
    generic_query: true
    member_emails: false
    limits: { max_limit: 100, call_budget: 1000 }
```

- Secrets only as `${NAME}` (environment) or `${keychain:service/account}` references; a reference that cannot be
  resolved stops startup and names it.
- Unknown keys are refused, the file may be at most 1 MiB, YAML aliases are limited, and the server warns when the file
  is readable by other users (`chmod 600` it).
- Keychain references use `security find-generic-password` on macOS and `secret-tool lookup` on Linux; on Windows use
  `${NAME}` references.

## After an upgrade

MCP clients cache the tool list. After upgrading agility-bridge, reconnect or restart the server in your client before
new tools, arguments or output fields work (L-027).

## Remote mode

`agility-bridge serve` (shared HTTP server, workspaces, device tokens and OAuth) arrives with Phase 2; its settings are
listed in [ARCHITECTURE §7.1](../ARCHITECTURE.md#71-planned-configuration-initial-list).
