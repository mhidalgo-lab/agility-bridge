# Logging inventory

> Every place agility-bridge writes records about what happens, what each record holds, how it is redacted, how long
> it stays and who reads it (L-120, THREAT_MODEL T8, T17). `scripts/test/security-inventories.test.ts` fails when a log
> message or an audit column is missing here or a link breaks.

## Sinks

| Sink | Where | Format | Retention | Readers | Code · tests |
|---|---|---|---|---|---|
| Process log | **stderr** only (stdout is the stdio MCP channel); on Cloudflare, the Worker's log (`console.error`, Workers Logs) | One JSON object per line: `ts`, `level`, `msg`, fields | The operator's log collector (journald, Docker, …) | The operator | [logger.ts](../../packages/core/src/logger.ts) · [logger.test.ts](../../packages/core/test/logger.test.ts) |
| Audit log | Table `audit_log` of the server database (not in stdio mode) | Rows, append-only (a trigger refuses updates) | `AB_AUDIT_RETENTION_DAYS` (default 90; 0 = forever), purged at start and hourly | Owners and admins (`GET /api/admin/v1/audit`, `agility-bridge audit tail`) | [audit.ts](../../packages/http-app/src/audit.ts) · [audit.test.ts](../../packages/http-app/test/audit.test.ts) |
| CLI output | stdout (JSON results) and stderr (messages) of management commands | — | The terminal | The operator | [commands.ts](../../apps/cli/src/manage/commands.ts) · [manage.test.ts](../../apps/cli/test/manage.test.ts) |

No telemetry leaves the process (OpenTelemetry is P8-07, off by default).

## Redaction (every log line, error message and audit record)

[redact.ts](../../packages/core/src/redact.ts) · [redact.test.ts](../../packages/core/test/redact.test.ts):

- agility-bridge tokens (`ab_live_`, `ab_test_`, `ab_admin_`), `Bearer` credentials, `Authorization` headers of any
  scheme, key/value assignments whose name looks secret (`AB_MASTER_KEY=…`, `token=…`, `password=…`, …).
- OAuth codes, access tokens and refresh tokens (`<user id>:<grant id>:<secret>`; the two ids stay, the secret goes), also
  as `refresh_token=…`, `authorizationCode` and `?code=…` (P5-01).
- JWTs, AWS keys, GitHub/Slack/Stripe/OpenAI-style tokens, master keys (`v<N>:<base64>`), credentials in URLs, PEM
  private keys.
- Object keys that are always secret (`authorization`, `token`, `password`, `secret`, `master_key`, `cookie`, …).
- Errors are reduced to their class and a redacted message; the Agility token is a `Secret` that never prints.
- Log fields can never forge `ts`, `level` or `msg`.

## Process log messages

Fields are listed per message; every message also carries `mode` (`stdio`, `serve`, `cli`, `worker`) and request-scoped messages
carry `requestId`.

