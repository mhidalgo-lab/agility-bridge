# Testing

`pnpm test` runs every unit and contract test (Vitest projects per package); `pnpm test:live` runs the read-only live
suite ([verification](verification.md)). Tests never touch a real Agility instance unless they are `*.live.test.ts`.

## The harness (`packages/core/test/harness`)

Tool tests import from `test/harness/index.ts`:

| Piece | What it does |
|---|---|
| `FakeAgility` | An injected `fetch` that answers `query.v1` and `meta.v1` from in-memory rows shaped like the P0-06 captures (flat dotted keys such as `Status.Name`, nested `Owners`). It evaluates `where`, `filter` terms `A=$v`, `A!=$v` and `A='x'` joined by `;`, `with` bindings (a scalar with a comma becomes a list, as on Agility: L-162), `sort` (`ID` sorts by the OID number) and `page`. It records every call, and an `override` hook returns statuses or malformed bodies. Anything it does not understand throws `FakeAgilityError`, so a test never passes by matching everything. `filters: 'ignore-filters'` returns every row: the upstream that drops the scope restriction, which tools must survive by rechecking scope (L-064). |
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

## Fixtures

Synthetic Agility responses live in `packages/core/test/fixtures/agility/` (see its README). They are written by hand
to the shapes measured in P0-06; nothing is copied from or derived from the third-party tenant (D-01). Sign the
synthetic-fixture checklist in [verification](verification.md) for every new or changed fixture.

## Live suite

`live/*.live.test.ts` run against the read-only tenant through the P0-12 guard: `inventory` (size buckets), and
`client` (the production client and shaper through `guardedFetch`, metadata drift against the product attributes in
`live/expected-metadata.ts`, paging by `ID` with `limit + 1`). See [verification](verification.md).
