# agility-bridge

## 0.7.0

### Minor Changes

- f04771d: Approval policy (P7-26): an owner can require the approval page for every write, per workspace (`writePolicy.approval: page_only`) or per grant (`rateLimit.writeApproval: page_only`). Under it a client that can elicit is never asked, so a client that accepts every question cannot approve. The default stays as it was.
- 26203bd: Out-of-band approval page (P7-02): a write that the client cannot ask the person about now answers `AB_WRITE_APPROVAL_PENDING` with a link to `/admin/approve/<id>` in the signed-in panel, where the person who made the request reviews the exact change and approves or declines it; the agent then repeats the call. Single use, bound to the change and the workspace, short expiry, CSRF and a recent sign-in to approve. Only with `AB_WRITE_TOOLS=on` and sign-in configured; no write tool ships yet.
- 1377f45: Approval request limits (P7-27): a connection can ask for at most 30 approvals an hour (`AB_LIMIT_RATE`, scope `approval_requests`; nobody is asked past it), and a person with 20 approvals waiting on the page gets a refusal for the next one instead of losing the oldest.
- 21b26b6: Relations on create and update (P7-21): `create_work_item` takes `owners` (at most three members), `team` and `sprint`, and `update_fields` takes `parent` (re-parent under an epic, or a task or test under a story or defect of its own project) and `project` (move a story, defect or epic to another open project of the workspace; an item in a sprint is not moved). Each is found inside the workspace's projects, shown old to new in the approval and re-checked before the write. The declared costs of both tools grow with the new paths. The request shapes are unverified until the sandbox run.
- 8e5c316: Show the OAuth write scope on My access and on the administrators' Connected apps list (P7-32): each connected app is marked "can ask for changes" (its authorization holds `mcp:write`) or "read only", and `canWrite` is in `GET /api/admin/v1/me/oauth-devices` and `GET /api/admin/v1/oauth/devices`. No scope string is shown, and the way to remove it is still to disconnect the app.
- 4051a0b: OAuth `mcp:write` scope (P7-24): an app that signs in with OAuth can ask for `mcp:write` next to `mcp:read`; the consent screen then shows a separate, never-ticked, never-remembered "allow changes" box, and the scope is granted only when the server switch, the workspace, the grant and a personal credential allow writes. The token's scope reaches the access layer, so a token without it never lists or runs a write tool; a refresh keeps the scope and cannot add it. `mcp:write` is advertised only with `AB_WRITE_TOOLS=on`.
- 168d94d: A list of my pending approvals (P7-14): `/admin/approve` in the panel (linked from My access) lists the signed-in person's own open write requests with the tool, item, workspace, field names and expiry, and a link to each request's page. It shows no values and never another person's request.
- d287c8f: A per-grant write limit (P7-15): an owner (with a recent sign-in) can give a grant its own writes per hour, in the panel's grant form or as `rateLimit.writesPerHour` in the admin API. The write limiter uses the lower of it and `AB_WRITE_RATE_PER_GRANT_HOURLY`, a value above the server's is refused, and the change is audited with the previous value.
- 007216a: Wave-1 write extensions (P7-17), as arguments of existing tools: `move_to_sprint` takes `to_backlog: true` to take an item out of its sprint; `log_effort` takes `member` to log for another member who already owns the item (otherwise refused before any approval; the approval names the member); `update_fields` takes `todo` for the remaining hours of a task or test. Each shows old and new in the approval. The request shapes are unverified until the sandbox run.
- c17b7da: Workspace-enabled writable custom attributes (P7-20): an owner lists the `Custom_` attributes an agent may write per workspace (panel, `PATCH /workspaces/{id}` with `writePolicy.customFields`, or `AB_WRITE_CUSTOM_FIELDS` for stdio), and `create_work_item` and `update_fields` accept them in a `custom` argument as text, long text or a number, checked against the instance's own attribute. Anything not on the list is refused before any request; the approval shows each value old to new; no tool description names an instance attribute. The request shape is unverified until the sandbox run.
- a823608: Write approvals (P7-28): an approval is now used up just before the change is sent, not when it is found, so a limiter refusal, a conflict or an audit outage no longer makes the person approve again. It stays single use: two concurrent calls on one approval send once.
- 8b4e735: Write rows in the audit viewer, CSV and statistics (P7-11): the panel pairs each write's intent with its outcome and shows the tool, target, field names, approval channel and change hash; an intent with no outcome after ten minutes is flagged. The CSV gains `write_*` columns, and `GET /api/admin/v1/audit/write-stats` (owner and admin) with a Writes section on the Usage page counts writes by tool, approval channel and outcome. A member still sees only their own write rows.
- 40404f9: Show the remaining write budget (P7-16): `whoami` and every write tool's dry run report the caller's own grant's writes used, left and the end of the hour (and that the deployment is spent), and an owner or administrator sees the server-wide use on the panel overview and a grant's use on its page (`GET /api/admin/v1/writes/budget`, `GET /api/admin/v1/grants/{id}/write-budget`). Reading takes no unit and a store that cannot be read shows "unknown", never "unlimited".
- c2619f5: Write framework (P7-01): the pipeline every future write tool will use (enablement layers, dry run, `confirm`, approval by elicitation, single-use approval ledger, re-read and conflict check, idempotent no-op, durable intent audit before the change, one send, outcome audit). `AB_WRITE_TOOLS` and `AB_WRITE_APPROVAL` are now parsed; no write tool ships yet, so nothing changes for a running server.
- ed4da13: Write limiter (P7-03): every write takes one unit from a per-grant and a deployment-wide hourly counter (defaults 20 and 200, `AB_WRITE_RATE_PER_GRANT_HOURLY`, `AB_WRITE_RATE_DEPLOYMENT_HOURLY`). The counters live in the shared storage, so they hold across Workers isolates and replicas, and the limiter fails closed (`AB_WRITE_LIMIT_UNAVAILABLE`). A refused write makes no upstream call. No write tool ships yet.
- 35081a9: Lifecycle write tools (P7-06): `close_asset` and `reopen_asset`, `destructive` and separately enabled in the opt-in `writes` group. Each acts on one work item, sends the type's own Agility operation (chosen from its metadata) once after approval, refuses a close while the item has open children, and treats an already-closed or already-open item as a no-op. The operation names are verified against a sandbox in P7-07.
- a9c410b: Write tools, wave 1 (P7-04): `add_comment`, `update_status`, `log_effort`, `assign_owners` and `move_to_sprint`, in the opt-in `writes` group. Each changes one work item, shows the exact change (old to new) for approval, re-reads the target before sending and sends once; they are absent unless `AB_WRITE_TOOLS=on` and an owner enables them per workspace and grant. The request shapes are the documented ones and are verified against a sandbox in P7-07.
- 4cc7a4b: Write tools, wave 2 (P7-05): `create_work_item` (a story, defect, task, test or epic in a project of the workspace; a task or test under its parent) and `update_fields` (title, description, estimate and priority of one open item). Typed fields per asset type only: no custom attributes, project, status, owner, sprint or parent changes. Each shows the exact change for approval (every field of a new item, old to new for an update), a repeated create is refused instead of creating twice, and both are absent unless `AB_WRITE_TOOLS=on` and an owner enables them. The request shapes are verified against a sandbox in P7-07.

