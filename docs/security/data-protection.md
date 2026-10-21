# Data-protection inventory

> Personal and customer data agility-bridge stores or passes on: where, why, for how long, how it is deleted or
> exported, and what reaches the language model (L-120, THREAT_MODEL A7, A11). The local stdio mode stores nothing.
> `scripts/test/security-inventories.test.ts` fails when a stored column of a person-related table is missing here or a
> link breaks.

## Stored by the server (`serve`; the Worker later)

All in the server database ([schema](../../packages/storage/src/schema.ts),
[migration](../../packages/storage/src/migrations/0001-init.ts)), files `0600` in a `0700` directory
([storage guide](../dev/storage.md)).

| Table | Personal data | Why | Retention | Deletion |
|---|---|---|---|---|
| `users` | `email`, `displayName`, `idp` + `idpSubject` (sign-in identity), `role`, `createdAt`, `updatedAt`, `disabledAt` | Who may administer or use workspaces | Until deleted | `user disable`; deletion is refused while the user owns credentials or grants (revoke or delete those first) |
| `credentials` | The member's Agility token (**encrypted**, AES-256-GCM: `tokenCiphertext`, `tokenIv`, `keyVersion`; [cryptography](cryptography.md)), `tokenHint` (last 4 characters), `memberOid`, `memberName`, `memberUsername` (often an email), `reachableScopeIds`, `ownerUserId`, `label`, `validationStatus`, `validationErrorCode`, `validatedAt`, `createdAt`, `updatedAt`, `revokedAt`, `id`, `instanceId` | Calling Agility as that member; showing whose token it is | Until deleted; revalidated every 24 h | `credential revoke`, then `credential delete` (refused while grants use it) |
| `access_tokens` | `label` (the device, e.g. "Ann's laptop"), `lastUsedAt` (at most every 5 minutes), `prefix`, `tokenHash` (SHA-256 only), `grantId`, `createdAt`, `expiresAt`, `revokedAt`, `id` | One revocable token per device | Until deleted (default expiry 90 days) | `token revoke`; deleting the grant or workspace deletes them |
| `grants` | `userId`, `label` | Who may use a workspace | Until deleted | `grant revoke` / `grant delete` |
| `audit_log` | `userId`, `grantId`, `tokenId`, asset numbers, refusal `details.ip` (client address) | Accountability (THREAT_MODEL T17) | `AB_AUDIT_RETENTION_DAYS` (default 90) | Retention only; never edited ([logging](logging.md)) |
| `kv` | Short-lived records (key-check values, rate-limit counters keyed by address, token or grant id) | Operation | Their own expiry | Expiry purge |

Not stored: Agility content (titles, descriptions, comments, custom fields), tool arguments, request bodies, plaintext
tokens, the master key, and the Agility tokens callers send to pass-through workspaces (only their HMAC fingerprint
appears, in the audit log and in memory for 5 minutes; P2-14).

**Export**: owners and admins read every record through the admin API (`GET /api/admin/v1/…`, secrets excluded) or
the CLI (`… list`, `audit tail`); the database file itself is the operator's.

## Passed on

| To | What | Controls | Code · tests |
|---|---|---|---|
| The MCP client and its language model | Tool results: Agility content the member's token can read within the workspace (titles, descriptions as text, statuses, names), always inside the untrusted-data envelope; member **emails and usernames only when the workspace enables member emails** (`memberEmails`, off by default) | Field tiers, caps, project and asset-type scope, envelope ([tool output contract](../adr/0015-tool-output-contract.md)) | [envelope.ts](../../packages/core/src/output/envelope.ts), [result.ts](../../packages/core/src/output/result.ts) · [probe tests](../../packages/core/test/tools/core.test.ts) |
| Digital.ai Agility | The member's token (to authenticate), the compiled queries | Only to the instance's pinned origin, TLS verified, no redirects | [client.ts](../../packages/core/src/agility/client.ts) |
| Nobody else | — | No telemetry (OpenTelemetry is P8-07, off by default) | |

Users of the server should know that tool results go to whichever model their MCP client uses; the server cannot
control what that provider retains (THREAT_MODEL A11).
