# One token per device

> For `agility-bridge serve` (v0.2) and the Cloudflare Worker. Everything here can also be done in the browser: a grant's
> page issues tokens and shows the client snippets, and *Device tokens* lists and revokes every token ([admin
> panel](admin-panel.md#grants-and-device-tokens), [admin guide](admin-guide.md)). OAuth sign-in for claude.ai and mobile
> clients arrives in Phase 5.

Every device — a laptop, a second laptop, a CI runner — gets **its own device token** for the grant, so losing one
device means revoking one token, not re-configuring everyone ([access model](access-model.md#device-tokens)).

## Issue a token for a device

```sh
agility-bridge token issue <grant-id> --label "Ann's laptop" --expires-days 90
```

The token (`ab_live_…`) is printed **once**. Put it straight into the MCP client of that device; the server keeps only
its hash. It expires after 90 days by default (`--expires-days never` is possible, with a warning) and works only at the
address of its own workspace.

## Configure the client

The MCP address is `https://<server>/w/<workspace slug>/mcp`; the token goes into the `Authorization` header. Keep it
out of files you share: use your client's secret input where it has one.

VS Code (`.vscode/mcp.json`), prompting for the token once and storing it in the editor's secret storage:

```json
{
  "inputs": [{ "type": "promptString", "id": "agility-bridge-token", "description": "agility-bridge device token", "password": true }],
  "servers": {
    "agility": {
      "type": "http",
      "url": "https://mcp.example.com/w/team-mobile/mcp",
      "headers": { "Authorization": "Bearer ${input:agility-bridge-token}" }
    }
  }
}
```

Claude Code:

```sh
claude mcp add --transport http agility https://mcp.example.com/w/team-mobile/mcp --header "Authorization: Bearer $DEVICE_TOKEN"
```

Other clients: [client setup](clients.md) shows where each one takes an HTTP server address and a header.

## A device is lost or replaced

```sh
agility-bridge token list <grant-id>
agility-bridge token revoke <token-id>
```

`token list` shows each device's label, display prefix (`ab_live_` and four characters), creation, expiry and last use
— never the token. The revoked token stops at the next request on that server, and within the access cache (at most
60 seconds, `AB_ACCESS_CACHE_TTL`) on other server processes. The member's other devices keep working.

## Someone leaves

Revoke their grants (`agility-bridge grant revoke <grant-id>`): every token of every device stops. Also revoke their
personal Agility token on the Agility *Applications* page, and remove or disable the user
(`agility-bridge user disable <user-id>`).
