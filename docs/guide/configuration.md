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
| `AB_ATTACHMENT_DOWNLOAD` | `off` | `on` offers `get_attachment`: the text of one attachment of an asset in scope (own group, [THREAT_MODEL](../THREAT_MODEL.md) A8). Each download is logged to stderr (asset number, attachment id, size, type). |
| `AB_REPORTS` | `off` | `on` offers the composite reports `sprint_health`, `standup_summary`, `release_readiness`, `defect_triage`, `work_item_quality` and `quality_scan` (own group; each runs several reads, so keep `AB_CALL_BUDGET` at 54 or more). In the workspace YAML: `reports: true`. |
| `AB_WRITE_TOOLS` / `AB_WRITE_APPROVAL` | `off` / `required` | Write tools ([guide](write-tools.md)): `AB_WRITE_TOOLS=on` allows them, and `AB_TOOLS` must name each one. `AB_WRITE_APPROVAL=off` (stdio only) skips the approval question and logs a warning at start. In the workspace YAML: `writes: { enabled: true, approval: required }`. `AB_WRITE_CUSTOM_FIELDS=Custom_Risk,Custom_Note` (YAML `writes.custom_fields`) names the custom attributes `create_work_item` and `update_fields` may write (none by default, at most 20; P7-20). Nine write tools are built (P7-04 to P7-06) and verified on fakes only; the sandbox run is P7-07. |
| `AB_ATTACHMENT_MAX_BYTES` | `1048576` | Largest attachment read, counted on the stream (1024–8388608; never above the largest Agility response). |
| `AB_ATTACHMENT_TYPES` | `text/plain,text/markdown,text/csv,application/json` | Content types `get_attachment` returns, exact `type/subtype`; checked on the stored type and on the response. HTML, SVG, XML and JavaScript are refused even when listed. |
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
    attachments: { download: false, max_bytes: 1048576, types: [text/plain, text/csv] }
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

## Server mode (`agility-bridge serve`)

A team server that exposes each workspace at `/w/<slug>/mcp` to per-device tokens
([access model](access-model.md)). It also reads only `AB_` environment variables, never flags. A full walkthrough
follows in the self-hosting guide.