### Patch Changes

- 69fcb1f: Write approvals (P7-29): a value that contains the words "untrusted data" is shown exactly as it will be sent (the first letter is written as a JSON escape) instead of being rewritten to "untrusted~data".
- 222f1f7: Workers Free plan (P7-30): the deployment-wide write cap defaults to 60 an hour there (200 elsewhere) and a larger `AB_WRITE_RATE_DEPLOYMENT_HOURLY` stops the Worker at start, so write traffic alone cannot exceed the plan's D1 row budget. The grant and denial of an approval are read with one statement.
- 8cee179: Writes cost fewer storage round trips: the approval grant and denial reads run only where the approval page exists, and `kv.list` and `kv.deletePrefix` on SQL storage (D1 and SQLite) read a key range instead of scanning the table. `close_asset` counts open children in one request and `create_work_item` looks up the caller once. The write tools' declared costs now follow their measured worst case (`assign_owners` 18, `reopen_asset` 10, `create_work_item` 20, `update_status` 15, `add_comment` 18).
- 4a69552: Write path review fixes (P7-09): a timeout or unavailable error from a write now always says the change may or may not have been applied, and a 2xx answer with an empty or unreadable body is an applied write; `close_asset` refuses when it cannot count every child; text from Agility is cleaned for display and no longer blocks a write; zero-width joiners between visible characters are allowed in your text; the comment and effort no-ops apply only within 10 minutes; the approval page cleans and caps the title; 2026-07-28 approval rounds are bound to the workspace and instance; overwriting tools advertise `destructiveHint`; the write limiter is required and a refused check spends nothing; the create duplicate check handles unreadable times; `update_fields` refuses to overwrite a rich description.

## 0.6.0

### Minor Changes

- 86b116a: `get_attachment` reads long text in steps: `offset_characters` and `nextOffset` (each step downloads the attachment again).
- 3b30c41: Collaboration tools: `get_conversations` (comments of an asset, newest first, paged), `list_attachments` (attachment
  metadata and external links as text) and the opt-in `get_attachment` (text of one attachment, off by default in its own
  `attachments` group). The download is enabled per workspace (`attachmentDownload`, `attachmentMaxBytes` limits; a grant
  can only turn it off or lower it) or with `AB_ATTACHMENT_DOWNLOAD`, `AB_ATTACHMENT_MAX_BYTES` and `AB_ATTACHMENT_TYPES` in
  stdio; it checks scope through the parent asset, the content type on the metadata and the response, counts the size on
  the stream, and is audited.
- 3d4f694: Composite reports in a new opt-in `reports` group: `sprint_health`, `standup_summary`, `release_readiness`, `defect_triage`
  and `work_item_quality` (scored with the versioned rubric). Each report reads through its sibling tools with the call's own
  scope and budget, skips and names any section whose tool the caller was not granted, and never turns missing data into a
  zero. The group is off by default: enable it per workspace (limit `reports`; a grant can only turn it off) or with
  `AB_REPORTS=on` in stdio. `search_work_items` now lists `changedAt` when sorted by recent change.
- 8ffe617: `defect_triage` shows each defect's priority and severity where the instance has them and orders the flagged list by the instance's own priority rank.
- 8fa45c3: New tool `get_sprint` (planning group): one sprint with its UTC dates and schedule, backlog items and defects by status category, committed (at the begin date) vs done, scope change, carry-over of a finished sprint and a daily burndown read from bounded history. Sprint names and OIDs now also resolve closed (finished) sprints, and a status without a rollup category is no longer counted as "not started".
- 35065d4: New tool `get_velocity` (planning group): the completed estimate of the last past sprints of a team or Agility project,
  each read as it ended, with the average over the sprints read in full; sprints that cannot be read are named, never
  estimated. Capacity is not reported.