| Level | Message | Fields | Code |
|---|---|---|---|
| info | `serving` | `url`, `publicUrl`, `database`, `adminApi` (serve); `tools`, `source`, `workspace`, `projects` (stdio) | [serve.ts](../../apps/cli/src/serve.ts), [stdio.ts](../../apps/cli/src/stdio.ts) |
| info | `request` | `requestId`, `workspace` (slug), `status`, `method`, `kind`, `tool`, `durationMs`, `refusal` | [server.ts](../../packages/http-app/src/server.ts) |
| info | `booted` | `plan`, `callBudget`, `writeDeploymentPerHour`, `adminApi`, `publicUrl` (Worker) | [boot.ts](../../apps/worker/src/boot.ts) |
| error | `boot failed` | `error` (class), `reason` (names a setting, never a value) (Worker; written directly, the logger may not exist yet) | [index.ts](../../apps/worker/src/index.ts) |
| debug | `tool ok` | `tool`, `ms`, `requests` | [server.ts](../../packages/core/src/server.ts) |
| warn | `tool error` | `tool`, `ms`, `code`, `error` (class, redacted message) | [server.ts](../../packages/core/src/server.ts) |
| warn | `deprecated argument used` | `tool`, `argument` (fixed names, once per process) | [server.ts](../../packages/core/src/server.ts) |
| info | `attachment downloaded` | `asset` (number), `attachment` (id), `bytes`, `contentType`; never the content | [attachments.ts](../../packages/core/src/tools/collaboration/attachments.ts) |
| debug | `resource ok` | `resource`, `ms`, `requests` | [server.ts](../../packages/core/src/server.ts) |
| warn | `resource error` | `resource`, `ms`, `error` (class, redacted message) | [server.ts](../../packages/core/src/server.ts) |
| debug | `agility request` | `endpoint`, `method`, `attempt`, `status`, `ms`, `bytes` (no body, no token) | [client.ts](../../packages/core/src/agility/client.ts) |
| debug | `agility query cache hit` | `endpoint` | [client.ts](../../packages/core/src/agility/client.ts) |
| debug | `agility query joined an identical request in flight` | `endpoint` | [client.ts](../../packages/core/src/agility/client.ts) |
| warn | `query cache lookup failed`, `query cache store failed` | `error` (class) | [client.ts](../../packages/core/src/agility/client.ts) |
| warn | `query cache shared tier read failed`, `query cache shared tier write failed` | `error` (class) | [query-cache.ts](../../packages/core/src/agility/query-cache.ts) |
| warn | `AB_QUERY_CACHE_EDGE is on but this host has no shared tier: the query cache is in memory only.` | none | [server.ts](../../packages/http-app/src/server.ts) |
| warn | `quota counters could not be read`, `quota counters could not be updated` | `error` (class) | [quota.ts](../../packages/core/src/agility/quota.ts) |
| warn | `grant quota reached 80%` | `grant` (id), `period`, `limit` | [quota.ts](../../packages/core/src/agility/quota.ts) |
| debug | `agility error body` | `status`, the first 500 characters of the error body (redacted by the logger) | [client.ts](../../packages/core/src/agility/client.ts) |
| warn | `agility refused the request` | `status`, Agility's `error` and up to five exception `messages` (500 characters each, redacted by the logger): the text withheld from the tool result (P6-33, L-333) | [client.ts](../../packages/core/src/agility/client.ts) |
| error | `access resolution failed` | `requestId`, `error` (class) | [app.ts](../../packages/http-app/src/app.ts) |
| error | `credential could not be decrypted` | `requestId`, `error` (class) | [app.ts](../../packages/http-app/src/app.ts) |
| warn | `response stream hit the deadline` | `requestId` | [app.ts](../../packages/http-app/src/app.ts) |
| warn | `observer failed` | `kind`, `error` (class) | [app.ts](../../packages/http-app/src/app.ts) |
| warn | `background work failed` | `error` (class) | [app.ts](../../packages/http-app/src/app.ts) |
| error | `unhandled error` | `error` (class) | [app.ts](../../packages/http-app/src/app.ts) |
| error | `admin API error` | `path` (route template), `error` (class) | [api.ts](../../packages/http-app/src/admin/api.ts) |
| error | `admin panel error` | `error` (class) | [app.ts](../../packages/http-app/src/app.ts) |
| warn | `rate limiter failed; allowing the request` | `limit`, `error` (class) | [rate-limit.ts](../../packages/http-app/src/rate-limit.ts) |
| info | `scheduled jobs` | `auditDeleted`, `kvPurged`, `rotated`, `revalidated`, `failed` (Worker cron) | [scheduled.ts](../../apps/worker/src/scheduled.ts) |
| error | `scheduled job failed` | `job`, `error` (class) | [scheduled.ts](../../apps/worker/src/scheduled.ts) |
| info | `key rotation continues` | `rotated`, `remaining`, `failed` (counts) | [scheduled.ts](../../apps/worker/src/scheduled.ts) |
| warn | `rate limit binding failed; using per-isolate limits` | `error` (class) (Worker, at most once a minute) | [rate-limit.ts](../../apps/worker/src/rate-limit.ts) |
| warn | `Rate limit bindings RL_IP and RL_AUTH are missing: limits count per isolate only.` | — (Worker) | [boot.ts](../../apps/worker/src/boot.ts) |
| warn | `identity hash failed` | `event` | [identity.ts](../../packages/http-app/src/identity.ts) |
| error | `login failed` | `requestId`, `provider`, `error` (class); never codes, tokens, cookies or the email | [identity.ts](../../packages/http-app/src/identity.ts) |
| warn | `GitHub token revocation failed` | `requestId`, `provider`, `reason` (`status` or `network`), `status` (never the token) | [github.ts](../../packages/auth/src/identity/github.ts) |
| debug | `oauth error response` | `code`, `status`, `reason` (stable provider reason, never the request) | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| debug | `oauth authorize request refused` | `error` (class) | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| warn | `oauth refresh token reused; device revoked` | `oauthGrant` (provider grant id) | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| error | `oauth refresh successor unreadable` | `oauthGrant` | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| info | `oauth token refused; device revoked` | `reason` (resolver deny reason), `oauthGrant` (provider grant id), `grantType` | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| warn | `oauth authorization code replayed; grant revoked` | `oauthGrant`; never the code | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| warn | `oauth tokens issued for a revoked device; revoked again` | `oauthGrant` | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| warn | `oauth audit failed` | `error` (class) | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| warn | `oauth device replacement failed` | `error` (class) | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| error | `consent screen error` | `error` (class) | [app.ts](../../packages/http-app/src/app.ts) |
| info | `oauth client refused` | `reason` (stable code), `clientHost` (host of the client id URL; never the document) | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| warn | `oauth client device counts unavailable` | none | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| info | `oauth registration refused` | `reason` (stable code); never the request body | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| warn | `oauth registration per-address limit reached` | `limit` | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| warn | `oauth registration cap reached` | `limit` | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| warn | `oauth metadata document client cap reached; one stored document evicted` | `limit` | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| warn | `oauth limit reached` | `surface`, `scope` (`address` or `deployment`), `limit`; first refusal per window only; never the address | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| warn | `oauth abuse limiter failed; allowing the request` | `surface`, `error` (class) | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| warn | `oauth device use not recorded` | `error` (class) | [server.ts](../../packages/http-app/src/oauth/server.ts) |
| info | `storage housekeeping` | `expiredRows`, `registrationsSwept` | [housekeeping.ts](../../packages/http-app/src/oauth/housekeeping.ts) |
| error | `storage housekeeping failed` | `error` (class) | [housekeeping.ts](../../packages/http-app/src/oauth/housekeeping.ts) |
| warn | `OAuth client metadata documents are off: the global_fetch_strictly_public compatibility flag is not set. Dynamic registration still works.` | none (Worker start) | [boot.ts](../../apps/worker/src/boot.ts) |
| error | `audit write failed` | `action`, `error` (class) | [audit.ts](../../packages/http-app/src/audit.ts) |
| error | `audit queue full; rows dropped` | `dropped` | [audit.ts](../../packages/http-app/src/audit.ts) |
| info | `audit retention` | `deleted`, `retentionDays` | [audit.ts](../../packages/http-app/src/audit.ts) |
| error | `audit retention failed` | `error` (class) | [audit.ts](../../packages/http-app/src/audit.ts) |
| warn | `credential validation failed` | `error` (class) | [validate.ts](../../packages/auth/src/access/validate.ts) |
| info | `credentials revalidated` | `count` | [serve.ts](../../apps/cli/src/serve.ts) |
| warn | `credential revalidated after Agility refused it` | `credential` (id), `status` | [server.ts](../../packages/http-app/src/server.ts) |
| error | `credential revalidation failed` | `error` (class) | [serve.ts](../../apps/cli/src/serve.ts), [server.ts](../../packages/http-app/src/server.ts) |
| warn | `AB_WRITE_TOOLS is on: owners can enable write tools per workspace and grant; every write needs a person to approve it.` | — | [server.ts](../../packages/http-app/src/server.ts) |
| info | `write intent`, `write outcome` (stdio: the whole write audit, P7-01) | `phase`, `requestId`, `tool`, `operation`, `actor`, `workspaceId`, `instanceId`, `hash`, `target`, `fields` (names), `approval`, `status`, `errorCode` | [stdio.ts](../../apps/cli/src/stdio.ts) |
| error | `write limiter failed; the write is refused` | `error` (class; none in stdio) | [writes.ts](../../packages/http-app/src/writes.ts), [stdio.ts](../../apps/cli/src/stdio.ts) |
| info | `write applied` | `tool`, `change` (short hash), `approval` | [pipeline.ts](../../packages/core/src/writes/pipeline.ts) |
| error | `write refused: intent audit failed`, `write outcome audit failed`, `write approval could not be kept`, `write approval could not be consumed` | `tool`, `error` | [pipeline.ts](../../packages/core/src/writes/pipeline.ts) |
| warn | `AB_WRITE_APPROVAL=off: write tools change Agility without asking a person first…` | — | [stdio.ts](../../apps/cli/src/stdio.ts) |
| error | `write runtime unavailable` | `requestId`, `error` (class) | [app.ts](../../packages/http-app/src/app.ts) |
| warn | `AB_WRITE_TOOLS is on, but AB_TOOLS names no write tool, so none is offered.` | — | [stdio.ts](../../apps/cli/src/stdio.ts) |
| warn | `AB_RATE_LIMIT is off: no request, token or authentication-failure limits.` | — | [server.ts](../../packages/http-app/src/server.ts) |
| warn | `AB_ALLOW_HTTP_INSTANCES is on: plain-HTTP loopback instance URLs are accepted (tests only).` | — | [server.ts](../../packages/http-app/src/server.ts) |
| warn | `AB_PUBLIC_TOOL_CATALOG is on: anyone who can reach the server can list its read-only tools without signing in.` | — | [server.ts](../../packages/http-app/src/server.ts) |
| warn | `AB_OTEL_ENDPOINT is set: allowlisted request metadata (MCP method, tool name, status, error code, duration, Agility request count) is sent to <collector host>; never Agility content, credentials or request values.` | — (the host of the endpoint only, never the path or `AB_OTEL_HEADERS`) | [server.ts](../../packages/http-app/src/server.ts) |
| warn | `telemetry export failed` (at most one a minute) | `error` (class), `spans` | [telemetry.ts](../../packages/core/src/telemetry/telemetry.ts) |
| warn | `AB_PASSTHROUGH is on: pass-through workspaces accept any valid Agility token of their instance.` | — | [server.ts](../../packages/http-app/src/server.ts) |
| warn | `Not configured: tools are listed, and every call explains how to set AB_AGILITY_URL and AB_AGILITY_TOKEN.` | — | [stdio.ts](../../apps/cli/src/stdio.ts) |
| warn | configuration and key warnings | the text only (data directory permissions, stranded or retired key versions, deprecated settings) | [serve.ts](../../apps/cli/src/serve.ts), [credentials.ts](../../packages/auth/src/secrets/credentials.ts) |

