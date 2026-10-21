# agility-bridge

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
