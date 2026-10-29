# Write tools

> The write **framework** (P7-01) and the **approval page** (P7-02) are built and tested on fakes, with the wave-1 tools (P7-04) and the lifecycle tools (P7-06); they are
> verified against a writable sandbox in P7-07. Until then no release offers a write tool, and nothing below changes
> what a running server does. [ADR-0013](../adr/0013-opt-in-writes-human-approval.md) is the policy this page explains.

agility-bridge is read-only by default. A write tool changes something in Agility (a status, a comment, an owner), so it
is absent unless **every** layer below enables it, and every write is checked, approved by a person, re-checked and
audited by one shared pipeline that no tool can skip.

## Who enables what

| Layer | Setting | Where |
|---|---|---|
| Server switch | `AB_WRITE_TOOLS=on` | the server environment (default off) |
| Workspace | `writePolicy.enabled` and the tool named in the workspace's tool list | admin API or panel, **owners only** |
| Grant | the tool named in the grant's tool list ("all tools" never includes a write) | admin API or panel, **owners only** |
| Credential | the user's **personal** Agility credential (a shared credential never writes) | the grant's credential |
| OAuth | the `mcp:write` scope, with its own consent that is never remembered | the consent screen |
| stdio | `AB_WRITE_TOOLS=on` and the tool named in `AB_TOOLS` | the MCP client's `env` block |

Remove any one and the tool is not in `tools/list`. If a client calls it anyway the answer is `AB_TOOL_DISABLED`, before
anything is read from or sent to Agility. Where an owner has enabled writes, the owners also decide where they may land:
an administrator cannot add projects or asset types to such a workspace, or widen such a grant
([THREAT_MODEL](../THREAT_MODEL.md) T31).

## What a write does

1. **Validate and plan.** The tool checks every argument against the instance's metadata, resolves **one** target, checks
   it is inside the grant's projects, reads its current values and builds the *canonical mutation*: the target, the
   fields, and for each field `old → new`. No delete, no change by filter, no change to more than one asset.
2. **Dry run** (`dry_run: true`). Returns exactly that plan, the approval text it would show, whether the change is
   already there, and which approval channel this client has. Nothing is sent, nothing is audited.
3. **`confirm: true`** is required to apply. It is only a guard against accidents: it is **never** approval.
4. **Approval.** A person sees the *whole* change and approves it (below). The approval is bound to a hash of the tool,
   the actor, the target and every field with its old and new value; it is valid once and for a few minutes.
5. **Re-read.** The target is read again. If it changed since the plan, the write is refused with `AB_WRITE_CONFLICT`
   (plan again and ask again). If it already holds the new values (someone else made the same change), the call is an
   idempotent no-op.
6. **Intent audit.** The intent is stored durably **before** the change is sent. If it cannot be stored the write is
   refused (`AB_WRITE_AUDIT_UNAVAILABLE`).
7. **Send once.** One request to Agility. It is never retried, not even after a timeout: the error then says the change
   may or may not have been applied, and to look at the item before repeating.
8. **Outcome audit.** The result is recorded next to the intent. The answer notes that Agility may take a moment to show
   the change.

A change already present at plan time is a no-op too: no approval, no audit, nothing sent.

## Approval

The approval text shows the target (type, number, OID), the number of changes and, for each, the field with the old and
the new value, then a short change id that matches the audit row. Values are JSON-quoted and sit inside the
untrusted-data envelope, so text from Agility or from the agent cannot pose as part of the question. **A change too large
to show whole is refused, never truncated** (at most 24,000 characters of approval text, 8,000 per value, 20 changes);
values with control, invisible or bidirectional characters are refused because the person could not see them.

| Client | Channel |
|---|---|
| Claude Code, Copilot CLI, VS Code (2026-07-28), stdio with an eliciting client | **elicitation**: the client asks, the person answers |
| 2025-era clients over remote HTTP (Copilot in JetBrains, Cursor), mobile apps | the **approval page** (P7-02): the call answers `AB_WRITE_APPROVAL_PENDING` with a link |
| A client that does not declare elicitation, and no approval page | refused: `AB_WRITE_APPROVAL_UNAVAILABLE` |
| `AB_WRITE_APPROVAL=off` (stdio only) | none: the write is applied after `confirm: true`; the server warns at start |

The server checks the request's declared capability **before** asking. `whoami` and every dry run report the channel this
client has (`elicitation`, `page`, `not_required` or `unavailable`). A user who declines gets `AB_WRITE_APPROVAL_DECLINED`;
the agent should ask what to change instead of repeating the call.

How the elicitation works: on 2026-07-28 the first call returns `input_required` with the question and a sealed state; the
client asks the person and repeats the call with the answer. The state is an HMAC over the nonce, the change hash, the actor
and an expiry; the matching ledger entry is taken (once) when the answer arrives. A forged, replayed, expired or
other-change state never approves anything: the pipeline simply asks again. On a 2025-era connection that keeps its
capabilities (stdio) the server sends an `elicitation/create` request instead. A stateless 2025-era HTTP request carries no
capabilities, so it cannot be asked (verified in P0-07).

