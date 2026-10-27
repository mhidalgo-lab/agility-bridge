# agility-bridge

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
