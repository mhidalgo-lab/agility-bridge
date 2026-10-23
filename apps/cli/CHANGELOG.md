# agility-bridge

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