## The approval page

For a client that cannot ask, the first call answers `AB_WRITE_APPROVAL_PENDING` and the hint holds a link,
`<AB_PUBLIC_URL>/admin/approve/<id>`. The person who made the request opens it in the panel (signing in if needed), reads
the whole change (workspace, item, every field with the value now and the value it will become, the change id) and presses
**Approve** or **Decline**. Then the agent **repeats the same call**; that call finds the approval and applies the change once.

- Only the signed-in person whose grant made the request can see or answer it; anyone else (another user, a link forwarded to
  a colleague, an administrator) gets "not available", the same as for an expired or used link.
- Approving needs a recent sign-in (the page sends you to sign in again, then back to it); declining does not.
- An approval is for **one** repeat of **exactly** this change, in **this** workspace, for ten minutes. A different value, item,
  tool or workspace asks again; so does a second repeat. A decline makes the next call fail as `AB_WRITE_APPROVAL_DECLINED`.
- The same pending change asked again before the person acts gets the same link; at most 20 requests are open per person.
- Available only on a server with `AB_WRITE_TOOLS=on` **and** sign-in configured, for grants that belong to a user (a service
  grant has nobody to sign in). Otherwise the answer is `AB_WRITE_APPROVAL_UNAVAILABLE`.
- Each decision is an admin audit row (`write.approval.approved`, `.declined`, `.refused`) with ids, field names and the
  change hash, never a value. While a request is open its values sit in the storage `kv` table (at most ten minutes).

## Where the state lives

| | Remote (Node server, Cloudflare Worker) | stdio |
|---|---|---|
| Approval ledger and pending page requests | the storage `kv` table; `take` hands each entry out once | process memory, bounded (no page) |
| Round-trip state key | derived from the master key, so any isolate can verify it | random per process |
| Intent and outcome | `audit_log` rows of kind `write`, stored before the change | **a log line on stderr** (weaker: no table) |

A `write` audit row holds the tool, the operation, user, grant, device, workspace, the target type, OID and number, the
**names** of the fields, the hash the approval bound and the approval channel. It never holds a value (values may be
customer text); the hash lets you match a row to what was approved. Intent and outcome are two rows (`details.phase`).

## Limits

Every write takes one unit from two counters after the approval and before the re-read: the **grant's** (default 20 an
hour, `AB_WRITE_RATE_PER_GRANT_HOURLY`) and the **deployment's** (default 200 an hour, `AB_WRITE_RATE_DEPLOYMENT_HOURLY`).
The counters are fixed hourly windows in the shared `kv` table, so they hold across Workers isolates and Node replicas
(stdio counts in its own process and has no deployment limit). The write limit cannot be switched off, and it **fails
closed**: if the counters cannot be reached the write is refused (`AB_WRITE_LIMIT_UNAVAILABLE`), never allowed.

- Over a limit: `AB_LIMIT_RATE` with the scope (`grant` or `deployment`), the limit and the seconds until the next hour.
  The refusal makes no read of the target and no send, and writes no intent audit row.
- A unit is spent when the limiter runs and is not refunded: an approved write that turns out to be a conflict, an
  already-applied no-op or a failed send still counts. A declined or unavailable approval counts nothing.
- A window is a clock hour, so a burst across a boundary can reach twice the limit; an exact sliding window needs the
  optional Durable Object limiter (P3-12). The decisions are D-168 to D-171.

## Errors

| Code | Meaning | What the agent does |
|---|---|---|
| `AB_TOOL_DISABLED` | a layer is missing for this connection | tell the user; do not retry |
| `AB_INPUT_INVALID` | `confirm` missing, value too large or not showable, argument invalid | fix the call |
| `AB_WRITE_APPROVAL_UNAVAILABLE` | this client cannot ask a person | use another client or the approval page |
| `AB_WRITE_APPROVAL_PENDING` | approve on the page (link in the hint), then repeat the call | wait for the person |
| `AB_WRITE_APPROVAL_DECLINED` | the person said no | ask what to change |
| `AB_WRITE_CONFLICT` | the target changed since the plan | read, plan again, ask again |
| `AB_WRITE_AUDIT_UNAVAILABLE` | the intent could not be stored, nothing was changed | try later; tell the administrator |
| `AB_LIMIT_RATE` | the grant or the deployment used its write limit for this hour; nothing was changed | wait for the next hour; do not loop |
| `AB_WRITE_LIMIT_UNAVAILABLE` | the limiter could not count, so nothing was changed | try later; tell the administrator |
| `AB_AGILITY_*` | Agility refused or failed; the change may or may not have been applied | look at the item before repeating |

