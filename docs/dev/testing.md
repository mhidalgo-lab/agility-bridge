# Testing

`pnpm test` runs every unit and contract test (Vitest projects per package); `pnpm test:live` runs the read-only live
suite ([verification](verification.md)). Tests never touch a real Agility instance unless they are `*.live.test.ts`.

## The harness (`packages/core/test/harness`)

Tool tests import from `test/harness/index.ts`:

| Piece | What it does |
|---|---|
| `FakeAgility` | An injected `fetch` that answers `query.v1` and `meta.v1` from in-memory rows shaped like the P0-06 captures (flat dotted keys such as `Status.Name`, nested `Owners`). It evaluates `where` and the filter grammar the compiler emits (`=`, `!=`, `<`, `<=`, `>`, `>=`, `~=` over `$v`, `'x'` or `""`, joined by `;` and `|` with parentheses; `ID` is the row's OID), `with` bindings (a scalar with a comma becomes a list, as on Agility: L-162), `sort` (`ID` sorts by the OID number) and `page`. It records every call, and an `override` hook returns statuses or malformed bodies. Anything it does not understand throws `FakeAgilityError`, so a test never passes by matching everything. `filters: 'ignore-filters'` returns every row: the upstream that drops the scope restriction, which tools must survive by rechecking scope (L-064). |
| `poison(n)`, `poisonedRows(type, n)` | Hostile strings, each carrying `CANARY-<n>`: injections, forged envelope markers, HTML with scripts, bidi and zero-width characters, NUL, spreadsheet formulas, 6,000-character values, look-alike tag names (L-122). |
| `foreignScopeRow`, `FORGED_ROWS`, `permissionLimitedRow`, `MALFORMED_BODIES` | Rows from another Agility project, inconsistent or forged identities, attributes hidden by permissions (null), and bodies that are not what the client expects (wrong shape, truncated JSON, empty, an HTML login page). |
| `probeTool(tool, ctx, args)` / `findLeaks(result)` | Calls the tool through a real MCP server and reports every canary outside an untrusted-data envelope, every malformed envelope, and every control or bidi character in the text or `structuredContent`. |
| `measureCost(tool, fake, makeContext, args)` | Counts the Agility requests of one call with a large budget and compares them with the declared `cost` (L-114). Feed it the worst case: a full page on every request, every resolution path. |
| `toolsListContract(tools)` | The serialised `tools/list` (count, bytes, per-tool size and annotations) as a 2025-era client receives it. |
| `propertyParams()` | fast-check parameters with a fixed seed (`20261021`) so CI is deterministic; `AB_TEST_SEED=<n> pnpm test` explores another seed, and a failure prints the seed and path to replay it (L-123). |
| `makeContext(overrides)` | A complete synthetic `ToolContext` (`test/helpers/context.ts`). |

Invisible characters in tests come from `test/helpers/chars.ts` (`String.fromCodePoint`), never `\u` escapes in string
literals, which the formatter turns into raw characters (L-166).

## What every tool adds (P1-07 onwards)

1. Its entry in `CORE_TOOLS` (`packages/core/src/tools/index.ts`) and in the `tools/list` snapshot of
   `test/contract.test.ts`; the count and size budgets (≤ 25 tools, ≤ 40 KB by default) must still hold.
2. A **probe test**: `probeTool` with `poisonedRows` for every output path (list, empty result, error, each composite
   section), expecting no leaks.
3. **Hostile upstream tests**: foreign-scope rows (dropped, `hiddenOutsideScope`), forged ids, permission-limited rows,
   malformed bodies (an `AB_` error, never a crash), empty results (no plausible zeros, L-033).
4. A **worst-case cost test** with `measureCost`.
5. **Negative authorization tests**: on denial, no upstream call (`fake.requests === 0`) and no data.

`test/harness.test.ts` proves the probe works: three deliberately broken tools (raw text, a project name in a plain
note, raw rows in `structuredContent`) must each be caught.

## Server tests (`packages/http-app/test`, Phase 2)

`test/helpers/world.ts` builds a complete server in process: memory storage, a master key, two workspaces (`team-a`,
`team-b`) on one fake Agility instance, personal credentials for two users, device tokens, an audit writer, and a
recorder of every Agility token that reaches the fake. `connect(world, slug, token, era)` returns an SDK client for
either protocol era; `post(...)` sends raw JSON-RPC. Options: `assets`, `filters: 'ignore-filters'` (a hostile upstream),
`admin: true` (the admin API with a test actor chosen by the `x-test-actor` header).

| Suite | Proves |
|---|---|
| `authz.test.ts` (P2-12) | Route × principal × method/tool: no token, malformed, unknown, another workspace's token, unknown workspace, revoked or expired token or grant, disabled workspace, user or instance, revoked or unvalidated credential — each answers the same `401` for `initialize`, `tools/list` and every tool, leaves its audit reason, makes **zero Agility requests** and **zero mutations**. Tools outside the grant are neither listed nor callable. Each scope-strategy class (direct, derived, workspace-bounded, global, denied) through `query_assets`/`get_assets`, with an honest and a hostile upstream; guessed numbers and OIDs of another project are not found and never substituted. Two workspaces and credentials in 24 interleaved calls. |
| `admin.test.ts` (P2-09) | Every admin route unauthenticated (401) and as a member (403/404) with a snapshot proving nothing changed; owner-only actions as an admin; secrets never returned. |
| `app.test.ts`, `rate-limit.test.ts`, `audit.test.ts` | Request hygiene, limits, audit rows. |

Every regression test must fail when its fix is reverted (L-121): check it once by reverting the fix locally.

## Worker tests (`apps/worker/test`, Phase 3)

The Worker is tested **in workerd**, on the bundle CI builds (`wrangler deploy --dry-run`), driven from Node through
Miniflare, with a local D1 that Node opens too (`getD1Database` + `createD1Driver`) to build worlds and inspect
state. Each test gets its own Miniflare and database. The Vitest Workers pool (`@cloudflare/vitest-pool-workers`) is
not used: its 0.23 release needs Vitest 4, the repository is on Vitest 5 with strict peer dependencies; driving the
shipped bundle also tests the bundling itself.

| File | What it proves |
|---|---|
| `worker.test.ts` (P3-01, P3-03, P3-04) | MCP with a device token against the synthetic Agility, the admin API, the uniform `401`, two workspaces under 24 interleaved calls, boot failures (`503`, security headers, no detail), a wrong master key, plan presets and ceilings, rate-limit bindings, no `node:` import in the bundle |
| `authz.test.ts` (P3-06) | The P2-12 denial matrix on workerd: 14 denied principals × `initialize`, `tools/list` and every tool — `401` with one body, **zero Agility requests** (the synthetic Agility counts them), no change to the database, `auth` audit rows with the reason and the `CF-Connecting-IP` address written through `waitUntil`, no `tool_call` row |
| `d1-contract.test.ts` (P3-02) | The whole storage contract on local D1, concurrent first boots, newer-database refusal. Its D1 calls run inside workerd (a small Worker that holds the binding, reached with `dispatchFetch`): Miniflare's Node-side binding proxy sometimes drops its socket mid-response under concurrent calls (`other side closed`) |
| `handler.test.ts`, `plan.test.ts`, `rate-limit.test.ts` | Unit tests of the boot rule (L-179), plan presets and the rate-limit backstop |

Miniflare 5 (pinned by wrangler) takes `convertV4MiniflareOptions({...})`; persist with `resourcePersistencePath`.

## Fixtures

Synthetic Agility responses live in `packages/core/test/fixtures/agility/` (see its README); `meta-snapshot.json` is the
synthetic `meta.v1` of the 33 asset types the tools rely on, served by `new FakeAgility({ meta: snapshot })`. They are written by hand
to the shapes measured in P0-06; nothing is copied from or derived from the third-party tenant (D-01). Sign the
synthetic-fixture checklist in [verification](verification.md) for every new or changed fixture.

## Live suite

`live/*.live.test.ts` run against the read-only tenant through the P0-12 guard: `inventory` (size buckets), and
`client` (the production client and shaper through `guardedFetch`, metadata drift of the committed snapshot
`packages/core/test/fixtures/agility/meta-snapshot.json` on product attributes, paging by `ID` with `limit + 1`). The
same drift check runs weekly against Digital.ai's public example instance (`pnpm metadata:drift`, *Metadata drift*
workflow; no token, public schema only). See [verification](verification.md).
