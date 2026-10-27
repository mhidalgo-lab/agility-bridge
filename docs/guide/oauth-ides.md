# Connect an IDE or a command-line client with OAuth

> For people whose operator turned [OAuth on](oauth-operator.md). Instead of pasting a device token, the client opens your
> browser, you sign in and approve it once, and it keeps itself connected. The address is always
> `https://<host>/w/<workspace slug>/mcp`, for example `https://bridge.example.com/w/my-team/mcp`. Prefer a device token
> (see [client setup](clients.md#remote-server-device-token)) for a client that cannot open a browser. claude.ai and phones:
> [connect claude.ai and a phone](oauth-phone.md).

## What is verified

"Verified" means someone ran it against a real deployment and wrote down the client version and the date in the
[client matrix](../reference/client-compatibility.md#oauth-runs-p5-06). Everything else is documented from the client's own
documentation and may need a tweak: tell us what you saw.

| Client | OAuth status | Notes |
|---|---|---|
| Claude Code | **Verified**, 2.1.310, 2026-10-26 (owner-verified) | Registers through a client metadata document, refreshes silently |
| claude.ai web | **Verified**, 2026-10-26 (owner-verified) | [Own page](oauth-phone.md) |
| VS Code | Signed in through OAuth in the Phase 0 spike (1.142.0, 2026-10-21); not re-run against this release | Planned: [P6-14](../tasks/phase-6-tool-breadth/P6-14-oauth-client-matrix-rest.md) |
| JetBrains, Copilot CLI | Not run | Documented only |
| Cursor, Windsurf / Devin Desktop | Not run (no subscription available) | Documented only; see the redirect note below |
| MCP Inspector | Signed in through dynamic registration in the Phase 0 spike (2.11.0) | Needs a terminal for interactive OAuth |

## Claude Code

Owner-verified 2026-10-26 with 2.1.310.

```sh
claude mcp add --transport http agility https://bridge.example.com/w/my-team/mcp
```

Do **not** add an `Authorization` header: a configured header is used as it is and OAuth never starts. Then, inside Claude
Code, run `/mcp`, pick the server and choose **Authenticate**. The browser opens: sign in if asked, check the
**Who is asking** and **Sends you back to** lines on the consent page (when the answer goes to a program on your computer, the page says so), give the device a name and choose **Allow**. Back in the terminal the server shows as connected and its
tools are listed.

Claude Code refreshes the access token on its own (a silent `refresh_token` exchange was seen after the first hour), so
you are not asked again until the refresh token ends (30 days by default), you disconnect the app on **My access**, or
your access changes. If it does ask, run **Authenticate** again.

## VS Code (GitHub Copilot)

Documented, not re-run for this release. In `.vscode/mcp.json` (or the user profile) list the server with no headers:

```json
{
  "servers": {
    "agility": {
      "type": "http",
      "url": "https://bridge.example.com/w/my-team/mcp"
    }
  }
}
```

VS Code shows an **Authenticate** action on the server (or prompts when it starts), opens the browser and returns after you
approve. Phase 0 recorded the sign-in through a metadata document at `https://vscode.dev/oauth/client-metadata.json`.

## JetBrains

Documented only. The JetBrains AI Assistant lists remote servers in its MCP settings: add the URL without a header and use
the sign-in action if the IDE offers one. If it only accepts a header, use a [device token](clients.md#remote-server-device-token)
instead (the IDE stores it in plain text, so give it a short expiry).

## Copilot CLI

Documented only.

```sh
copilot mcp add --transport http agility https://bridge.example.com/w/my-team/mcp
```

Without `--header`. If the CLI does not start a browser sign-in, use a device token.

## Cursor and Windsurf (Devin Desktop)

Not run: the owner has no subscription to either. List the server by `url` (Cursor, `mcp.json`) or `serverUrl` (Windsurf,
`mcp_config.json`) with no `headers`. **A known risk:** some desktop apps come back to the app with a private-use address
such as `cursor://...`. The server accepts only `https` and loopback callbacks (D-69), so such a client fails at
registration or authorization with `invalid_redirect_uri` ([troubleshooting](oauth-troubleshooting.md#redirect-problems)). If
that is what you see, use a device token and report it: the planned fix is task P5-15.

## MCP Inspector

```sh
npx @modelcontextprotocol/inspector --cli https://bridge.example.com/w/my-team/mcp --transport http --method tools/list
```

It registered by dynamic registration in the Phase 0 spike, and interactive OAuth needs a terminal. If the operator turned
`AB_OAUTH_DCR` off, a client that does not use metadata documents cannot register.

## When it does not work

Start with [troubleshooting OAuth](oauth-troubleshooting.md): it separates "the client never found the sign-in" (discovery),
"the browser came back with an error" (redirect, sign-in, consent) and "connected, but a tool says not found".

To disconnect an app, open **My access**, find it under **Connected apps** and press **Disconnect**
([details](oauth-phone.md#see-and-disconnect-your-apps)). Connecting the same app to the same workspace again replaces its old entry.