- e991057: New tools in the `history` group: `get_asset_history` (what changed on one asset in a bounded window, from the authoritative Agility history, one row per changed field with who and when) and `list_recent_changes` (work items changed in a bounded window in a project, a team or the workspace, newest change first). Both validate the window and the row limit before any request; the activity stream is not used.
- 6447ef0: MCP prompts: `review_backlog_item_quality`, `sprint_review`, `standup`, `triage_defects`, `draft_release_notes`,
  `refine_backlog` and `explain_asset`, registered from one manifest and offered (`prompts/list`, `prompts/get`) only when
  every tool they use is allowed, on stdio and HTTP. A prompt is static text that tells the model which tools to call, to treat
  what they return as untrusted data and to stay read-only; its string arguments are validated and never reach a query. The
  three that use report tools need the opt-in `reports` group.
- 4d5ff63: MCP resources: the server now offers reference material an agent can read on demand: the structured filter vocabulary, the instance's asset types (and one resource per readable type), the allowed Agility projects as a tree, and the versioned backlog item quality rubric. Resources are served through the tool handlers with the same limits, cache, scope rules, untrusted-data envelope and audit as the tools, and a resource is offered only when the tools it is served through are allowed for the workspace and grant.
- ba6301b: OAuth: `AB_OAUTH_CIMD_HOSTS` limits metadata-document clients to a list of host names; any other client id is refused before
  anything is fetched.
- 947ef44: OAuth: My access shows when each connected app was last used, and `AB_OAUTH_IDLE_TTL` (off by default) ends an app that
  nobody has used for that long at its next refresh.
- 930983f: Issues, requests, goals, themes and retrospectives are first-class through the generic tools: four recipe resources (issues, requests, goals and themes, retrospectives) with example `query_assets` and `get_assets` inputs, offered when those tools are allowed, and a default field tier that includes the owner of issues (which have a single owner). No new tools.
- 59df125: Add the `portfolio` tool group: `list_portfolio_items` (epics with category, status, parent, estimates and child counts, filtered and paged) and `get_portfolio_tree` (an epic with its descendant epics and roll-ups of items, done items, open defects, estimate and done percentage; a depth, size, budget or permission cut is reported as `partial` and marks the roll-ups it touches `incomplete`). The stdio server serves the group by default.
- 878a99c: `get_portfolio_tree` continues a very large epic with a `cursor`: the totals are carried between steps and the last step is exact.
- 7f80d5f: Prompt argument completion: `completion/complete` suggests teams, projects and sprints (and `current`, `previous`, `next`) for the prompts that are offered, through the list tools the caller is granted.
- dcc0870: Quality recipes: two new MCP resources (`agility-bridge://recipes/tests-and-defects` and `agility-bridge://recipes/regression-assets`) with worked `query_assets` calls for tests, defects, regression tests and test sets. They are offered only when the generic query and metadata tools are allowed. No new tool.
- d581ab3: New report `quality_scan` (opt-in `reports` group): scores the open stories and defects of a sprint or an epic with the same versioned rubric as `work_item_quality`, weakest first, from one batched read; more than 50 items per type are reported as partial.
- 32ca06a: `list_recent_changes` now includes epics (portfolio items): `asset_type` accepts `Epic`, and with no type given epics are listed with the work items, newest change first, under the same bounded window, scope and team filters.
- 3e10700: `agility-bridge user unbind --to <provider> [--ttl-minutes N]` (and `provider`, `ttlMinutes` in the admin API and a field in
  the panel) narrow who can claim an unbound account: only a verified sign-in at the named provider can bind it while the
  claim lasts (default 24 hours, at most 7 days).

### Patch Changes

- 1c9b48e: `whoami` names the granted tools the per-call budget hides (with their declared cost); the admin panel shows the same note on a workspace or grant with an explicit `callBudget`.
- 2e8c8ef: `get_sprint`: a burndown history request that exceeds the response limit now leaves out its points (named in `notes`,
  `partial`) instead of failing the whole call; large page sizes send fewer queries per request.
- 636cd4a: Consistency pass over the 26 tools (P6-12). Shared arguments (`asset`, `project`, `team`, `sprint`, `member`, `time_range`, `status`, `limit`, `cursor`, `format`, `include_closed`, `minimal_output`) now have one description each, from one schema, and every tool uses it; titles, the paging and cost sentences and descriptions open the same way everywhere ("Cold call: up to N Agility requests"). `list_members` now refuses a cursor that is not its own even when the workspace's projects list no members. `list_my_work` and `list_recent_changes` rows start with the identity columns like every other list (`number`, `assetType`, `oid`, `state`, `project`, then the tool's own columns). `get_sprint` (not yet released) names its counts `itemCount` instead of `items` (`totals`, `byStatusCategory[]`, `committed`, `planned`, `carryOver`, burndown points), and `sprint_health` reads them under the new name. `get_assets`, `list_asset_types`, `get_team`, `get_work_item` and `whoami` now declare the `partial` and `notes` keys they already returned in their output schemas. The advertised output schemas no longer repeat `additionalProperties: {}`: the default `tools/list` shrank from 39,179 to 35,892 bytes and the every-group one from 47,946 to 44,157 bytes, and the tool descriptions were reworded so the lexical router eval improved (65.8 % to 75 % top-1). No argument or released output field was renamed, so there is no deprecation alias.
- 0ab45f7: `whoami` and the admin panel (workspace and grant pages) now warn when a composite report is granted without the sibling
  tools it reads. The admin API's tool catalogue (`GET /tools`) lists each composite's `siblings`. The cost of every tool is
  now tested against its declared worst case in one test over the whole catalogue.
