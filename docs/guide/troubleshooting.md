# Troubleshooting

Errors from agility-bridge start with a stable code (`AB_…`) and usually a `Hint:` line that says what to do. Logs are
JSON lines on stderr: your client shows them in its MCP output or log view (VS Code: *Output → MCP: agility*; Claude
Code: `claude --debug`; Copilot CLI: `~/.copilot/logs`). Set `AB_LOG_LEVEL=debug` for one line per Agility request;
tokens are always redacted.

| You see | Likely cause | Fix |
|---|---|---|
| The server does not start; the client log shows `agility-bridge: …` | Invalid configuration (one line says which setting) | Fix that setting; the [configuration guide](configuration.md) lists them all. |
| Every call answers `AB_AUTH_UNAUTHORIZED: agility-bridge is not configured yet.` | `AB_AGILITY_URL` and `AB_AGILITY_TOKEN` are not reaching the server | Put them in the client's `env` block (not your shell profile), then restart the server in the client. |
| `AB_AGILITY_AUTH: Agility rejected the access token (401).` | The token was revoked, mistyped, or belongs to another instance | Create a new token on the Agility Applications page; check `AB_AGILITY_URL`. |
| `AB_AGILITY_WRONG_INSTANCE` | The URL points at a login page, `/Default.aspx`, or another site | Use the address you open Agility at, up to the instance name. |
| `AB_AGILITY_TLS` | The instance's certificate is not trusted (often an on-premises instance with a private CA) | Set `AB_CA_FILE` to the CA's PEM file. |
| `AB_NOT_FOUND: … not found or not visible with this token.` | The asset does not exist, your member cannot see it, or it is outside `AB_PROJECTS` | Check the number; Agility does not tell these apart. |
| `AB_AMBIGUOUS` with candidates | A name matched several projects, teams, members or sprints | Repeat with one of the OID tokens shown (`Team:1234`). |
| `AB_AGILITY_RATE_LIMITED` | Your Agility tenant's request quota for this token | Wait the seconds shown, then narrow the request. |
| `AB_BUDGET_EXHAUSTED` | One call needed more Agility requests than its limit, often on the first call while metadata loads | Repeat the call (metadata is cached for an hour), or ask for fewer fields. |
| New tools or arguments are missing after an upgrade | The client cached the old tool list | Restart or reconnect the server in the client (L-027). |
| `npx` is slow or fails behind a proxy | npm cannot reach the registry | Configure npm's proxy, or install once with `npm install -g agility-bridge` and use `agility-bridge` as the command. |

The admin panel, sign-in and device-token problems of a team server (`403 reauth_required`, sign-in refused, cookies,
`Clear-Site-Data`, a lost device) are in the [admin guide](admin-guide.md#troubleshooting).

OAuth connections (claude.ai, phones, IDEs) that do not start or stop working are in
[troubleshooting OAuth](oauth-troubleshooting.md).

Still stuck? Open an issue with the error code, the client and its version, and the agility-bridge version
(`npx -y agility-bridge --version`); never include your token or Agility content.
