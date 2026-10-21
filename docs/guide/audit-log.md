# Audit log

> Applies to the server (`agility-bridge serve`, v0.2). The local stdio mode keeps no audit table and logs to stderr.

The server records who did what, through which grant and device, against which assets — **without** storing tokens,
credentials, request bodies or anything read from Agility ([THREAT_MODEL](../THREAT_MODEL.md) T8, T17). Rows live in
the `audit_log` table of the server's database; they can never be changed, only deleted by retention.

## What is recorded

| Kind | When | Holds |
|---|---|---|
| `tool_call` | every tool call, successful or not | tool (`action`), `ok`/`error` and the error code, user, grant, device token id, workspace, instance, asset numbers in the result (at most 50), the compiled Agility queries **with every value masked** (`…`), duration, Agility requests used, whether the credential was personal or shared |
| `auth` | a refused MCP request (`401`, `429`) | the reason (`no_token`, `token_malformed`, `wrong_workspace`, `token_revoked`, `rate_limited`, …), the workspace in the URL, the client address; at most 60 rows a minute, then one `audit.refusals_suppressed` row with the count |
| `admin` | changes to instances, credentials, workspaces, grants, tokens, users, and key rotations | the action (`grant.create`, `credential.rekey`, …), who, the target's type and id, field names and reasons — never values typed by users or secrets |
| `write` | Phase 7: the intent of a write, recorded **before** the change is sent to Agility; if it cannot be recorded, the write is refused | |

Not recorded: the arguments of a tool call, search words and filter values, titles, descriptions, names or any other
Agility content, tokens of any kind, the master key. A refused request's body is never read, so it is not recorded
either.

Rows are written in the background: a slow or failing audit store never slows down or fails a request; failures are
logged to stderr.

## Retention

`AB_AUDIT_RETENTION_DAYS` (default `90`; `0` keeps rows forever). The server deletes older rows at start and every hour,
in batches.

## Reading it

Until the admin API (`/api/admin/v1/audit`) and `agility-bridge audit tail` arrive, query the database directly, read
only, for example:

```sh
sqlite3 -readonly ~/.local/share/agility-bridge/agility-bridge.db \
  "SELECT datetime(ts/1000,'unixepoch'), kind, action, status, workspace_id, asset_numbers FROM audit_log ORDER BY ts DESC LIMIT 20"
```