- ed94256: A malformed cursor is refused as `AB_INPUT_INVALID` before any name is resolved or request made, in every paged tool.
- b2cbccb: `get_work_item` renames its `minimal_output` argument to `skip_related` (it leaves out children, links and comments), so `minimal_output` means one thing everywhere (identity columns only). The old name is **deprecated**: it still works on `get_work_item` for one release (mapped to `skip_related`, with a deprecation note in the result, not advertised in `tools/list`) and will be removed in 0.7.0. Small internal helpers were deduplicated.
- 696a104: `defect_triage` lists the most similar duplicate pairs first, says when pairs or flagged defects were cut and ignores common English words in names.
- f58df3d: The admin panel's workspace and grant forms have a "Check these tools" step that shows which composite reports would be granted without the tools they read, before saving.
- dfc47d2: Tool evaluation for this release (Claude Sonnet 5.5 and Opus 5.5, through the maintainer's router): no injected instruction
  followed in 70 trials; tool choice 86.3 % and 90.4 % allowing one lookup. Reports: `docs/dev/eval-reports/2026-10-28-sonnet-5-5.md`
  and `docs/dev/eval-reports/2026-10-28-opus-5-5.md`, with the caveats in `docs/dev/evals.md`.
- 75ed44c: The Worker keeps parsed asset-type metadata in D1 so a new isolate reads it instead of asking Agility for every type again (fewer upstream requests on a cold call), and prompt argument schemas are converted at module load.
- eb11a63: OAuth apps page and `GET /oauth/abuse` (owners): registration caps against their use, the configured limits and the limit
  refusals of the last 24 hours, without any address or client.
- 6a18cb1: The panel's users list is paged on the server (`GET /users` accepts `limit`, `offset` and `ids`) and the audit page loads at
  most 100 users for its filter, so both screens cost the same at a few hundred users.
- 42a606a: Phase 6 review fixes (P6-13), in tools not yet released. `get_asset_history` now refuses a window older than `maxAsOfAgeDays`, does not follow `Scope`, ignores the order of multi-valued relations, and explains an over-long history instead of a generic size error. `get_attachment` no longer echoes the uploader's content type in an error message, no longer repeats the text in `structuredContent`, and audits the asset and attachment id of a refused or failed download. `release_readiness` can say `ready` for an epic with more than 100 backlog items, and a roll-up percentage is by estimate only when every item has one (`unestimatedItemCount` says how many do not). `defect_triage` reads the oldest change first (`search_work_items` gains `sort_by: oldest_changed`) and tokenises each name once; `work_item_quality` checks Given/When/Then in linear time. `get_sprint` says when closed items without a status category are done now but remaining at earlier burndown points, and reports `partial` when rows outside the workspace were left out, as the composite reports now do. `resources/list` makes no Agility request, independent metadata loads go out together, prompt arguments refuse Unicode format characters, the stdio server serves the `history` group, and the redaction of large plain text is about 30 times faster.
- a3327c7: `work_item_quality` (rubric 1.1.0): an estimate of 0 counts as not estimated, a priority that was not read names why (budget, permission, no field, failure) and a description cut at 4,000 characters is reported.
- 02b5460: `query_assets` names goals, themes and retrospectives among the asset types it reads, so agents route questions about them to it.
- 4093f02: An OAuth device now survives a token refusal that can pass (P5-21, D-77, ADR-0018). Refusals at a code exchange, a refresh or a repeat inside the refresh reuse window are final or recoverable. Final ones (access grant revoked, ended or deleted, person removed, client revoked, and so on) still end the device at once. Recoverable ones (workspace, instance or person disabled, credential revoked or not validated, no project, no tool) answer `503 temporarily_unavailable` with `Retry-After: 60`, keep the device and its refresh token, and write `oauth.token.refused` with `revoked: false`; once the cause is fixed the app refreshes with no new approval. Access tokens are still refused on every MCP request while the reason holds. A code exchange refused this way still spends the code.
- 11c9772: The two sections of `sprint_health` and `standup_summary` run together and share the member, team, project and sprint
  resolution within a request.
- c2157ce: A tool argument the input schema refuses (below the minimum, outside an enum, missing, wrong type) is now an
  `AB_INPUT_INVALID` tool error with the argument path and a hint, like every other refused input.
- f86f954: `sprint_health` reports the fixed-wording notes of `get_sprint` as its own text with stable codes (`sprintNoteCodes`) and keeps any other sibling note inside the untrusted-data envelope.
- 2704a08: `get_sprint`: burndown history requests are sent up to three at a time, the first two item pages share one request, and
  each history point is compiled once.
- 252c58b: `get_sprint`: sprints of up to 1,000 items are read in full (five to ten pages), with fewer burndown points instead of
  none; the history queries per call stay at 60.
- eacf0f0: The number prefixes an owner stores for an instance in the admin panel now apply when a number such as `B-01234` is resolved; types left out are still learned from Agility.
- d730a46: Device token lists read one page from storage by `(created_at, id)` instead of every token (new migration 0002, an index
  on `access_tokens`); the admin API and its cursor format are unchanged.
- 7de7232: `defect_triage` shows priority and severity again on projects with more than 50 open defects: the read of those fields used a
  filter bounded at 50 values and failed silently ("could not be read"). Found by the live check of P6-57.
- e9b0387: The owner's unbind (`POST /users/{id}/unbind`, `user unbind --to`, the panel) only accepts a provider this deployment has configured: a typo is refused with 422 before anything is written, and the panel offers a select of the configured providers.
- abd4dfa: Dates a caller selects, filters or sorts by on `query_assets` and `get_assets` (`ChangeDate`, `CreateDate`, …) are read
  through their `…UTC` siblings and returned as ISO 8601 UTC under the requested key; a zone-less date with no sibling is
  returned raw with a note. `get_work_item` and the work lists now include `createdAt`.
- 533a47e: A credential validation result is written only while the stored token is the one that was checked (one conditional
  write in storage), so a token replaced while Agility was answering can never be marked valid by the old answer.
- 50a358d: Agility's own error messages are no longer shown to the model: when Agility refuses a request, the tool error carries the
  error code, our message and a hint naming a working next step, and Agility's text goes to the server log (`agility refused
  the request`). The pre-release LLM eval showed models following an instruction planted in that text.

## 0.5.0

### Minor Changes

- 1fc3c53: OAuth abuse controls (P5-09): the authorization, consent and token endpoints, dynamic registration and metadata-document fetches now have shared, exact limits per address and per deployment, kept in the database (SQLite on Node, D1 on Workers) with atomic counters; failed token exchanges are limited per address (and, for addresses that already failed, in all). Refusals answer `429` with `Retry-After` and are audited once per window (`oauth.request.refused`). Unused registrations are swept on a schedule (Node hourly, the Worker's cron in bounded slices), and `serve` now also purges expired rows hourly. New settings `AB_OAUTH_AUTHORIZE_IP_LIMIT`, `AB_OAUTH_AUTHORIZE_LIMIT`, `AB_OAUTH_CONSENT_IP_LIMIT`, `AB_OAUTH_CONSENT_LIMIT`, `AB_OAUTH_TOKEN_FAILURE_IP_LIMIT`, `AB_OAUTH_TOKEN_FAILURE_LIMIT`, `AB_OAUTH_DCR_LIMIT` and `AB_OAUTH_CIMD_LIMIT`.
- 928072a: Add the administrators' view of OAuth (P5-08): with `AB_OAUTH=on`, owners and admins see every person's connected apps (panel page "Connected apps", `GET /oauth/devices`) and disconnect one (`POST /oauth/devices/{id}/revoke`; an owner anyone's, an admin a member's), and owners list the registered OAuth clients (dynamic registrations and metadata documents, with where they send people and how many devices use them) and revoke one (`GET /oauth/clients`, `POST /oauth/clients/revoke`, `POST /oauth/clients/restore`). Revoking a client blocks it first, deletes its registration and ends every device of it: nothing new is authorized, no token is refreshed and its access tokens stop. Every change is a POST with the panel's CSRF checks and writes audit rows without token material.
- bd692ff: OAuth client registration (P5-03): Client ID Metadata Documents (clients named by an https URL; fetched through a public-only, redirect-free, size- and time-bounded fetch, cached 5 minutes to 24 hours) and hardened dynamic registration (only the fields we use are kept, strict redirect rules, per-address and per-deployment caps, unused registrations expire after a day). New settings `AB_OAUTH_CIMD`, `AB_OAUTH_CIMD_MAX_CLIENTS`, `AB_OAUTH_CIMD_FETCH_LIMIT`, `AB_OAUTH_DCR`, `AB_OAUTH_DCR_MAX_CLIENTS`, `AB_OAUTH_DCR_IP_LIMIT`, `AB_OAUTH_DCR_REDIRECT_HOSTS` and `AB_OAUTH_DCR_UNUSED_TTL`. The Worker sets the `global_fetch_strictly_public` compatibility flag. Still unreachable until the consent screen arrives.
- d01a629: Add the OAuth sign-in and consent screen and connected apps (P5-04): `AB_OAUTH=on` now starts on `serve` and the Worker when a sign-in provider is configured. `/oauth/authorize` sends a signed-out browser through sign-in and back, then shows a consent page (the app's unverified name, where it sends you, the workspace and the access it will get; strict policy, no inline script) whose approval is a CSRF-checked post with a single-use handle bound to the exact request, so replayed or swapped forms approve nothing; `prompt=none` redirects errors only. Approved apps are listed on My access with Disconnect (and Disconnect all), at most 25 per person; an authorization request alone never ends an existing connection. New admin API routes `GET /me/oauth-devices` and `POST /me/oauth-devices/{id}/revoke` and `/me/oauth-devices/revoke-all`.
- da5136d: Publish OAuth protected resource metadata per workspace (P5-02, RFC 9728) at `/.well-known/oauth-protected-resource/w/{slug}/mcp`, and name it in the `WWW-Authenticate` challenge of every `401` on `/w/{slug}/mcp` when OAuth is on, so MCP clients that start without a token discover the authorization server and the workspace's resource themselves. The document and the challenge are identical for known, unknown and disabled workspaces. Nothing changes while OAuth is off.
- 6b3c7ee: Add the OAuth 2.1 authorization server for MCP clients (P5-01), off by default: RFC 8414 metadata, `/oauth/authorize`, `/oauth/token` (code, refresh and RFC 7009 revocation) and `/oauth/register`, with PKCE S256 for every client, RFC 8707 resources bound to one workspace, RFC 9207 `iss`, single-use codes, hash-only token storage in the database and OAuth access tokens accepted on `/w/{slug}/mcp` through the same access resolver as device tokens. New settings `AB_OAUTH`, `AB_OAUTH_ACCESS_TTL` and `AB_OAUTH_REFRESH_TTL`; `AB_OAUTH=on` is refused until the consent screen arrives. Log redaction learns the OAuth token shape.
- 58b6c02: Add the OAuth token lifecycle (P5-05): refresh tokens rotate on every use with a reuse window (`AB_OAUTH_REFRESH_REUSE_WINDOW`, default 30 s, 0-120 s), so a client that refreshes several times in parallel, or repeats a refresh whose answer it lost, keeps its connection and gets the same new tokens; a spent refresh token used again after the window, or at window 0, disconnects the whole device (access and refresh tokens) and writes an `oauth.refresh.reuse` audit row without any token. The new tokens kept for the window are stored encrypted under a key derived from the spent token and deleted afterwards. Every refresh, also a repeat inside the window, checks that the device is still connected and that the access still exists. Works on `serve` (SQLite) and the Worker (D1).

### Patch Changes

- b00cc08: OAuth fixes from the Phase 5 review (P5-10). A revocation request no longer renews an unused dynamic registration (it could be kept for 90 days with one request). At the registration cap, registrations nobody used within the hour make room, and at the stored-document cap a cached client document is evicted instead of the new client being refused, so one source can no longer hold either cap for everyone else. A client whose metadata document is temporarily unreachable gets `503` or `429` at the token endpoint instead of `invalid_client`, which made SDK clients discard their tokens and ask for approval again. The OAuth per-address limits count an IPv6 address by its /64 network, as the general limiter does. Redaction now covers a Bearer OAuth token in free text. The admin Connect page no longer calls OAuth a later release.
- 882239c: OAuth: at the dynamic-registration cap, the sweep that makes room now always looks at its full slice of registrations (it wraps round to the start of the list), so a newcomer is no longer refused, now and then, while abandoned registrations remain.

## 0.4.0

### Minor Changes

- 66d6630: Admin panel scaffold (P4-03): a server-rendered, phone-friendly panel at `/admin` on `serve` and on the Worker, built with
  Hono JSX under a strict content security policy (no inline script or style, hashed assets with SRI, no framing, Trusted
  Types) and a page and form kit with session, role, CSRF and fetch-metadata checks. Changes go through the admin API in
  process, so its guards, re-authentication rule and audit rows apply unchanged. Sign-in now lands on `/admin` (overview and
  account pages); `/auth/account` redirects to `/admin/account`, and the sign-in pages share the panel's layout.
- 02511c3: Admin screens (P4-04): the panel at `/admin` now manages instances, credentials, workspaces, grants, device tokens and
  users for owners and admins, on `serve` and on the Worker. Every change goes through the admin API as the signed-in person
  (same role rules, re-authentication and audit rows); controls appear only when the API would allow them. Agility tokens are
  typed once into a password field and never shown again; a new device token is shown once, behind a single-use form handle,
  so a reload never makes a second one; origin changes, token replacement, write settings and owner changes ask for a recent
  sign-in; the last active owner is protected with a clear message. The admin API gains `GET /tools`, and last-owner refusals
  carry `error.detail: "last_owner"`.
- a5bafcb: Admin sessions, roles, CSRF and re-authentication (P4-02): a finished sign-in starts a browser session (`__Host-`
  cookie, only a hash in the database, idle 30 min / absolute 12 h, at most 20 per user, rotated at every sign-in) that the
  admin API accepts as the signed-in user, with a CSRF token plus `Origin` and `Sec-Fetch-Site` checks on every change.
  Owner-only management and the last-owner rule apply unchanged; high-impact changes (instance origin, key retirement,
  owners and admins, credential replacement, write enablement) need a sign-in from the last 10 minutes
  (`403 reauth_required`, `/auth/reauth`). `POST /auth/logout`, `GET /auth/account`, `GET /api/admin/v1/session`,
  `POST /api/admin/v1/users/{id}/sessions/revoke` and `agility-bridge user end-sessions`. New settings
  `AB_SESSION_IDLE_MINUTES`, `AB_SESSION_MAX_HOURS`, `AB_SESSION_MAX_PER_USER` and `AB_LOGOUT_CLEAR_SITE_DATA`.
- d51cfa1: Audit viewer and usage statistics (P4-05): the panel at `/admin` gains an audit log (filters for time, kind, outcome, tool or
  action, workspace and user; keyset paging; every stored string shown as text; a formula-safe CSV download of the newest 1,000
  matching rows) and, for owners and admins, usage statistics (calls, errors, denials, Agility requests and durations per tool,
  workspace, grant, user or day). Members see only their own audit rows: `GET /api/admin/v1/audit` is now open to them and scoped
  to their user id by the server (another `userId` is refused), and it gains an `action` filter. New `GET
  /api/admin/v1/audit/stats` (owner and admin) aggregates at most the newest 10,000 tool calls of a window and reports when it
  stopped there. Storage gains `audit.stats` on memory, SQLite and D1, with no schema change.
- f8b6cdb: Connect page (P4-06): every grant has a "Connect a client" page in the admin panel (under My access for the person who holds
  it, and on the grant for owners and admins) with the workspace's MCP endpoint and a copy-paste configuration for GitHub Copilot
  in VS Code, JetBrains and the CLI, Claude Code, Cursor, Windsurf / Devin Desktop and the MCP Inspector. The page never holds a
  token; the one-time page that creates a device token repeats the snippets and fills the token in only where a client cannot read
  it from a prompt or an environment variable. The client setup guide gains the same remote snippets.
- abbcdba: Admin sign-in (P4-01): Google, GitHub, Cloudflare Access and any OpenID Connect provider at `/auth/*`, deny by default
  with allowlists and optional auto-provisioning, one identity per user. The first owner is created with a single-use
  setup link (`agility-bridge setup-link`, `POST /api/admin/v1/setup-links`) whose code travels in the URL fragment. New
  settings `AB_GOOGLE_*`, `AB_GITHUB_*`, `AB_OIDC_*`, `AB_CF_ACCESS_*`, `AB_LOGIN_*`, `AB_RATE_LIMIT_SIGN_IN` and
  `AB_IDENTITY_PRIVATE_ADDRESSES`; client secrets may come from `*_FILE`. Browser sessions follow in the next release.
- 8281ec2: Member self-service (P4-07): every signed-in person has "My access" in the panel (`/admin/me`) to add, check, replace, revoke and
  delete their own personal Agility token (checked against Agility at once, never shown again), choose which of their grants
  uses it, and issue and revoke their own device tokens, without an administrator handling the secret. Everything goes
  through the admin API as the signed-in person: another person's or a shared credential, a grant or device token that is not
  theirs, and an instance they have no grant on are refused with no effect. The admin API gains `GET /me/grants`, `POST
  /me/grants/{id}/credential` and `GET /me/audit`; a member may now delete their own personal credential; caps of 10 personal
  credentials per person and 20 live device tokens per grant apply to every writer.
- a3ff7a3: Move a user to another sign-in provider on purpose (P4-12): owners (and the break-glass admin token) can clear a user's
  provider identity with `agility-bridge user unbind <user-id> --confirm <email>`, `POST /users/{id}/unbind` or the "Move to
  another provider" page of the admin panel, so the next verified sign-in with that email binds again. It needs a recent
  sign-in, the user's email typed again and never works on your own account through a session; the clear is one compare-and-set
  step, the user's browser sessions end, and the audit log records `user.unbind` with the previous provider only.
- 4cf065a: Panel follow-ups (P4-15): a disabled user can be enabled again (`POST /api/admin/v1/users/{id}/enable`, `agility-bridge user
  enable`, an Enable button on the user's page: owners for anyone with a recent sign-in for owners and admins, admins for members);
  `GET /api/admin/v1/tokens` and a Device tokens page list every device token (prefix, label, dates and grant, never a hash), filtered
  by person or grant and paged by cursor, with revoke; and an instance's number prefixes are validated on every path and editable
  in the panel (`Type=PREFIX`, one per line). Stored prefixes are not applied to number lookups yet (P4-30).

### Patch Changes

- 23ab704: Fixes found by running the admin panel in a real browser (P4-08): a table that scrolls sideways on a narrow screen can now
  be reached with the keyboard (it is a focusable, named region), and an admin API request that sends an empty body as JSON
  is answered `400 bad_request` instead of `500 internal error`.
- c1334b9: Admin security review (P4-09): setting an instance's TLS trust (a CA file) through the admin API needs an owner with a recent
  sign-in, as the panel already said; adding projects, child projects or asset types to a workspace or grant that has write
  tools, making a workspace pass-through, and issuing a device token that lasts more than 90 days (or never expires) need a
  recent sign-in (owner for the first three); a device token issued while its grant moves to a personal token is revoked; a
  credential validation that started before a token replacement can no longer vouch for the new token; the admin API stops
  reading a request body at its 64 KiB cap; and audit rows of admin changes now record the role (and previous role), project
  and tool lists, write switches, the token id and end, and the instance host.
- 5effbc1: Log redaction now also covers the admin sign-in values (P4-11): the CSRF token and `_csrf` form field, the PKCE verifier, the
  nonce, the setup code, the session secret as an object key, and the OAuth `code` in a callback URL's query string.
- 827d13e: Updates undici to 7.30.1 for GHSA-xjj6-f33q-929c (a denial of service through a response with too many content encodings).

## 0.3.0

### Minor Changes

- 177e0e6: `agility-bridge serve` and the management commands refuse plain-HTTP instance URLs (also `http://127.0.0.1`) unless
  `AB_ALLOW_HTTP_INSTANCES=on`, meant for tests and the local synthetic Agility. New `AB_INSTANCE_PRIVATE_ADDRESSES=refuse`
  accepts only instances at public addresses, checked when an instance is added or retargeted and at every connection.
  The stdio mode is unchanged.
- ba32352: Master-key status and retirement through the admin API (`GET /keys`, `POST /keys/{version}/retire`, owners; retiring
  needs a recent sign-in and is audited), so `agility-bridge keys status` and `keys retire` work remotely too (for
  example against a Cloudflare Worker). `agility-bridge init --version <N>` writes a key for the next version of a
  rotation. `keys rotate` stays local.

### Patch Changes

- eb5d24c: Device tokens are resolved with one database round trip instead of four (the token and the records its access reads
  in one batch).
- bdcc3e9: Phase 3 review fixes: `keys retire` (and `POST /keys/{version}/retire`) refuses a version this database never used or a
  future one, and keeps the operator's reason in the audit row; `AB_INSTANCE_PRIVATE_ADDRESSES=refuse` also refuses
  IPv4 embedded in IPv6 (IPv4-compatible, SIIT, NAT64, 6to4), site-local IPv6 and the special and documentation IPv4
  ranges.
- ea56e1e: `agility-bridge serve` reads its settings and assembles its app through the code the Cloudflare Worker now shares
  (no change in behaviour or settings).

## 0.2.0

### Minor Changes

- 5cc97dc: Admin REST API for `agility-bridge serve` at `/api/admin/v1` (instances, credentials, workspaces, grants, device
  tokens, users, audit), enabled by a break-glass token from the new `agility-bridge admin-token` command
  (`AB_ADMIN_TOKEN_FILE`). Owner/admin/member guards apply to every change, secrets are never returned, and every change
  is audited. Reference: docs/reference/admin-api.md.
- ced47c2: `agility-bridge serve` keeps an audit log of tool calls (asset numbers, masked queries, durations, Agility requests),
  refused requests and admin changes — never tokens, request values or Agility content — with a retention of
  `AB_AUDIT_RETENTION_DAYS` (default 90). See docs/guide/audit-log.md.
- 7c3b1ad: `agility-bridge backup <file>` writes a consistent copy of the server database while it runs, and
  `agility-bridge restore <backup> <target>` checks and restores one; the self-hosting guide covers Node, Docker, reverse
  proxies, on-premises CAs, backups and upgrades, and a new guide covers one token per device.
- e74b966: Management commands for a server: `agility-bridge init`, and `user`, `instance`, `credential`, `workspace`, `grant`,
  `token`, `audit tail` and `keys status|rotate|retire`, either on the local database or through the admin API of
  `AB_ADMIN_URL`, with the same rules and audit. Secrets come from files, the environment, standard input or a hidden
  prompt, never from arguments. See docs/guide/cli.md.
- b031032: Stored Agility tokens are validated on save, on demand (`agility-bridge credential validate`), every
  `AB_CREDENTIAL_REVALIDATION_HOURS` and after repeated refusals; new or changed instance addresses are probed without a
  token before use. Clear messages separate a revoked token from a wrong instance address.
- dd09769: Optional pass-through workspaces (`AB_PASSTHROUGH=on`, off by default): callers send their own Agility token in
  `X-Agility-Token` over HTTPS; nothing is stored, every workspace control applies, and they are read-only. Also: the
  startup warning for `AB_RATE_LIMIT=off` is now printed.
- cdae959: `agility-bridge serve` limits requests per client address, failed authentications per address (valid tokens are never
  locked out), and requests per device token and per grant, answering `429` with `Retry-After`. Settings:
  `AB_RATE_LIMIT*` and `AB_TRUSTED_PROXY_HOPS` (docs/guide/configuration.md).
- 6d72adf: New `agility-bridge serve`: a team server over HTTP that exposes each workspace at `/w/<slug>/mcp` to per-device
  tokens, with SQLite storage, Agility tokens encrypted under a master key (`AB_MASTER_KEY_FILE`), per-workspace and
  per-grant access, and both MCP protocol eras. See docs/guide/secrets.md and docs/guide/access-model.md.

### Patch Changes

- 12008ec: `get_assets` and the single-item tools keep only the assets that were asked for: an Agility response that ignores the
  number or OID filter can no longer make another asset appear in place of the one requested.
- fc15b31: Phase 2 review fixes for `agility-bridge serve`: requests whose target is not a plain path (`GET https://…`) get
  `400`, and pass-through workspaces treat a request as HTTPS only when a trusted proxy says so; a client address out of
  failed attempts no longer triggers Agility validations, new pass-through tokens are checked at most
  `AB_RATE_LIMIT_VALIDATIONS_PER_MINUTE` times per instance (default 30) and concurrent requests share one check; IPv6
  clients are rate-limited per /64; malformed `Host` headers are refused; an admin token file reached through a
  symbolic link into the data directory is refused; the database refuses to leave the server without an active owner
  and to un-revoke anything; only a member can issue device tokens for a grant on their own personal Agility token.

## 0.1.0

### Minor Changes

- 968ee4e: Add the Agility HTTP client: canonical instance URLs, bounded retries for reads, a per-credential limiter and circuit
  breaker, byte-capped responses, precise `AB_AGILITY_*` errors and custom CA bundles on Node (`AB_CA_FILE`).
- e388470: Resolve asset numbers, OID tokens and the names people use (Agility projects, teams, members including `me`, sprints
  including `current`, statuses) inside the workspace, rechecking every row; ambiguous names list candidates instead of
  guessing, and assets outside the workspace answer exactly like missing ones.
- da40f10: Add the discovery tools `whoami`, `list_projects`, `list_asset_types` and `describe_asset_type`, so an agent can learn
  where it is connected and what it can read before it queries anything.
- b2cfa3c: Add `query_assets` and `get_assets`: read any asset type the workspace allows (stories, defects, tasks, tests, epics,
  issues, requests, regression tests, custom fields) with structured filters, bound values, rechecked scope and bound
  paging cursors.
- ec77f7c: Learn each instance's asset model from `meta.v1`: asset types, attribute paths with downcasts and aggregations, number
  prefixes, status lists, field tiers and how each type is kept inside the workspace's Agility projects, cached per
  instance and charged to the call that loads it.
- fdec5c6: Shape every tool result the same way: a summary, notes and data blocks in `table`, `csv` or `json`, Agility text inside
  an unforgeable untrusted-data envelope, rich text converted to plain text, caps with notices, and `structuredContent`
  holding exactly the rows shown.
- 7d9370b: Add `list_teams`, `get_team`, `list_sprints` and `list_members` for planning context: team workflows, members derived
  from assignments, sprints by timing, and members of the workspace's projects without emails unless enabled.
- 966dd17: Compile structured reads into safe `query.v1` queries: validated fields and filters, every value bound through `with`,
  an Agility-project restriction no caller can widen, dead assets excluded, explicit paging with stable sorts, enforced
  limits, a UTC `time_range` model and bound paging cursors.
- 7d8cb78: Serve MCP over stdio: `npx agility-bridge` reads `AB_AGILITY_URL` and `AB_AGILITY_TOKEN` (or a YAML file via
  `AB_CONFIG`) from the client's environment, validates every `AB_` setting at startup, offers the read tools, explains
  how to set itself up when unconfigured, and never accepts secrets as flags.
- cac775e: Add `search_work_items`, `get_work_item` and `list_my_work` for the daily questions: find work by project, team, sprint,
  owner or status; open one item with its description, acceptance criteria, children and links; and see your own work by
  sprint and status.

### Patch Changes

- 2a6958e: Paging cursors bind and re-validate their time window and "now": an edited cursor is refused, and `list_sprints` keeps the first page's "now", so a sprint that starts or ends while you page is neither skipped nor repeated.
- 43ff3f7: Ship LICENSE, NOTICE and a README with the trademark disclaimer in the npm package.
- 783d5ff: Paged lists no longer skip or repeat rows when some rows on a page are hidden because they are outside the workspace: cursors count Agility positions, not shown rows.
- 14c14be: Harden the read path from the Phase 1 review: values of related assets outside the workspace are never returned,
  member usernames follow the email setting, hostile rich text converts in linear time, multi-type pages never skip or
  repeat rows, aggregation values are returned, and YAML references are allowed only in the token.
- 5816321: Ship with verifiable releases: npm trusted publishing with provenance, a CycloneDX SBOM, checksums and a Sigstore
  attestation on every GitHub Release, and an MCP Registry entry (`server.json`).
- 819ec4c: Tool arguments state their defaults in the schema (shown by clients and in the generated tool reference) instead of in
  prose, and bounded lists declare `truncated` in their output schemas.