All of them are tool errors (`isError: true`), never a successful result with `applied: false`.

## For an operator

1. Set `AB_WRITE_TOOLS=on` (a start-up warning says so).
2. As an owner, enable writes on the workspace and name the write tools in the workspace and grant lists; the grant needs a
   personal credential.
3. Check with a dry run from a real client: it names the approval channel. A client that reports `unavailable` cannot write.
4. In stdio, `AB_WRITE_APPROVAL=off` is for your own machine and your own token only; shared deployments always require
   approval ([D-10](../pending-decisions/phase-0.md)).

## The tools (wave 1)

Each acts on **one** work item, found by number or OID inside the workspace (an item outside the workspace's Agility
projects answers "not found"), and refuses a denied asset type before any request. Relation values show as
`Name [OID]` so the approval is readable and the approval binds the identity.

| Tool | Changes | Notes |
|---|---|---|
| `update_status` | `Status` of a Story, Defect, Task, Test or Epic | `new_status` is a name or OID from the item's own workflow (a status of another team, or an inactive one, is refused). It never closes the item. |
| `add_comment` | creates a comment (an `Expression` that mentions the item) | At most 4,000 characters of plain text, shown whole in the approval; control, invisible and bidirectional characters are refused. The same text as your latest comment on the item is a no-op. Allowed on closed items. |
| `log_effort` | creates an effort entry (`Actual`) for **you** | `hours` (0.01 to 24) and `date` (UTC, not in the future, within the history limit). The mutation shows the item's logged total before and after. An identical entry (item, you, date, hours) is a no-op. |
| `assign_owners` | `Owners` of a Story, Defect, Task, Test or Epic | `add` and `remove` (at most five members in all, resolved like `list_members`); only the difference is sent. |
| `move_to_sprint` | `Timebox` of a Story or Defect | The sprint must belong to the item's own project schedule and be open. |

A closed, deleted or template item is refused (comments may still be added to a closed one). If the item disappears, closes
or changes between the plan and the send, the call is `AB_WRITE_CONFLICT`. These request shapes are the documented ones and
are not yet verified against a real instance ([RESEARCH](../RESEARCH.md) §1.5, P7-07).

## Closing and reopening (lifecycle tools)

| Tool | Does | Notes |
|---|---|---|
| `close_asset` | closes one Story, Defect, Task, Test or Epic | **destructive**. Refused while the item has open child items (the count is in the message); the approval shows `OpenChildren 0 -> 0`. Closing a closed item is a no-op. |
| `reopen_asset` | reopens one closed item | **destructive**. Reopening an open item is a no-op. |

They are two tools so an owner can enable one without the other (name each in the workspace and grant lists). The state
change is an Agility *operation* (`POST .../Data/<Type>/<id>?op=<Name>`, no body); the name comes from the instance's
metadata for that type (close: `QuickClose`, `Close` or `Inactivate`, whichever the type has; reopen: `Reactivate`), is shown
in the approval as `Operation: close_asset:QuickClose` and is part of what the approval binds. A type that has no such
operation is refused before anything is asked. The approval shows the item, its state (`Open` to `Closed`) and its open
child count; if a child is opened, or the item is deleted, before the send, the call is `AB_WRITE_CONFLICT`; if someone else
already made the change it is an idempotent no-op. Agility's own validators still run when the operation is sent; the
operation names and what they cascade to are *unverified* until the sandbox run (P7-07, [RESEARCH](../RESEARCH.md) 1.5).

## For a tool author

A write tool is built with `defineWriteTool` (core `writes/`), the only way the registry accepts a `write` or
`destructive` tool. It declares its arguments, its field allowlist per asset type, and three functions; the framework adds
`dry_run` and `confirm` and runs everything else.

```ts
export const updateStatus = defineWriteTool({
  name: 'update_status', title: 'Update status', kind: 'write', cost: 6, idempotent: true,
  description: 'Set the status of one story or defect.',
  inputSchema: z.object({ item: z.string(), status: z.string() }),
  allowedFields: { Story: ['Status'], Defect: ['Status'] },
  plan: async (input, ctx) => ({ mutation: { operation: 'update_status', target, changes: [{ field: 'Status', old, new }] }, version, label }),
  reread: async (plan, ctx) => ({ values: { Status: current }, version }),
  send: async (plan, ctx) => { await client.restWrite(/* … */); return { oid }; },
});
```

Rules: `plan` validates fully and never sends; values come from validated metadata, never from string-built queries
([ADR-0012](../adr/0012-structured-query-no-raw-passthrough.md)); `send` makes **one** Agility write request (the client
never retries writes) and is called at most once; `cost` covers the plan's reads, the re-read and the send; the group is
always `writes`. Tests use the fakes in `packages/core/test/helpers/writes.ts`; every new tool adds the negative
authorization tests the [tool conventions](../dev/tool-conventions.md) ask for.