Never logged: tokens of any kind, the master key, request or response bodies, tool arguments, Agility content (outside
the redacted, debug-level error body), client IP addresses (they go to the audit log only).

## Audit log columns

| Column | Content | Notes |
|---|---|---|
| `id`, `ts` | Random id, epoch ms | |
| `kind` | `tool_call`, `auth`, `admin`, `write` | |
| `action` | Tool name, `mcp.unauthenticated`, `mcp.rate_limited`, `audit.refusals_suppressed`, `<resource>.<verb>`, `credential.rekey`, `crypto.retire_key` | |
| `status` | `ok`, `error`, `denied` | |
| `requestId` | The request's id | Joins the process log |
| `userId`, `grantId`, `tokenId` | Who, through which grant and device | Ids only |
| `clientId` | OAuth client (Phase 5) | |
| `workspaceId`, `instanceId` | Where | |
| `assetNumbers` | Asset numbers in the result, at most 50 | Identifiers, never titles |
| `query` | The compiled Agility queries with every bound value masked (`…`) | Attribute names, never values |
| `durationMs`, `agilityRequests` | Cost of the call | Counted in the record, not headers (L-101) |
| `errorCode` | Stable error code | Never a message |
| `targetType`, `targetId` | What an admin change touched | |
| `details` | Refusals: `reason`, `slug`, `ip`; admin rows: `actor` role, `via` (`api`/`cli`), changed field names; rotation: versions and reason; `get_attachment` tool calls: `download` (`asset`, `attachment`, `bytes`, `contentType`) | Field names, never values |

Proven by a scan test that runs tool calls with filter values, refusals with request bodies and an admin change, then
checks that no token, filter value, project, member or story name, or `Bearer` appears in any row
([audit.test.ts](../../packages/http-app/test/audit.test.ts)).
