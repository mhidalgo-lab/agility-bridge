# Audit log

> Applies to the server (`agility-bridge serve`, v0.2). The local stdio mode keeps no audit table and logs to stderr.

The server records who did what, through which grant and device, against which assets — **without** storing tokens,
credentials, request bodies or anything read from Agility ([THREAT_MODEL](../THREAT_MODEL.md) T8, T17). Rows live in
the `audit_log` table of the server's database; they can never be changed, only deleted by retention.

## What is recorded

| Kind | When | Holds |
|---|---|---|
| `tool_call` | every tool call, successful or not | tool (`action`), `ok`/`error` and the error code, user, grant, device token id, workspace, instance, asset numbers in the result (at most 50), for `get_attachment` the asset number, attachment id, size and content type (`details.download`, never the content), the compiled Agility queries **with every value masked** (`…`), duration, Agility requests used, whether the credential was personal or shared |
| `auth` | a refused MCP request (`401`, `429`) | the reason (`no_token`, `token_malformed`, `wrong_workspace`, `token_revoked`, `rate_limited`, …), the workspace in the URL, the client address; at most 60 rows a minute, then one `audit.refusals_suppressed` row with the count. OAuth device and client changes (P5-08) write `oauth.device.revoke` (also when a person disconnects their own app, with `via`), `oauth.client.revoked` and `oauth.client.restored`, and the administrator's own `admin` rows `oauth_device.revoke`, `oauth_client.revoke` and `oauth_client.restore`, never a token. OAuth abuse limits (P5-09) write `oauth.request.refused` once per ten minutes (an hour for registrations and fetches), surface and scope, with the limit and never an address |
| `admin` | changes to instances, credentials, workspaces, grants, tokens, users, and key rotations | the action (`grant.create`, `credential.rekey`, …), who, the target's type and id, field names and reasons — never values typed by users or secrets |
| `write` | a write tool ([guide](write-tools.md)): two rows per applied write, the **intent** (`details.phase: intent`), stored **before** the change is sent to Agility (if it cannot be stored, the write is refused), and the **outcome** (`details.phase: outcome`, `ok` or `error` with the code, `details.intentId`) | tool, operation, user, grant, device, workspace, target type, OID and asset number, the **names** of the changed fields, the hash of the change the approval bound and the approval channel (`elicitation`, `page`, `not_required`); never a value |

### Reading a write: intent and outcome

One applied or attempted write is **two rows** that share a pair key: the outcome's `details.intentId` is the id of its
intent row. The panel, the CSV and the statistics pair them.

| What you see | Meaning |
|---|---|
| intent, then outcome `ok` | the change was sent to Agility and accepted |
| intent, then outcome `error` and a code | the change was sent and Agility (or the network) refused it; `AB_AGILITY_UNAVAILABLE` and timeouts carry the note "outcome unknown: the change may have been applied" |
| intent with **no outcome** for ten minutes | a crash or restart between the two rows, or an outcome row that could not be stored. The change may or may not have been applied: look at the item in Agility. The viewer flags it and the Usage page lists it |
| intent younger than ten minutes with no outcome | the write is probably still running |
| outcome with no intent in the view | its intent is on a neighbouring page, outside the time range, or the filter hides it (an outcome filter drops intent rows); nothing is claimed |

A write refused before its intent (no approval, limit, disabled tool) writes no `write` row at all: refusals are in the
tool call rows. Only field **names**, the target, the approval channel and the change hash are in a write row, never a value.

Not recorded: the arguments of a tool call, search words and filter values, titles, descriptions, names or any other
Agility content, tokens of any kind, the master key. A refused request's body is never read, so it is not recorded
either.

Statistics read at most the newest 10,000 `tool_call` rows of the chosen window, so a very busy server shows the newest
part of a long window (and says so). No index was added for them: every extra index costs a written row per audit row, and
the write quota is the tight one on Cloudflare's free plan.

Rows are written in the background: a slow or failing audit store never slows down or fails a request; failures are
logged to stderr.

## Retention

`AB_AUDIT_RETENTION_DAYS` (default `90`; `0` keeps rows forever). The server deletes older rows at start and every hour,
in batches.

## Reading it

- **In the panel**: *Audit log* and *Usage* in the menu ([admin panel](admin-panel.md#audit-log-and-usage)): filters, paging,
  a CSV download (formula-safe, with `write_*` columns for phase, operation, approval channel, change hash, field names,
  intent id and pair state), per-tool, workspace, grant, user and day statistics, and write statistics by tool and
  approval channel with the intents that have no outcome. A member sees their own rows only.
- **Admin API**: `GET /api/admin/v1/audit` (filters `workspaceId`, `userId`, `kind`, `status`, `action`, `from`, `to`;
  newest first; keyset paging with `afterTs` and `afterId`; at most 1,000 rows) `GET /api/admin/v1/audit/stats` and
  `GET /api/admin/v1/audit/write-stats` (owner and admin; reads the newest 3,000 write rows of the window). See the [admin API reference](../reference/admin-api.md).
- **Command line**: `agility-bridge audit tail`.
- **The database**, read only, for example:

```sh
sqlite3 -readonly ~/.local/share/agility-bridge/agility-bridge.db \
  "SELECT datetime(ts/1000,'unixepoch'), kind, action, status, workspace_id, asset_numbers FROM audit_log ORDER BY ts DESC LIMIT 20"
```