| Setting | Default | Meaning |
|---|---|---|
| `AB_MASTER_KEY_FILE` or `AB_MASTER_KEY` | — (required) | The master key that encrypts stored Agility tokens ([secrets](secrets.md)); `AB_MASTER_KEY_FILE_PREVIOUS` / `AB_MASTER_KEY_PREVIOUS` during a rotation |
| `AB_DATA_DIR` / `AB_DB_PATH` | `~/.local/share/agility-bridge` / `<data dir>/agility-bridge.db` | Where the SQLite database lives (created `0700`/`0600`) |
| `AB_HOST` / `AB_PORT` | `127.0.0.1` / `8787` | Listen address; loopback unless you expose it on purpose |
| `AB_PUBLIC_URL` | unset | The origin clients use, e.g. `https://mcp.example.com`; HTTPS turns on HSTS and allows that host |
| `AB_ALLOWED_HOSTS` | loopback names | Extra `Host` values to accept (comma-separated); anything else is refused (DNS rebinding) |
| `AB_ALLOWED_ORIGINS` | none | Browser origins allowed to call the server, with CORS headers |
| `AB_ACCESS_CACHE_TTL` | `30` | Seconds (0–60) a resolved access is reused; a revocation takes effect within this time |
| `AB_ENVIRONMENT` | `production` | `test` issues `ab_test_` device tokens, so test tokens are recognisable |
| `AB_TRUSTED_PROXY_HOPS` | `0` | Reverse proxies in front whose `X-Forwarded-For` entries are trusted for the client address |
| `AB_CALL_BUDGET`, `AB_LIMITS_MAX_RESPONSE_BYTES` | `1000`, 8 MiB | Defaults for workspaces that set no limits |
| `AB_AUDIT_RETENTION_DAYS` | `90` | Days the [audit log](audit-log.md) keeps rows; `0` keeps them forever |
| `AB_CREDENTIAL_REVALIDATION_HOURS` | `24` | Hours between revalidations of stored Agility tokens ([access model](access-model.md#credential-validation)); `0` = never |
| `AB_ADMIN_TOKEN_FILE` or `AB_ADMIN_TOKEN` | unset | The break-glass admin token from `agility-bridge admin-token`; turns on the [admin API](../reference/admin-api.md) (`404` without it). Hand-made values are refused |
| `AB_OAUTH` | `off` | The OAuth 2.1 server for MCP clients ([operator guide](oauth-operator.md), [how it works](oauth-how-it-works.md), [connect a phone](oauth-phone.md)). `on` needs `AB_PUBLIC_URL` (the issuer) and [sign-in](identity-providers.md): people approve an app on a consent screen after signing in. Without a sign-in provider the server refuses to start |
| `AB_OAUTH_ACCESS_TTL` | `1h` | Access-token lifetime: seconds, or a number with `s`, `m`, `h`, `d` (60 s to 24 h) |
| `AB_OAUTH_REFRESH_TTL` | `30d` | Absolute lifetime of a device authorization's refresh tokens (1 h to 365 d, not shorter than the access lifetime) |
| `AB_OAUTH_CIMD` | `on` | Client ID Metadata Documents: clients named by an https URL. The server fetches the document (public addresses only, no redirects, 5 KiB, 5 s). On Workers it needs the `global_fetch_strictly_public` flag, already in `wrangler.jsonc`; without a guarded fetch it stays off |
| `AB_OAUTH_CIMD_HOSTS` | any | Comma-separated host names (at most 50): the only hosts a metadata-document client id may have. Exact names: `claude.ai` does not allow `sub.claude.ai`. A client id on any other host is refused before anything is fetched, also one whose document was stored earlier. Unset = any public host. Apps that register themselves are not affected (see `AB_OAUTH_DCR_REDIRECT_HOSTS`) |
| `AB_OAUTH_CIMD_MAX_CLIENTS`, `AB_OAUTH_CIMD_FETCH_LIMIT` | `200`, `20` | Stored document clients at once (1-500; at the cap one cached document is dropped to make room, a new client is never refused for it); fetches one address may cause per hour (1-10000) |
| `AB_OAUTH_DCR` | `on` | Dynamic client registration (RFC 7591) at `/oauth/register`, for clients that do not use metadata documents. `off` answers `404` |
| `AB_OAUTH_DCR_MAX_CLIENTS`, `AB_OAUTH_DCR_IP_LIMIT` | `200`, `10` | Live registrations at once (1-500); registrations one address may make per hour (1-10000). Over either: `429`. At the cap, registrations unused for an hour are removed first. An address is an IPv4 address or an IPv6 /64 network |
| `AB_OAUTH_DCR_REDIRECT_HOSTS` | any | Comma-separated host names: the only https hosts a dynamic client may redirect to (loopback is always allowed) |
| `AB_OAUTH_DCR_UNUSED_TTL` | `24h` | How long a registration that never exchanged a code is kept (1 h to 7 d) |
| `AB_OAUTH_AUTHORIZE_IP_LIMIT`, `AB_OAUTH_AUTHORIZE_LIMIT` | `30`, `600` | Authorization requests per 10 minutes: per client address, and in all (1-100000). Over either: `429` with `Retry-After` |
| `AB_OAUTH_CONSENT_IP_LIMIT`, `AB_OAUTH_CONSENT_LIMIT` | `30`, `300` | Consent form posts per 10 minutes: per address, and in all |
| `AB_OAUTH_TOKEN_FAILURE_IP_LIMIT`, `AB_OAUTH_TOKEN_FAILURE_LIMIT` | `20`, `300` | Failed token requests per 10 minutes: per address, and in all (the second only turns away addresses that already failed, so a clean client is never locked out) |
| `AB_OAUTH_DCR_LIMIT`, `AB_OAUTH_CIMD_LIMIT` | `100`, `200` | Registrations, and metadata-document fetches, the whole deployment accepts per hour. Keep the registration limit below `AB_OAUTH_DCR_MAX_CLIENTS`: that margin is what leaves room for a new registration when a flood fills the cap. These limits are shared (database counters), so they hold across Worker isolates and replicas; reaching one means many addresses are asking, and clients are refused until the hour ends. See [OAuth abuse controls](../dev/oauth.md#abuse-controls-p5-09) |
| `AB_OAUTH_IDLE_TTL` | off | A connected app that has not been used (no token request and no MCP request) for this long is refused at its next refresh and disconnected. 1 h to 365 d; longer than `AB_OAUTH_REFRESH_TTL` has no effect. Apps connected before it was switched on count from their next token request. People see the last use on My access |
| `AB_OAUTH_REFRESH_REUSE_WINDOW` | `30s` | How long a refresh token that was just used is answered with the same new tokens again (parallel refreshes, a lost response), 0 to 120 s and not longer than the access lifetime. A repeat after the window disconnects the app; `0` is strict single use ([how it works](oauth-how-it-works.md)) |
| `AB_PASSTHROUGH` | `off` | `on` lets [pass-through workspaces](self-hosting.md#pass-through-workspaces-optional) accept the caller's own Agility token (`X-Agility-Token`, HTTPS only, read-only) |
| `AB_INSTANCE_PRIVATE_ADDRESSES` | `allow` | `refuse` accepts only instances at public addresses: a host that is, or resolves to, a loopback, private, link-local (cloud metadata) or reserved address is refused when the instance is added or retargeted, and again at every connection (so a DNS answer that changes later is refused too). Keep `allow` for on-premises instances on a private network |
| `AB_ALLOW_HTTP_INSTANCES` | `off` | `on` accepts plain-HTTP loopback instance URLs (`http://127.0.0.1/…`), for tests and the local synthetic Agility only; logged as a warning |
| `AB_GOOGLE_*`, `AB_GITHUB_*`, `AB_OIDC_*`, `AB_CF_ACCESS_*`, `AB_LOGIN_*` | unset | Admin sign-in providers, allowlists and auto-provisioning: see [sign-in providers](identity-providers.md#settings). Secrets may come from `<NAME>_FILE` (`0600`) |
| `AB_SESSION_IDLE_MINUTES`, `AB_SESSION_MAX_HOURS` | `30`, `12` | Admin browser sessions end after this many idle minutes (5-1440) and this many hours in all (1-168), whatever the activity ([admin access](admin-access.md)) |
| `AB_SESSION_MAX_PER_USER` | `20` | Live sessions per user (1-100); the next sign-in ends the oldest |
| `AB_LOGOUT_CLEAR_SITE_DATA` | `cookies` | `cookies`: sign-out also sends `Clear-Site-Data: "cookies"`, which clears the cookies of the whole registered domain and its subdomains; `off` only clears the session cookie |
| `AB_IDENTITY_PRIVATE_ADDRESSES` | `refuse` | `allow` lets sign-in reach an identity provider on a private or loopback address; the default refuses non-public addresses at every connection |
| `AB_ADMIN_URL` | unset | For the [management commands](cli.md): the server to manage through its admin API (HTTPS), instead of the local database |

### Rate limits

| Setting | Default | Limit |
|---|---|---|
| `AB_RATE_LIMIT_IP_PER_MINUTE` | `600` | Requests per client address, before authentication |
| `AB_RATE_LIMIT_AUTH_FAILURES` | `10` | Failed authentications per client address per 5 minutes; after that, failed attempts get `429` while valid tokens keep working |
| `AB_RATE_LIMIT_TOKEN_PER_MINUTE` | `120` | Requests per device token (a `subscriptions/listen` stream does not count) |
| `AB_WRITE_RATE_PER_GRANT_HOURLY` / `AB_WRITE_RATE_DEPLOYMENT_HOURLY` | `20` / `200` (Workers Free: `20` / `60`, and a larger deployment value stops the Worker at its first request, [limits](cloudflare-limits.md#write-tools-and-the-d1-row-budget)) | Writes an hour per grant (1–1,000) and for the whole deployment (1–10,000), counted in the shared `kv` table so every isolate and replica sees the same count; always on and fail closed ([write tools](write-tools.md#limits)). In stdio the first variable limits the process and there is no deployment limit. |
| `AB_RATE_LIMIT_GRANT_PER_MINUTE` | `300` | Requests per grant, all its devices together; a grant's own rate limit can lower it |
| `AB_RATE_LIMIT_VALIDATIONS_PER_MINUTE` | `30` | Checks of new pass-through tokens against Agility, per instance ([pass-through](self-hosting.md#pass-through-workspaces-optional)); beyond it, new tokens get `429` while known ones keep working |
| `AB_RATE_LIMIT_SIGN_IN` | `60` | Requests to the `/auth/*` sign-in routes per client address per 5 minutes ([sign-in providers](identity-providers.md)); beyond it, `429` |
| `AB_RATE_LIMIT` | `on` | `off` turns every limit off (logged as a warning) |

A limited request gets `429` with `Retry-After`. The counters live in each server process: several replicas each
count on their own. Client addresses are counted as is for IPv4 and by their `/64` network for IPv6. If the limiter itself fails, requests are allowed and the failure is logged (authorization never
fails open).
