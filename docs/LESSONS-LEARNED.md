# Lessons learned

> Status: **living document** (started 2026-10-16). Add a lesson in the same PR that discovers it (a review finding, a
> live-verification surprise, a flaky test, a client quirk). Never renumber; retire a lesson by marking it
> `Superseded by L-NNN`.

This page collects engineering lessons, known failure modes and platform behaviours that matter for an MCP server with
the architecture of agility-bridge: a runtime-agnostic TypeScript core, local stdio, a self-hosted Node/Docker server,
a Cloudflare Worker, a multi-workspace access model, OAuth 2.1 for hosted clients, and opt-in write tools in front of a
work-management API.

Each lesson is written as a **rule** we adopt from day one, **why** it matters (the failure mode it prevents), and
**where** it is applied (ADR, task or document). Numbers marked *(re-measure)* are starting assumptions: the Phase 0
spikes must confirm them in our own environments before anything depends on them ([RESEARCH.md](RESEARCH.md)).

How to use it:

- Before starting a task, read the lessons of the themes it touches. Every task file lists the lessons it applies under
  **Lessons applied**.
- Reviews cite lesson ids in findings ("violates L-038"), so recurring classes of bugs stay visible.
- A lesson that turns into a hard rule for every change also appears in [AGENTS.md](../AGENTS.md).

## Contents

| Theme | Lessons |
|---|---|
| [A. Planning and process](#a-planning-and-process) | L-001 – L-010, L-158 |
| [B. MCP protocol and SDK](#b-mcp-protocol-and-sdk) | L-011 – L-022 |
| [C. MCP clients](#c-mcp-clients) | L-023 – L-029, L-154 – L-156 |
| [D. Tool design and the output contract](#d-tool-design-and-the-output-contract) | L-030 – L-045, L-150, L-153, L-171 |
| [E. The Agility API client](#e-the-agility-api-client) | L-046 – L-056, L-152, L-160, L-167 |
| [F. Query safety and limits](#f-query-safety-and-limits) | L-057 – L-062, L-168 – L-170, L-172 |
| [G. Access model, tokens and isolation](#g-access-model-tokens-and-isolation) | L-063 – L-070, L-177, L-183, L-239 |
| [H. Storage, migrations and secrets](#h-storage-migrations-and-secrets) | L-071 – L-078, L-161, L-173 |
| [I. HTTP, rate limiting and abuse](#i-http-rate-limiting-and-abuse) | L-079 – L-085, L-151, L-175, L-176, L-187, L-189, L-219 |
| [J. OAuth and identity](#j-oauth-and-identity) | L-086 – L-094, L-164, L-184 – L-186, L-188, L-190 – L-193, L-220 – L-222, L-236, L-242 – L-252 |
| [K. Admin UI](#k-admin-ui) | L-095, L-194 – L-200, L-205 – L-208, L-210 – L-214, L-218, L-223, L-229 – L-232, L-235 |
| [L. Cloudflare Workers](#l-cloudflare-workers) | L-096 – L-101, L-179 – L-182 |
| [M. Node, Docker and self-hosting](#m-node-docker-and-self-hosting) | L-102 – L-104 |
| [N. Write tools and approvals](#n-write-tools-and-approvals) | L-105 – L-112, L-237 |
| [O. Caching, quotas and budgets](#o-caching-quotas-and-budgets) | L-113 – L-116 |
| [P. Observability and logging](#p-observability-and-logging) | L-117 – L-120, L-165, L-238, L-240 |
| [Q. Testing, evals and live verification](#q-testing-evals-and-live-verification) | L-121 – L-126, L-159, L-166, L-174, L-178, L-215 – L-217 |
| [R. CI, release and supply chain](#r-ci-release-and-supply-chain) | L-127 – L-132, L-157 |
| [S. Documentation and configuration](#s-documentation-and-configuration) | L-133 – L-136, L-241 |
| [T. Agility platform behaviours](#t-agility-platform-behaviours) | L-137 – L-149, L-162, L-163 |
| [Top 20](#top-20) | the lessons that save the most time |

---

## A. Planning and process

**L-001 — Measure before you build.**
Run a focused spike for every platform assumption (Agility API behaviour, MCP SDK, OAuth, runtime limits) and record
exact versions, measured numbers, a deployed test, a real-client matrix and an explicit "not verified" list.
*Why:* mocks and documentation pass while the real system differs: multiple isolates behind one URL, client
capability gaps, CPU tolerance, slow optional fields and result shapes only show up live.
*Applied in:* P0-06 – P0-09, P0-13, [ADR-0010](adr/0010-platform-limits-strategy.md).

**L-002 — A spike is done only when it ran in production-like conditions.**
Local matrices catch runtime, schema and protocol issues quickly; only a deployed test catches topology (requests landing
on different isolates), real client flows and latency budgets.
*Applied in:* P0-07, P0-08, P0-09.

**L-003 — Plan live verification from Phase 0, not at the end.**
Get an Agility sandbox, a protected live-test environment and a read-only live suite before the first tool ships.
*Why:* in projects of this shape most late fixes come from the first runs against real data: wrong field names and
types, unexpected relationships, empty or partial data, eventual consistency, unsupported asset kinds.
*Applied in:* P0-12, P1-12, every phase-review task.

**L-004 — End every phase with a review and a live pass, and reserve capacity for follow-ups.**
Follow-ups cluster around concurrency, authorization boundaries, platform behaviour, documentation drift and release
verification. Plan for them instead of treating them as surprises.
*Applied in:* P1-16, P2-17, P3-11, P4-11, P5-10, P6-13, P7-09, P8-12, [ROADMAP](ROADMAP.md).

**L-005 — Fix the tool contract before building many tools.**
Argument names, output shape, errors, paging, partial results and the untrusted-data envelope are decided once, in
writing, before tool number five.
*Why:* tools that evolve independently end up with several time-range shapes, `id`/`asset_id`/`number` variants,
`hasMore` vs cursors and `total` vs `count`, which hurts tool selection, wastes tokens and forces a costly consistency
pass with breaking renames.
*Applied in:* P0-11, [ADR-0015](adr/0015-tool-output-contract.md), [tool conventions](dev/tool-conventions.md).

**L-006 — One task per branch and PR; extra work becomes a new task.**
Refine a later-phase task (scope and acceptance criteria) in a separate commit before starting it.
*Applied in:* [tasks/README.md](tasks/README.md).

**L-007 — Never rewrite a decision; supersede it.**
A change that contradicts an ADR needs a new ADR that supersedes it, so the history of *why* survives.
*Applied in:* [adr/README.md](adr/README.md).

**L-008 — Re-plan after live tests.**
Do not keep the phase order only because it was written first. Record re-plans in the roadmap decision log.
*Applied in:* [ROADMAP](ROADMAP.md).

**L-009 — Settle the expensive-to-retrofit decisions in Phase 0.**
Credential ownership, write policy, storage and encryption, deployment modes, release controls and the tool contract are
cheap to decide early and expensive to change later. Keep open questions, options and a recommendation in a
pending-decisions file for the owner.
*Applied in:* [pending-decisions/phase-0.md](pending-decisions/phase-0.md), P0-14, P0-13.

**L-010 — Every security claim needs evidence.**
Each mitigation in the threat model maps to code, a test and, if anything remains, a named residual risk.
*Why:* security documents drift ahead of the code; claims without tests are discovered as gaps right before launch.
*Applied in:* [THREAT_MODEL.md](THREAT_MODEL.md), P9-01.

**L-158 — Parse hand-written metadata with the real parser from day one.**
Front matter that looks fine to people can be invalid for the parser: 17 task titles such as `Tools: whoami, …` were
unquoted YAML with a second `: `, so a strict parser rejected them and dropped their tasks, turning their dependants'
`depends_on` into "unknown". Validate generated or hand-written metadata in CI as soon as it exists, not when the first
tool needs it.
*Applied in:* P0-05 (`pnpm tasks lint`), [tasks/README.md](tasks/README.md).

## B. MCP protocol and SDK

**L-011 — Serve both protocol eras.**
Support 2025-era clients and the stateless 2026-07-28 protocol (`server/discover`, per-request capabilities in `_meta`,
`Mcp-Method` / `Mcp-Name` headers) on every runtime until client adoption is proven, and test runtime × era.
*Applied in:* [ADR-0005](adr/0005-mcp-sdk-v2-stateless.md), P0-07.

**L-012 — Treat HTTP as stateless.**
No session ids or sticky sessions; build a fresh MCP server per request with only the caller's tools; advertise
`listChanged: false` on HTTP. Clients therefore reconnect to see new or changed tools after an upgrade: say so in every
upgrade note.
*Applied in:* ADR-0005, P2-06, P1-14.

**L-013 — Never keep request data in module state.**
Credentials, grants, scopes and budgets travel in a per-request, immutable `ToolContext`.
*Why:* a known class of MCP-server bug stores the current request's credentials in a module global, so concurrent
callers read each other's keys.
*Applied in:* [AGENTS.md](../AGENTS.md), P1-01, P2-12 (two-tenant concurrency tests).

**L-014 — Reject JSON-RPC batches explicitly.**
Batching was removed from MCP in 2025-06-18, but an SDK's legacy stateless path may still execute every call in a batch.
Refuse batches before they reach the SDK.
*Applied in:* P2-06.

**L-015 — Classify every MCP method, not only `tools/call`.**
`initialize`, `notifications/initialized`, `server/discover`, `ping`, `tools/list`, `prompts/*`, `resources/*`,
`subscriptions/listen` (a long-lived POST some clients open on connect) and `tasks/*` all reach the server. Legacy-era
requests can carry arbitrary `Mcp-Method` headers: classify from the body there.
*Why:* otherwise access logs and audit label valid methods as `other`, and rate limits count listen streams as tool
calls.
*Applied in:* P2-06, P2-08, P8-07.

**L-016 — Advertise only what works on that transport.**
Declare `prompts`, `resources` and extensions (Tasks, Apps) only when handlers exist and only to requests that can use
them; SDK defaults may advertise `listChanged: true` unless set.
*Why:* an extension advertised on a transport that cannot serve it yields `method not found` and silently ignored
parameters.
*Applied in:* P1-01, P8-03, P8-10.

**L-017 — Keep output schemas additive and permissive.**
Input schemas can use the full JSON Schema 2020-12 vocabulary (`oneOf`, `$defs`, `const`). Output schemas must allow
extra properties.
*Why:* a client that validates results against a closed output schema rejects every call as soon as a field is added.
*Applied in:* ADR-0015, [tool conventions](dev/tool-conventions.md).

**L-018 — Always return text and `structuredContent` together** when a tool declares an `outputSchema`; SDK validation
can reject a result without `structuredContent`, and many clients only show the text.
*Applied in:* ADR-0015.

**L-019 — Use protocol errors deliberately.**
Invalid parameters on prompts/resources are JSON-RPC `-32602`; limit, budget, rate, quota and upstream failures on
non-tool methods are `-32603` with a stable application code in `data`; tool failures are results with `isError: true`.
Uncaught exceptions become a bare `-32603`.
*Applied in:* P1-01.

**L-020 — Cache converted tool schemas.**
Building a fresh server per request converts every tool schema each time; with dozens of tools this can dominate CPU on
constrained runtimes. Cache the converted schemas and measure the cost in P0-07 and P3-10.
*Applied in:* P1-01, P3-10.

**L-021 — stdout belongs to the protocol in stdio mode.**
Log to stderr only. Any wrapper or library that prints to stdout corrupts MCP framing.
*Applied in:* AGENTS.md, P1-11.

**L-022 — Budget the `tools/list` payload.**
Every tool adds a description and schemas; a group of write tools with full schemas can add thousands of characters.
Keep a size budget test that includes every optional tool group, not only the default catalogue.
*Applied in:* P1-13, P7-01.

## C. MCP clients

**L-023 — SDK conformance does not prove client compatibility.**
Keep a real-client matrix (transport, header auth, OAuth, elicitation, Apps, Tasks, prompts, resources) with explicit
"unverified" cells, and make real-client checks release gates.
*Applied in:* [client compatibility](reference/client-compatibility.md), [ADR-0016](adr/0016-mcp-client-support.md),
P0-07, P5-06.

**L-024 — Hosted clients have their own rules.**
claude.ai web, Claude mobile and desktop remote connectors need a public HTTPS URL (no localhost or private hosts),
allow about 10 s for discovery, registration and token endpoints (about 30 s for refresh) and use only the first
authorization server listed *(re-verify)*.
*Applied in:* [ADR-0009](adr/0009-authentication.md), P5-02, P5-06.

**L-025 — Not every client can answer an approval prompt.**
Mobile apps and stateless legacy HTTP clients may not support elicitation. Report approval reachability in `whoami` and
in every dry run so users are not surprised by a refused write.
*Applied in:* [ADR-0013](adr/0013-opt-in-writes-human-approval.md), P7-01.

**L-026 — Configure stdio servers through the client, never through flags.**
Environment comes from the client's `env` block (shell exports are not reliable); secrets never go in command-line
flags, which leak through process listings. Use env, files, input prompts or the OS keychain.
*Applied in:* P1-11, P1-14.

**L-027 — Clients cache tool lists.**
After an upgrade, users must reconnect or re-add the server before new parameters or output fields work. Every upgrade
note and the troubleshooting page say so.
*Applied in:* P1-14, P9-05.

**L-028 — Edge bot protection can block MCP clients.**
CDN/WAF browser-integrity checks can reject non-browser clients before they reach the server ("403 from scripts, works
in a browser"). Document the exception needed on custom domains.
*Applied in:* P3-07.

**L-029 — Clients refresh OAuth tokens concurrently.**
Parallel tool calls with an expired access token trigger several refreshes from the same client; strict single-use
rotation then revokes the device. Allow a short, bounded reuse interval.
*Applied in:* ADR-0009, P5-05.

**L-154 — Annotations are hints that most clients ignore.**
Only some clients use `readOnlyHint` (to skip a confirmation); none surveyed changes its UI for `destructiveHint`.
Safety lives in the server: grants, approval and audit.
*Applied in:* ADR-0013, P1-01.

**L-155 — Keep the tool count small.**
Clients cap tools: Cursor at 40, Windsurf/Devin Desktop at 100 across all servers, VS Code at 128 per request. Keep the
default catalogue well under the smallest cap, prefer one generic tool over one tool per asset type, and put optional
tools in groups that workspaces enable explicitly.
*Applied in:* P0-11, P1-13, P6-12.

**L-156 — Plan write approval for clients that cannot elicit.**
Clients that speak only 2025-era revisions over remote HTTP cannot be elicited, because stateless requests carry no
client capabilities; the 2026-07-28 revision elicits through multi round-trip requests instead. In P0-07 (2026-10-20)
Copilot in JetBrains was such a client, while VS Code, Claude Code and Copilot CLI had already moved to 2026-07-28;
which clients are affected changes from release to release. Elicitation alone would lock those clients out of remote
writes: offer an out-of-band approval page (signed-in, bound to the exact change, single-use) as the alternative.
*Applied in:* [ADR-0013](adr/0013-opt-in-writes-human-approval.md), P7-01, P7-02.

## D. Tool design and the output contract

**L-030 — One name per concept, enforced by a lint.**
The same spelling everywhere (`asset`, `asset_type`, `cursor`, `limit`, `time_range`, `<thing>_id`), with a refused
synonyms list (`page_size`, `next_cursor`, `max_results`, `since`, ...). A tool that breaks a rule fails the build.
*Applied in:* [tool conventions](dev/tool-conventions.md), P1-13, P6-12.

**L-031 — Descriptions are prompts.**
Start with the action and what is returned ("List open defects…"), at most about 450 characters, and state scope,
paging, side effects and cost when they matter. Never "This tool…".
*Applied in:* P1-13, P6-10.

**L-032 — One paging contract.**
`nextCursor: string | null` to continue; `truncated: true` only for lists bounded on purpose (never together with
`nextCursor`, never `hasMore`). Cursors are opaque, bound by hash to tool + scope + filters, range-checked on use, and
keep the first call's window.
*Applied in:* tool conventions, P1-05, P1-08.

**L-033 — Never turn missing data into zeros or confident claims.**
Distinguish empty, unavailable, unsupported, capped and failed. Return `partial: true` with `notes[]` naming what is
missing.
*Why:* silent fallbacks and misleading "no data" results are the kind of bug that only shows up against real data:
plausible zeros, stale states, contradictory notes.
*Applied in:* tool conventions, P1-05, P6-07.

**L-034 — Filter before you cap.**
A cap applied before a filter silently drops valid matches.
*Applied in:* P1-04.

**L-035 — Validate at the domain level before calling upstream.**
Check that the asset type supports the operation and that required relationships exist; refuse unsupported asset types
with a clear error instead of returning plausible zeros.
*Applied in:* P1-06, P6-07.

**L-036 — Name resolution must expose ambiguity.**
Exact match first, then candidates with a confidence score; never auto-pick a fuzzy match; verify the resolved object's
scope.
*Applied in:* P1-06.

**L-037 — Composite tools need their own authorization and cost model.**
A report must not call sibling handlers whose tools the caller was not granted: skip that section with a note. Declare
the worst-case cost.
*Applied in:* P6-07, P6-11.

**L-038 — Everything that came from upstream is untrusted.**
Titles, descriptions, acceptance criteria, comments, names, custom fields, error text, candidate lists, notes and
composite sections all go inside the untrusted-data envelope. Probe every output path with poisoned strings.
*Why:* upstream-controlled names easily slip past the envelope through summaries, notes and candidate lists.
*Applied in:* ADR-0015, P1-05, P1-12.

**L-039 — Make the envelope unforgeable.**
Use a random marker per call, neutralise look-alike markers inside the data, and repeat a one-line "data, not
instructions" warning before each block.
*Applied in:* P1-05.

**L-040 — Give agents compact output.**
`minimal_output`, `format` (`table`, `csv`, `json`) and caps (rows, value length, block size, columns) with a notice
that says how to get the rest.
*Applied in:* P1-05.

**L-041 — Neutralise spreadsheet formulas** in CSV output and exports (`=`, `+`, `-`, `@`, tab).
*Applied in:* P1-05, P4-05.

**L-042 — Name every limit by its unit.**
"Budget" must not mean requests in one place and rows in another. Report requested, used and remaining per unit.
*Applied in:* P1-01, tool conventions.

**L-043 — Keep identity on every row.**
Asset number, asset type, OID token, state, project, timestamps and, where safe, a link to the Agility UI.
*Why:* a report without actionable identifiers forces another round trip, or a release to add them later.
*Applied in:* P1-08, P1-09.

**L-044 — Round-trip what you create.**
Read every created or updated asset back through the read tools before declaring a write tool stable.
*Why:* a validator that applies the wrong grammar to provider identifiers silently turns valid values into `null`.
*Applied in:* P7-07.

**L-045 — Deprecate on purpose.**
Keep an old name as an alias marked `Deprecated:` for a defined window, list every deprecated tool argument, output
field and environment variable in one machine-readable registry, and tie removal to a version check.
*Applied in:* P1-11, P9-05.

**L-150 — Instructions, descriptions and defaults must agree.**
Generate default values in descriptions and server instructions from the schema, and test it.
*Why:* server instructions that recommend one page size while the tools default to another produce oversized, slow
answers.
*Applied in:* P1-13.

**L-153 — Register prompts and resources from one manifest.**
One canonical list drives registration, `resources/list` and access checks, and a test reads every listed entry.
*Why:* allowlists duplicated across modules drift, and a mismatched lookup (for example case-insensitive matching against
mixed-case names) makes listed resources unreadable.
*Applied in:* P6-08, P6-09.

**L-171 — Bound every transformation of hostile text.**
A linear-looking HTML-to-text scanner was still quadratic: nested lists repeated their indentation per item and nested
links re-joined the tail at each close, so 16 KB of crafted markup produced 8 MB in 25 s. Cap the input before
converting it, cap depth-dependent output, and keep at most one open span that must be re-read; test with nesting, not
only with length.
*Applied in:* P1-16, `output/text.ts`.

## E. The Agility API client

**L-046 — Classify errors precisely.**
Transport, authentication, authorization, validation, not found, rate limited, timeout, upstream-domain error and
partial result are different things. APIs of this kind can answer HTTP 200 with an error body or with an empty result
for an unknown name; capture real bodies and headers in the spike.
*Applied in:* P0-06, P1-02.

**L-047 — Retry only what is safe to retry.**
Transient 429/502/503/504 and network failures, at most three attempts, full-jitter backoff, honour `Retry-After` (and
refuse when it is too long), and count every attempt against the call budget. Never retry writes, authentication or
validation errors.
*Applied in:* ADR-0010, P1-02.

**L-048 — Stay well under the provider's concurrency.**
Use a per-credential semaphore (start at 5 *(re-measure)*) and measure how the instance throttles (queueing or 429).
*Applied in:* ADR-0010, P0-06.

**L-049 — Cap bytes before parsing.**
Stream-read responses with a byte cap; on constrained runtimes response size dominates CPU.
*Applied in:* P1-02, P3-03.

**L-050 — Ask only for the fields a tool needs.**
Selecting every optional field multiplies latency and adds independent partial failures.
Each tool has explicit field tiers.
*Applied in:* P1-04, P1-08.

**L-051 — Expect read-after-write lag.**
Reads right after a write may show the old state, and list and detail views can disagree for a while. Report the write
result separately from any read-back and add a note; do not poll until consistent.
*Applied in:* P7-01, P7-07.

**L-052 — Normalise heterogeneous representations.**
Validate against real payloads, not one example or the metadata alone: nested objects vs flat attribute paths, arrays of
objects vs parallel arrays, several date formats, nulls, HTML in text fields.
*Applied in:* P0-06, P1-03, P1-05.

**L-053 — Snapshot the upstream schema and detect drift.**
Commit a reviewed metadata snapshot and compare it in CI; keep live contract probes for what metadata cannot show
(permissions, instance configuration, behaviour behind flags).
*Applied in:* P1-03, P1-12.

**L-054 — The instance is first-class configuration.**
Explain the likely cause when a token does not match the instance or the instance URL is wrong, instead of a bare 401
or 404.
*Applied in:* P1-02, [ADR-0014](adr/0014-supported-agility-installations.md).

**L-055 — Credentials never follow redirects, and the upstream URL never comes from a request.**
Pin the instance origin at configuration time.
*Applied in:* P1-02, [THREAT_MODEL](THREAT_MODEL.md).

**L-056 — Reads never create public links.**
Build only validated private links to the instance UI; never select or generate share links as a side effect.
*Applied in:* P8-02.

**L-152 — One identity per tool call.**
Every Agility request of a call uses the same credential, the one the access model resolved. Never mix the caller's
token for reads with a service token for writes.
*Why:* mixed identities make Agility history attribute changes to the wrong member and break the permission model.
*Applied in:* P1-02, P2-04.

**L-160 — Map opaque TLS failures to an actionable error.**
A self-signed, untrusted-root or expired certificate looks different on each runtime: local workerd throws
`internal error; reference = …`, which never mentions TLS, and a deployed Worker gets an ordinary response with
**HTTP 526**. The Agility client treats both, and any connection-level failure, as an `AB_` error that names the likely
causes (certificate not trusted, host unreachable) and, for on-premises instances with a private CA, points to the Node
or Docker deployment. A 526 must never be read as an Agility response.
*Applied in:* [spikes/workers-limits](../spikes/workers-limits/RESULTS.md), P1-02, ADR-0014.

**L-167 — Check hand-written fixtures against a real schema.**
The P0-06 metadata fixture, written by hand from probe shapes, had `Name: "Story"`; in real `meta.v1` JSON an asset
type's name is `Token` and `Name` is a reference object, so a parser built on the fixture failed on the first live run.
The same check found that `ID` relates to the type itself and that `Actual` has no `AssetState`. Synthetic fixtures are
compared with the public example instance (`pnpm metadata:drift`, weekly workflow) and the live suite, on product
attributes only.
*Applied in:* P1-03, [RESEARCH §1.6](RESEARCH.md#16-asset-model).

## F. Query safety and limits

**L-057 — Never build upstream queries from strings.**
Every value the model supplies reaches Agility as a bound parameter (`with` variables in `query.v1`) or a typed field
of a builder; asset types, attribute paths, operators and sort fields are checked against the instance metadata and an
allowlist. There is no "raw where clause" input anywhere.
*Applied in:* [ADR-0012](adr/0012-structured-query-no-raw-passthrough.md), P1-04.

**L-058 — Apply limits to every part of a query.**
Nested selections, sub-queries, filtered aggregations and history (`asof`) all count against depth, page, field and
window limits. Reject what you cannot classify instead of guessing.
*Why:* allow/deny checks that inspect only the top level of a query are bypassed by sub-queries.
*Applied in:* P1-04.

**L-059 — Scope predicates cannot be widened.**
The workspace's Agility-project restriction is added by the server at the top level with AND and cannot be reached by a caller's OR.
Test OR-injection and multi-query bypasses explicitly.
*Applied in:* P1-04, P2-12.

**L-060 — Bound time and history before the request.**
Maximum lookback, maximum `asof` age and maximum history entries are validated up front, and the schema says so.
*Applied in:* P1-04, P6-05.

**L-061 — One time model for the whole server.**
UTC; weeks start on Monday; "last week/month" are rolling 7/30 days while "this/previous week/month" are calendar
periods; a date-only end includes the whole day. Test the boundaries.
*Applied in:* P1-04.

**L-062 — Limits live on the workspace and can only be tightened by a grant.**
Numbers take the minimum, allow lists intersect, deny lists union.
*Applied in:* [ADR-0008](adr/0008-access-model.md), P2-04.

**L-168 — Expand project trees once instead of filtering by ancestors.**
On the read-only tenant (P1-06), `(Scope=$s|Scope.ParentAndUp=$s)` cost about 5 s on `Story` and 1.9 s on `Task`,
against about 0.27 s for a plain `Scope=$list`. The compiler now asks for the allowed projects' `ChildrenMeAndDown`
once (cached for 10 minutes) and filters and rechecks with the expanded list. Measure predicates on the live instance,
not only their correctness.
*Applied in:* P1-06, [ARCHITECTURE §6.3](ARCHITECTURE.md#63-query-compiler-p1-04).

**L-169 — Scope applies to every value, not only to the row.**
The Phase 1 review found that a row inside the workspace could still carry values of related assets outside it
(`Super.Description` of another project's epic, `Owners.Email`), and that filters on such paths were an oracle. Every
relation a caller path follows is checked: denied types are unreachable, members show only their name, a related
project-bound asset counts only when it is in the workspace (values dropped per row, filters guarded in the same entry),
and multi-value relations to project-bound assets are only aggregated.
*Applied in:* P1-16, `query/compiler.ts` `pathGuards`, `identity/scope.ts` `sanitizeRow`.

**L-170 — Merge pages by upstream position.**
Merging several asset types into one page by a local comparator skips or repeats rows whenever the comparator disagrees
with the upstream collation. Take each type's rows in the order the upstream returned them (a k-way merge on the heads)
and count offsets in upstream positions; the comparator then only decides which type comes next.
*Applied in:* P1-16, `tools/work/multi.ts`, P1-17.

**L-172 — A hash without a secret proves nothing; re-validate what a cursor carries.**
Anyone can recompute an unkeyed binding hash, so a cursor's window, offsets and "now" are checked again on every page
against what a fresh call could ask for (`maxTimeRangeDays`, offset range, a "now" no older than a day). The hash still
catches accidental edits and cursors from another request. A list whose filters depend on the time keeps the first
page's "now", or a sprint that ends mid-paging is skipped.
*Applied in:* P1-18, `query/cursor.ts`, `tools/planning/sprints.ts`.

## G. Access model, tokens and isolation

**L-063 — Effective permissions are intersections, resolved once and rechecked.**
Tools = workspace ∩ grant; Agility projects = credential reach ∩ workspace ∩ grant; limits = workspace tightened by grant;
anything missing, disabled, revoked, expired or unvalidated denies. Tools a caller may not use are not listed, and are
refused anyway if called.
*Applied in:* ADR-0008, P2-04.

**L-064 — Recheck results, not only requests.**
Verify the scope of every returned row; drop rows outside the caller's scope and say so (`hiddenOutsideScope`).
*Applied in:* P1-08, P2-12.

**L-065 — Every alternate writer is an authorization boundary.**
The admin API, CLI, configuration import, admin panel and any future path apply the same owner/admin guards.
*Why:* a configuration import that matches credentials by label can make a colleague's personal key a workspace default
even though the admin API forbids exactly that.
*Applied in:* P2-09, P4-09, P8-05.

**L-066 — Device tokens are random, typed, hashed and shown once.**
256-bit random secret, a typed prefix and checksum so secret scanners recognise it (the checksum is not a security
control), SHA-256 at rest, constant-time comparison, a default expiry, per-device revocation.
*Applied in:* P2-05.

**L-067 — Bind each token to one workspace.**
A token for workspace A is rejected at workspace B before anything else is evaluated; OAuth tokens are audience-bound the
same way.
*Applied in:* P2-05, P5-02.

**L-177 — A rule over several rows lives in storage, not in a read-then-write guard.**
The last-owner rule counted active owners and then wrote in a separate step; two owners demoting each other at the same
time left none (P2-17 review M1). Cross-row invariants (last owner, personal credentials, revocation is final) are
storage triggers with the same rule in the memory adapter, so every writer and every interleaving is covered; the
service guard stays for a friendly error.
*Applied in:* P2-17, `packages/storage/src/migrations/0001-init.ts`.

**L-183 — Check that an identifier names something that exists before recording an irreversible fact about it.**
`POST /keys/5/retire` succeeded on a deployment that had never used key version 5 (P3-11 review), and a later boot
with that key failed for good, with no way back through the API. Retirement, revocation and similar one-way markers
accept only identifiers the system has seen (here: a recorded key-check value of an earlier version).
*Applied in:* P3-11, `retireKeyVersion`.

**L-068 — Bound the access cache.**
At most 60 s (default 30 s), keyed by token hash and workspace, cleared on local admin changes; document that other
processes or isolates may honour a revocation only after the TTL.
*Applied in:* P2-06, P3-01.

**L-069 — Prefer bring-your-own-token.**
Per-user tokens keep Agility's own permissions, change attribution and per-user throttling; a shared token widens
visibility and makes every change look like it came from one member.
*Applied in:* ADR-0008, P4-07.

**L-070 — Secrets are never tool arguments.**
Reject secret-like property names (`token`, `password`, `apiKey`, `secret`) in every tool schema; credential
management is never exposed as an MCP tool.
*Applied in:* AGENTS.md, P1-01.

**L-239 — Look again after the write, and tie every answer to what it was about.**
Three races found by the Phase 4 review had one shape: a check passed, something changed, the write went ahead on the old
picture. A device token was issued on a grant that a member pointed at their personal token between the guard's look and the
insert (the switch revokes the tokens it can see, not one that did not exist yet): the guard now looks at the grant again once
the token exists and revokes it on a change. A validation that started before a token replacement finished after it and marked
the new, never-checked token valid: the answer is about the token that was opened, so it is dropped when the sealed token
changed (a storage compare-and-swap would close the last milliseconds, P4-37). And a body cap that reads everything before it
compares lengths is no cap: read at most the cap and cancel (and do not await the cancel of a `clone()`, whose promise waits
for the other branch).
*Applied in:* P4-09.

## H. Storage, migrations and secrets

**L-071 — One schema, one migration history.**
Forward-only, checksummed migrations embedded in the build and run by the same runner on SQLite and D1; no second
migration tool; refuse a database newer than the binary; keep a database fixture per released minor and test upgrades
from each.
*Applied in:* [ADR-0006](adr/0006-storage-sqlite-d1-yaml.md), P2-01, P3-02.

**L-072 — No read-decide-write in application code on D1.**
D1 has no interactive transactions and requests interleave. Use single conditional statements (`ON CONFLICT`, `WHERE`,
`RETURNING`, affected-row counts) or one `batch()`.
*Applied in:* P2-01, P3-02.

**L-073 — One-time state is consumed atomically.**
OAuth codes, setup links, sign-in transactions and approvals are single-use records taken atomically; forms that
reveal secrets are issue-once / claim-once so a reload cannot mint a second token.
*Applied in:* P2-01, P4-04, P5-01, P7-01.

**L-074 — Keep the master key away from the data.**
Never beside the database (a backup would carry both); use a separate secret store, volume, Worker secret or the OS
keychain; test backups, restore and rotation, not just startup.
*Applied in:* [ADR-0007](adr/0007-secrets-envelope-encryption.md), P2-03.

**L-075 — Envelope encryption done properly.**
AES-256-GCM with a fresh 96-bit IV, AAD binding the credential id and key version, HKDF-derived purpose keys, key
check values, resumable compare-and-swap rotation; logs carry only ids and failure classes.
*Applied in:* ADR-0007, P2-03.

**L-076 — Handle files defensively.**
Create with `O_EXCL | O_NOFOLLOW`, mode `0600` files and `0700` directories, operate on the opened handle, refuse
group/world-readable key files.
*Applied in:* P2-02, P2-03.

**L-077 — Diagnostics are read-only.**
`doctor` never migrates or repairs; changes happen only with an explicit `--fix`.
*Applied in:* P8-04.

**L-078 — Migrations between deployments are explicit and one-way.**
Define what moves (instances, credentials, workspaces, grants, tokens, audit) and what does not (sessions, OAuth devices); refuse a
non-empty target.
*Applied in:* P3-09.

**L-161 — Decide on `RETURNING` rows, not driver change counters.**
After a cascading delete, D1 reports the cascaded rows in `meta.changes` while `node:sqlite` reports only the statement's
own rows. Conditional writes (optimistic versions, capped counters, revocations) read their outcome from `RETURNING`,
which both drivers return identically.
*Applied in:* [spikes/workers-limits](../spikes/workers-limits/RESULTS.md), ADR-0006, P2-01.

**L-173 — `node:sqlite` binds JavaScript numbers as `REAL`.**
An atomic counter written as `CAST(CAST(value AS INTEGER) + ? AS TEXT)` stored `'3.0'` on `node:sqlite` (P2-01): the
bound `1` arrived as a float. Cast bound numbers that take part in SQL arithmetic (`CAST(? AS INTEGER)`), and let the
contract suite compare stored values exactly so the next driver difference shows up too.
*Applied in:* P2-01, `packages/storage/src/sql/storage.ts`, [storage](dev/storage.md).

## I. HTTP, rate limiting and abuse

**L-079 — Separate abuse controls per surface.**
Per-IP requests, authentication failures (charged only on failure, so a valid token is never locked out), sign-in
transactions, token issuance, client registration, MCP calls and writes each get their own limit.
*Applied in:* P2-07, P5-09.

**L-080 — Decide fail-open vs fail-closed for each control, and test it.**
Authorization always fails closed; cost quotas may fail open with a warning; write limits fail closed.
*Applied in:* ADR-0010, P2-07, P7-03.

**L-081 — Per-process limits are not deployment-wide.**
Isolates and replicas each keep their own counters. Use a shared limiter where it matters (writes, sign-in, client
registration).
*Applied in:* P3-04, P7-03.

**L-082 — Defend local servers against DNS rebinding.**
Bind loopback by default, require a token even on localhost, allowlist `Host` and `Origin`, refuse `Origin: null`.
*Applied in:* P2-06.

**L-083 — Derive security headers from the public URL.**
Behind a TLS-terminating proxy the server sees plain HTTP; HSTS and friends follow the configured public URL and apply
to error and boot-failure responses too.
*Applied in:* P2-06, P3-01.

**L-084 — Bound everything at the edge.**
Declared and streamed body size, header timeouts and a request deadline that covers the completion of streamed
responses, not just the headers.
*Applied in:* P2-06.

**L-085 — One-time secrets never travel in URLs.**
Query strings leak into logs, history and `Referer`; put setup codes in the URL fragment or a POST body.
*Applied in:* P4-01.

**L-151 — Health endpoints reveal nothing.**
Liveness and version only; no dependency details, configuration or stack traces on unauthenticated routes.
*Applied in:* P2-06, P3-01.

**L-175 — The request URL is the client's choice: never derive transport security from it.**
Node's HTTP server accepts absolute-form targets (`POST https://host/path HTTP/1.1`) on a plain socket, and
`@hono/node-server` builds the request URL from them, so `new URL(c.req.url).protocol === 'https:'` was true over clear
text (P2-17 review F1). Decide "HTTPS" from the socket or from a trusted proxy's `X-Forwarded-Proto` only, and refuse
request targets that are not origin-form (`/path`) before routing.
*Applied in:* P2-14, P2-17, `apps/cli/src/serve.ts` (`originFormOnly`).

**L-176 — An authentication step that costs upstream calls needs its own budget, checked before it runs.**
Validating a pass-through token costs Agility requests; checking the failure limit only after validating let an
exhausted address keep spending the instance's quota (P2-17 review F2). Check exhausted failure budgets first, cap
validations per instance, share one validation between concurrent requests with the same token, and count IPv6 clients
by their /64 so address rotation does not reset the limits.
*Applied in:* P2-14, P2-17, `packages/http-app/src/app.ts`, `rate-limit.ts`.

**L-187 — An unauthenticated route that writes or calls out needs its own budget.**
Every `GET /auth/login/:provider` stores a transaction row and may fetch discovery from the IdP; the only bound was the
general per-IP limit, so one address could keep thousands of rows alive (relic-bridge Phase 4 review L4). Give the
sign-in routes their own per-address rule (`AB_RATE_LIMIT_SIGN_IN`, default 60 per 5 minutes, IPv6 by /64), checked
before any storage write or provider call, and expire the abandoned rows.
*Applied in:* P4-01.

**L-189 — A cookie named twice is no cookie.**
A sibling subdomain or a script can add a second cookie of the same name (cookie tossing). A reader that takes the first
value lets the attacker choose which one counts, so a header that names the cookie more than once is treated as having
none (relic-bridge Phase 4 review Q9). Do it for the sign-in binding cookie and for the session cookie.
*Applied in:* P4-01, P4-02.

**L-219 — A framework exception thrown by a validator is not an internal error.**
A POST with `Content-Type: application/json` and an empty body passed the admin API's own JSON gate (an empty body is
allowed for actions that take none), reached Hono's validator, which throws `HTTPException(400)`, and the app's
`onError` answered `500 internal error` and logged `unhandled error`. Found by the first browser-harness call that sent
`{}`-less JSON. `onError` now maps a 400 `HTTPException` to the `bad_request` envelope; a test sends empty JSON to three
routes.
*Applied in:* P4-08.

## J. OAuth and identity

**L-086 — OAuth state lives in shared storage.**
Clients, grants, codes and refresh families go through the storage abstraction with TTLs, never process or isolate
memory.
*Why:* state held in isolate memory is present for one request and missing for the next when that request lands on
another isolate.
*Applied in:* ADR-0009, P5-01.

**L-087 — One protected resource per workspace.**
RFC 9728 metadata per MCP URL and RFC 8707 audience binding: a token for one workspace fails at another and a refresh
cannot retarget it. Test cross-workspace rejection.
*Applied in:* P5-02.

**L-088 — Client metadata fetching is an SSRF surface.**
CIMD documents are fetched over HTTPS only, without redirects, with size and time limits, and with private, loopback,
link-local and metadata ranges blocked at connect time (pre-resolution checks leave a DNS-rebinding gap). If a runtime
cannot do that, disable CIMD there and use DCR.
*Applied in:* ADR-0009, P5-03.

**L-089 — Dynamic registration is a compatibility path.**
Cap registrations per IP and per deployment, expire unused clients, allow restricting redirect hosts, and plan to turn
DCR off once CIMD works for the target clients.
*Applied in:* P5-03, P5-09.

**L-090 — Never revoke or replace a device on a GET an attacker can trigger.**
With remembered consent, a top-level navigation could otherwise disconnect a live app without a click. Replace a device
only after a successful code exchange, and audit it.
*Applied in:* P5-04.

**L-091 — Validate redirect targets after parsing.**
Dot-segment tricks such as `/.//evil.example/x` become external URLs after normalisation; check the parsed result and
re-check when emitting the redirect.
*Applied in:* P4-01, P5-04.

**L-092 — One identity per user.**
`(idp, subject)` is the identity; a verified email binds only an unbound user; no silent cross-provider linking; deny by
default; the first owner is bootstrapped with a single-use link.
*Applied in:* P4-01.

**L-093 — Re-authenticate before high-impact actions.**
Key rotation, owner/admin changes, imports and credential replacement require a recent sign-in; users can list and end
their sessions.
*Why:* otherwise a stolen admin cookie is enough to rotate keys and create owners.
*Applied in:* P4-02.

**L-094 — Follow the OAuth details clients rely on.**
Token endpoints accept `application/x-www-form-urlencoded`; PKCE S256 for every client; `resource` on authorization,
token and refresh requests.
*Applied in:* P5-01, P5-05.

**L-164 — The OAuth provider keeps one refresh token per grant.**
With `workers-oauth-provider` 1.2.3, five parallel refreshes with one refresh token all succeed, but afterwards only
the last new refresh token works; a client that kept another one must sign in again. The library offers no reuse
interval, so the one ADR-0009 promises is ours to build (a per-grant refresh family in storage) and to test with
parallel refreshes.
*Applied in:* [spikes/oauth](../spikes/oauth/RESULTS.md), ADR-0009, P5-05.

**L-184 — Compare identities as printable ASCII, never as case-folded Unicode.**
Lowercasing maps some characters onto ASCII letters (the Kelvin sign `\u212A` becomes `k`), so a verified address at an
IdP that treats `\u212A` and `k` as different accounts could claim another user's row, because a verified email binds
an unbound user. Accept only printable ASCII addresses from an IdP, lowercase them, and refuse the rest (relic-bridge
Phase 4 review L2). Test with code points: a formatter turns an escape back into the raw character (L-166).
*Applied in:* P4-01 (`canonicalEmail`).

**L-185 — Bind an identity with one compare-and-set, not read-then-write.**
Reading the user by email and then updating `(idp, idp_subject)` by id lets two concurrent first sign-ins at two
providers both succeed, each with a session, and the last writer keeps the binding (relic-bridge Phase 4 review M1).
`users.bind` is one conditional statement (`WHERE id = ? AND idp IS NULL AND idp_subject IS NULL AND disabled_at IS
NULL`) whose outcome is read from its `RETURNING` row (L-072); no row means `identity_conflict`. Race it on every
adapter (memory, SQLite with two connections, D1).
*Applied in:* P4-01.

**L-186 — Every answer from an identity provider goes through one size cap, the key set included.**
A library that fetches the JWKS for you reads it whole. A hostile or broken `jwks_uri` taken from discovery could stream
megabytes into an isolate on an unauthenticated route (relic-bridge Phase 4 review L1). Wrap the library's fetch so the
key set passes the same timeout, no-redirect and byte cap as discovery, token and userinfo answers, and fail those with
`idp_unavailable` and no body.
*Applied in:* P4-01 (`remoteKeySource`, `idpJson`).

**L-188 — Revoke a third-party token you needed for one lookup.**
GitHub sign-in exchanges the code for a user token only to read the id, the primary email and the organizations. GitHub
keeps such tokens valid until revoked, so call `DELETE /applications/{client_id}/token` as soon as the lookup is over, on
success and on refusals, in the background where the platform has one (`waitUntil`), and log only a status class when it
fails (relic-bridge Phase 4 task P4-13). A failed revocation never fails the sign-in.
*Applied in:* P4-01.

**L-190 — `Clear-Site-Data: "cookies"` clears the whole registrable domain; keep it switchable.**
Logout sends `Clear-Site-Data: "cookies"` (the value is a quoted string; an unquoted one is invalid), as the task asks, but
per MDN it removes the cookies of the registered domain *and its subdomains*, so `mcp.example.com` signing out also
signs the user out of `wiki.example.com`. The session cookie is also cleared with its own `Set-Cookie`, so the header is
belt and braces: `AB_LOGOUT_CLEAR_SITE_DATA=off` drops it for deployments that share a domain. Send it on a 200 page, not a
redirect (redirect handling is not documented). Browsers ignore it outside secure contexts.
*Applied in:* P4-02.

**L-191 — Forms need `Referrer-Policy: same-origin` when the CSRF check reads `Origin`.**
Under the app-wide `no-referrer`, browsers post a same-origin form with `Origin: null`, which the Origin check must refuse.
The pages that carry forms (the account page, later the panel) send `same-origin`, and the edge keeps that one value
and no other (found in relic-bridge's `security.ts`).
*Applied in:* P4-02.

**L-192 — A link from elsewhere is a cross-site navigation, and so is the page after the IdP redirect.**
`Sec-Fetch-Site` stays `cross-site` for the last request of a redirect chain that started on another site, so refusing every
cross-site read would break the first page after sign-in and every link from chat. The read check allows exactly
`GET` + `Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document` (its answer cannot be read by the other site) and refuses
other cross-site and same-site reads; changes need `same-origin` (or an `Origin` equal to the public origin) and the CSRF
token, whatever the cookie says (`SameSite=Lax` is not the defence).
*Applied in:* P4-02.

**L-193 — Re-authentication proves the same person again; it never resolves, creates or binds a user.**
Re-running the login through `resolveLoginUser` would let a stranger the allowlist admits be provisioned, or an unbound
user be bound, from inside someone else's session. The re-authentication transaction carries the user id; the callback
only compares the verified `(idp, subject)` with that user's bound identity, checks recency (OIDC `prompt=login&max_age=0`
and `auth_time` when reported, the Cloudflare Access assertion's `iat`), and rotates the session. Google and GitHub report no
`auth_time`: for them the IdP's own prompt is the only evidence (decision D-34).
*Applied in:* P4-02.

**L-220 — Clear an identity against the binding the owner saw, in one statement.**
An unbind that updates by user id alone can undo a newer binding: owner A reads Ann bound at Google, owner B unbinds her and
she signs in at GitHub, then A's confirmation clears the GitHub binding too. `users.unbind(id, expected)` is one conditional
statement (`WHERE id = ? AND idp = ? AND idp_subject = ?` with `RETURNING`, L-072) and no row means `409`; a null expectation
never matches an unbound row. relic-bridge's version read the user and then updated it (Phase 4 review). Race it on memory,
SQLite with two connections and D1, including an unbind against a first sign-in.
*Applied in:* P4-12.

**L-221 — End sessions after the write that changes who may sign in, never only before it.**
Ending a user's sessions first and then clearing the binding leaves a window: the person signs in again with the old identity
between the two and keeps a fresh session. Ending them after the compare-and-set closes it (anything open at that moment, and
anything created since, is deleted) at the cost of one failure mode: if the revocation fails after the clear, the request is an
error and the owner ends the sessions with `user end-sessions`. The audit row of the change carries the previous provider only.
*Applied in:* P4-12.

**L-222 — An account-takeover primitive refuses the easy self-inflicted cases with one plain rule.**
"Never your own account through a session" is simpler and safer than counting owners: it keeps the only owner from locking
themselves out, stops a stolen session from detaching the account it holds, and needs no extra branch for the last owner. The
break-glass token has no account and may move anyone; another owner may move an owner. Say so in the refusal ("ask another
owner, or use the admin token") and in the docs, and hide the control in the panel for the same cases.
*Applied in:* P4-12.

**L-236 — A standing credential needs a fresh sign-in, whoever asks for it.**
A session older than ten minutes was enough to mint a device token that never expires: stolen cookies could turn into access
that survives the session, the sign-out and the user's next password change. Anything that creates a credential outliving the
session (a token past the default 90 days, a setup link, a pass-through workspace) asks for the sign-in of the last ten
minutes, as GitHub's "sudo mode" does for access tokens; the ordinary, short-lived action stays frictionless. Decide the rule
by what survives, not by who is asking, and put it in the guard, so the panel, the API and the command line share it.
*Applied in:* P4-09.

**L-247 — A library's "helpful" default that revokes on issue turns a navigation into a disconnect.**
`workers-oauth-provider`'s `completeAuthorization` revokes the user's other grants of the same client when a code is
*issued*. That is harmless when issuing needs a click, and a zero-click denial of service the day a request can issue a
code without one (a remembered approval, a silent `prompt`, a replayed form): any page could navigate a victim's browser
to the authorize URL and end their live app. Read what each helper does besides what you call it for: approval passes
`revokeExistingGrants: false`, and a device is replaced only after a successful code exchange, by the holder of the code and
its PKCE verifier, audited as `oauth.device.replaced`. Test it as an attacker would (authorize twice, redeem neither, the
first token must still work).
*Applied in:* P5-04 (relic-bridge Phase 5 review H1).

**L-248 — A CSRF token says who posted; a handle bound to the request says what they approved.**
A consent form is valid for a signed-in person, so session, `Origin` and CSRF all pass for a form carried to another
authorization request (swapped client, redirect URI, challenge, resource or state) or posted twice. The page therefore stores
`oauth-consent:<user>:<handle>` = a hash of the canonical request it showed, and the post takes it atomically and compares
it with the request it re-validated from its own URL: replayed, swapped, cross-user and expired forms find nothing or a
different hash and approve nothing. Handles are bounded per person by dropping the oldest (an attacker who can flood them
can only make a stale tab ask again), never written for HEAD, and spent whatever the outcome.
*Applied in:* P5-04.

**L-249 — `form-action` governs the redirect that answers a form post, so the consent page must name the client's origin.**
Chromium applies `form-action` to the redirects after a post: with `'self'` only, "Allow" is blocked at the redirect to the
client's callback. Widening to the redirect URI's origin (only an http(s) host source, validated) fixes it; widening to
`http:` for an IPv6 loopback redirect, which CSP cannot spell, would let any injected form post to any plain-http site, so
that one target is answered by a same-origin page that navigates (`Refresh` and a link are not governed by `form-action`).
The edge keeps a panel CSP only when it is the panel policy plus exactly one such source. A browser test catches this; a unit
test of the header does not.
*Applied in:* P5-04 (relic-bridge P5-12/L8).

## K. Admin UI

**L-095 — Server-rendered, script-light, and calling its own API.**
Auto-escaped server rendering only, no inline scripts or styles, a strict CSP with hashed assets,
`frame-ancestors 'none'`, CSRF synchronizer tokens plus Origin/Fetch-Metadata checks, mutations only through POST. The
panel calls the admin API in-process so validation, authorization and audit are identical.
*Applied in:* [ADR-0004](adr/0004-typescript-runtime-agnostic-core.md), P4-03 ([admin panel guide](dev/admin-ui.md)).

**L-194 — Assert a security header against a literal, and keep a page's own policy only on an exact match.**
A test that compares the CSP header to the constant the page was built from can never fail (relic-bridge's Phase 4 review,
Q1). The panel's tests spell the policy out once, as a string, and check its directives; the edge keeps a response's own CSP
only when it equals one of the panel's two policies as a whole (`isUiCsp`) and replaces every other, so a page that sets a
looser policy by mistake is still served with the JSON-only default. A header an HTML page passes replaces the default
instead of being appended (two CSP headers are two policies, and the stricter wins silently).
*Applied in:* P4-03, `packages/admin-ui/test/headers.test.tsx`, `packages/http-app/test/admin-panel.test.ts`.

**L-195 — A strict `form-action` breaks a form that is answered with a redirect to another origin.**
Chromium applies `form-action` to the redirects that follow a form post, so the owner setup form (posted here, answered
with a 303 to the identity provider) cannot live under the panel's `form-action 'self'`. The setup page alone drops that
one directive and keeps the rest (`UI_CSP_SETUP`, tested as the panel policy minus `form-action`); every other form posts to
and is answered by this origin. P4-01 found it with its own inline policy; moving the sign-in pages onto the panel layout
had to keep it.
*Applied in:* P4-03.

**L-196 — Load the panel lazily and keep it out of script and MCP paths, and share the app the API route uses.**
`http-app` imports the `.tsx` panel with `import()` on the first panel or sign-in page: MCP requests never evaluate it on
Workers (the bundle wraps it in a lazy initialiser), and scripts that run `http-app` from source under plain Node never need
a JSX transform. Cache the loaded module (a completed value), never the promise (L-096), and let a failed import be retried.
The panel's in-process calls enter the admin API through the same lazily built app as the HTTP route, with the request id in
an internal header the caller sets, so a panel change and an API call produce the same audit row.
*Applied in:* P4-03, `packages/http-app/test/admin-panel-lazy.test.ts`.

**L-197 — A button the API would refuse is a bug: show a control only when the API allows it, and test the page against the API.**
The panel mirrors the guards (owners manage everyone, admins members, personal credentials belong to their person, a grant on
someone else's personal token takes no device token) in small functions (`canManage`, `canIssueOn`, `canReplace`), and the
role matrix test drives the page and the API for every viewer and target role and requires "offered" to equal "allowed". The
API stays the authority: forged requests are refused there with no effect, which is tested separately. A mismatch is a
broken button or a hidden feature, and neither shows in a render test.
*Applied in:* P4-04, relic-bridge review L9.

**L-198 — Send only what changed to a guard that keys on the field being present.**
The workspace, grant and user guards ask for an owner and a recent sign-in whenever a patch *contains* a write tool, a write
policy, a pass-through source or an owner/admin target, even when the value is unchanged. A form that always sends every
field would ask for re-authentication on every save, and an admin saving a name would overwrite an owner's write-tool list.
The forms compare with the stored row, send only changed fields, and leave a field they may not edit out entirely.
*Applied in:* P4-04.

**L-199 — A one-time page needs a single-use handle, taken before the side effect and written only for the page that shows the form.**
Issuing a device token from the answer to a POST makes a reload or the back button re-send the form. The form carries a
random handle stored in `kv` for its user; the POST takes it atomically (L-073) before calling the API, so a re-sent,
forged, foreign or concurrent form issues nothing. Handles are written only by the GET that renders the form (never HEAD,
lists or refused views), at most ten stay open per user (further pages reuse one), and they expire. A validation re-render
gets a fresh handle and does not spend the old one.
*Applied in:* P4-04, `packages/http-app/test/admin-screens.test.ts`, relic-bridge review L6.

**L-200 — A list of server records needs a keyset cursor, a bounded scan and a role scope the API owns.**
Page with `ts, id` (newest first) and fetch page size + 1 rows instead of counting or using OFFSET, so rows arriving
between pages neither repeat nor skip. Aggregates read at most N newest rows and report `truncated` rather than a
plausible total; an export is one call with the API's ceiling, not a loop of pages (each in-process call costs queries
against a small subrequest budget). "Members see only their own rows" is decided in the admin API from the session, never
by the panel, and a request for someone else's rows is a 403 that reads nothing. Do not add an index to an append-heavy
table for a rare view: on D1 it costs a written row per append.
*Applied in:* P4-05, `packages/http-app/test/admin-audit.test.ts`, relic-bridge P4-05.

**L-205 — A "mine only" page is mine only for every role, not just the lowest.**
The admin API is role-aware: an owner may read any credential or grant, a member only their own. A self-service page that
simply loads `GET /credentials/{id}` therefore shows an owner another person's personal credential under "My access", and an
owner's forged `POST` on someone else's grant or token goes through, because the API allows it for that role. The member area
re-checks ownership itself (the row's `ownerUserId` or `userId` must be the signed-in person, anything else is the 404 page) and
the tests post the same forged ids as an owner and an admin, not only as a member.
*Applied in:* P4-07, `packages/http-app/test/member-self-service.test.ts`.

**L-206 — A cap checked before an insert is not a cap: count again after it and take the row back.**
"Fewer than ten, then create" lets parallel requests all pass the check. The services count after the insert and, when over,
remove the new row and refuse; the racers all retreat, so the limit holds and the person simply retries. Applied to personal
credentials per person and live device tokens per grant, tested with parallel requests (relic-bridge P4-19).
*Applied in:* P4-07, `packages/auth/src/access/services.ts`.

**L-207 — A stored token that Agility refused is inert: nothing may be switched to it until it is valid.**
Storing a token and validating it are two steps, and a member can type a wrong one. The resolver already denies an
unvalidated credential; the self-service switch refuses it as well (it asks for `valid`), and the page says what is wrong
and offers to replace it, instead of letting a grant point at something that can only deny.
*Applied in:* P4-07.

**L-208 — Moving a grant back to the default is an escalation of someone else's choice unless the grant used the member's own token.**
An administrator may pin a member's grant to a narrow shared credential. If a member could send `credentialId: null`, they
would undo that pin and fall back to whatever the workspace default reaches. Going back is allowed only while the grant
currently uses a credential of the member's own (relic-bridge P4-18); switching to one of their own valid tokens never widens
anything the workspace and grant limit.
*Applied in:* P4-07, relic-bridge P4-18.

**L-210 — A generated snippet is text that someone pastes into a shell or a config file: quote per format and test with the real interpreter.**
The same workspace name or token is a JSON string in one snippet, a POSIX word in the next and a PowerShell string in a third;
HTML escaping protects the page, not the shell. Each format has one quoting function, and the test runs hostile strings
(quotes, `$(…)`, backticks, newlines, `${…}`) through a real `bash` with stub commands and asserts each value arrives as exactly
one argument; JSON snippets are parsed back and compared (relic-bridge P4-06).
*Applied in:* P4-06, `packages/admin-ui/test/snippets.test.ts`.

**L-211 — A secret goes into a snippet only where the client has no prompt or variable, and the type says so.**
Shell history and committed project files are the leaks. Snippets read the token from a prompt (VS Code) or an environment
variable and keep the literal value out; the one client with neither (JetBrains) gets it, and only on the one-time render.
`Snippet.literalToken` records whether a body holds the real token, and the tests check it against the text for every client
with and without a token, so a new builder cannot add a second holder unnoticed.
*Applied in:* P4-06.

**L-212 — Clients expand `${…}` inside URLs: a name that reaches a config file must match the storage rule first.**
VS Code, Claude Code, Cursor and Devin Desktop expand variables in `url` and `headers`. A slug containing `${input:x}` would be
expanded by the client even though JSON quoting is correct. The snippet generator throws for a slug that does not match the
storage rule (`[a-z0-9-]`), and the page shows an error instead of snippets.
*Applied in:* P4-06.

**L-213 — The guide's snippets are generated text: keep one source and test the copy (L-133 applied to configuration).**
`docs/guide/clients.md` carries `<!-- snippet: id -->` blocks; a test compares each with the generator's output for placeholder
values, so a changed format fails CI until the guide is regenerated, instead of drifting until a user pastes a stale form.
*Applied in:* P4-06.

**L-214 — A client's configuration format moves and its vendor page may be silent: record date, source and what was not seen.**
Windsurf became Devin Desktop (new path, `serverUrl`), VS Code moved its reference page, and the Copilot CLI page does not say
whether headers substitute variables. Snippets use the documented command or key, `docs/RESEARCH.md` records the page and the
date, and anything the page did not show is marked *unverified* instead of being copied from memory.
*Applied in:* P4-06.

**L-223 — A setup script validates with the server's parser, and a secret has one destination.**
`cf:setup --sign-in` builds the environment the Worker will boot with and runs `identitySettingsFromEnv` on it before it
creates or deploys anything, so a bad issuer fails at setup, not at the first request, and the server's warnings appear
once, in one place. Client secrets are held in memory, sent on stdin and checked absent from arguments, logs, the local
config and the secrets file by a test that looks at all four.
*Applied in:* P4-13.

**L-229 — The inverse of a guarded action gets the same guard, and authorization comes before the state check.**
Enabling a disabled user restores everything they still hold (grants, device tokens), so it is as sensitive as disabling:
an owner for owners and admins with a recent sign-in, an admin for members. The "is it disabled" check (409) comes after the
role check, so a caller who may not enable never learns whether someone is disabled (the same 403 for both). Write the role
matrix once for the pair and run it against the panel's button too (L-197).
*Applied in:* P4-15.

**L-230 — A list across owners is a function of the actor, and keyset paging is tested with writes between the pages.**
`GET /tokens` is not "all tokens with an optional filter": the set the caller may see is computed from the actor first (everything
for owners and admins, the tokens of one's own grants for anyone else, a foreign grant is "not found", a foreign user matches
nothing), and the filters only narrow it. The page key is `(createdAt, id)` newest first with the id breaking ties; the test
adds a newer token and revokes an older one between two pages and demands that every token that existed throughout appears
exactly once. A malformed cursor is a 422, and the panel forwards only a cursor of the API's shape.
*Applied in:* P4-15.

**L-231 — Check that something reads a setting before building the control for it, and validate it where every writer passes.**
`instances.numberPrefixes` had been accepted by the API since Phase 2 with no validation, and no host passed it to the metadata
service: a form would have edited a value nothing used. The validator went into the services (so the API, the CLI and the panel
share it and the metadata layer's own patterns are the same constants), the missing consumer became task P4-30, and the form says
so in words instead of promising an effect.
*Applied in:* P4-15.

**L-232 — A role matrix in the docs is a test, not prose; and a CI-measured figure beats a local one.**
The admin guide's "who can do what" table is parsed by `scripts/test/role-matrix.test.ts`, which runs every row as each role
against the real guards (denied, allowed, or allowed only with a sign-in from the last 10 minutes) and fails when a row has no
probe, so neither a guard nor a sentence can change alone. In the same task the panel's local CPU figures (taken on a loaded
machine) overstated the warm pages about threefold against the benchmark's ratios on CI: published numbers come from the run
that is repeatable, stated with its date and its calibration, not from a developer's machine.
*Applied in:* P4-10.

**L-218 — A table that scrolls sideways must be reachable by keyboard, and only a real layout shows it.**
`.table-wrap { overflow-x: auto }` kept the 320 px page from overflowing, but a keyboard user could not scroll it (WCAG
2.1.1): axe-core's `scrollable-region-focusable` found it on the first audit-log run in Chromium, light and dark. A
scrollable container is a focusable, named region (`tabindex="0"`, `role="region"`, `aria-label`). jsdom has no layout, so
the contrast and scroll rules need a browser; `visit()` in the E2E harness runs axe on every page it opens. The same goes
for a long path or address with no break opportunity: it overflowed only with CI's fonts, as text (not an element), so the
overflow check names overflowing text nodes too and `main` has `overflow-wrap: break-word`.
*Applied in:* P4-08.

**L-235 — If the panel says "owner only", the guard says it too.**
The instance form refused a CA file for anyone but an owner ("Only an owner can set this"), while `POST /instances` accepted
`tls: { caFile }` from an administrator: the rule lived in the form, and the API is the boundary (L-065). A CA file is read
from the server's disk and decides whom stored member tokens are sent to (A14). Every restriction a screen shows is found by
grepping the screens for owner-only conditions and checking that a guard says the same; a role-matrix row and a test through
the API are the evidence.
*Applied in:* P4-09.

## L. Cloudflare Workers

**L-096 — Never share in-flight I/O between requests on Workers.**
I/O started by one request may hang or fail when awaited by another. Cache completed values only; make boot
single-flight per request.
*Applied in:* P3-01.

**L-179 — Local workerd does not catch shared in-flight work: test the rule where it is made.**
A boot promise shared by concurrent requests passed every Miniflare test (P3-01): local workerd neither hangs nor warns
when one request awaits a promise another request created, while production may cancel that work with the first
request. Keep the rule in code the tests can drive (the handler takes its boot function; the app's isolation mode) and
assert it there, with a mutation check. Also: Miniflare 5 (pinned by wrangler 4.149) takes a new options shape;
`convertV4MiniflareOptions` and `resourcePersistencePath` (not `d1Persist`) work.
*Applied in:* P3-01, `apps/worker/test/handler.test.ts`, `packages/http-app/test/isolation.test.ts`.

**L-180 — A Host allowlist needs the public address on every platform.**
The first staging deploy answered `403` on `workers.dev` (P3-05): the edge accepts only loopback names and the public
URL's host, and the Worker had no `AB_PUBLIC_URL`. The control worked; the setup did not configure it. A deployment
tool sets the public URL from the address it deployed to, and checks `/health` through that address.
*Applied in:* P3-05, `scripts/cf-setup.ts`.

**L-181 — An internet-facing deployment is never empty.**
The first real migration into staging was refused as "not empty" (P3-09): two audit rows of refused requests from a
smoke check. Any public Worker records refused probes within minutes of its deploy. Define "empty" on configuration
and identity tables, and keep the target's audit rows next to the imported ones.
*Applied in:* P3-09, `scripts/cf-migrate.ts`.

**L-182 — Measure a Worker's cold start on Cloudflare, then move what needs no environment to module scope.**
Node is a poor proxy for a cold isolate (its crypto and loader dominate), and inside a Worker the CPU cannot be timed
(the clock does not advance during computation). `wrangler tail` reports `cpuTime` per request: a redeploy starts new
isolates, so the requests after it are cold samples (wrangler's own request to `/` is one too). Module scope runs at
startup under its own limit, so registries, converted schemas and route tables belong there; whatever a library builds
lazily on its first request (the MCP SDK's protocol schemas) stays in that request unless the library offers a hook.
*Applied in:* P3-10, P3-14.

**L-097 — Design for the Free plan's limits, not its tolerance.**
About 10 ms CPU per request, 50 external subrequests and 6 simultaneous outbound connections on the Free plan *(re-verify)*.
Small responses fit, and short CPU overruns may be tolerated, but never rely on that: enforce response caps (start with
512 KiB on Free and 8 MiB on Paid *(re-measure)*) and per-call budgets. The one exception is the first request of a
new isolate, which a library's lazy setup keeps over budget: cut what you control, measure it, and record the rest as
an owner-accepted risk with the Paid plan as the way out (D-27).
*Applied in:* ADR-0010, P0-09, P3-03, P3-14.

**L-098 — The Cache API is local and sometimes a no-op.**
It is per data centre, may not work on `workers.dev`, and may be unavailable behind some access products *(verify)*. Validate by
reading back the first write and report the cache status honestly.
*Applied in:* P8-01.

**L-099 — The Rate Limiting binding is a backstop.**
Periods of 10 or 60 s only, per location and eventually consistent: never an exact limiter.
*Applied in:* P3-04.

**L-100 — Setup scripts are idempotent per environment.**
One config and one database per Worker name, preserve variables set in the dashboard, persist the database id, refuse
a name mismatch, and reveal generated secrets before writing a backup file that may fail.
*Applied in:* P3-05.

**L-101 — Count budgets in audit records, not headers.**
Headers flush before streamed work completes, so they under-report.
*Applied in:* P2-08, P3-03.

## M. Node, Docker and self-hosting

**L-102 — Keep the Node footprint portable.**
Node 24 LTS with the built-in `node:sqlite`; a distroless non-root image with a read-only root filesystem and a
Node-based healthcheck; pure-JavaScript production dependencies so multi-arch images need no emulation.
*Applied in:* ADR-0006, P2-11.

**L-103 — No native keychain modules.**
Shell out to the OS tools and pass secrets on stdin, never in argv; no silent fallback to plain files.
*Applied in:* P8-08.

**L-104 — Test SQLite on Windows too.**
File locks make clean-up and temporary databases behave differently.
*Applied in:* P0-03, P2-02.

## N. Write tools and approvals

**L-105 — Writes are a separate product.**
Off at every layer (server switch, workspace, grant, OAuth write scope), enabled by owners only, typed operations only,
never a generic mutation passthrough.
*Applied in:* [ADR-0013](adr/0013-opt-in-writes-human-approval.md), P7-01.

**L-106 — Approval shows and binds the complete change.**
The approval text shows every field that will change (no truncation; refuse when it would be too long); approval is bound
to a hash of the canonical arguments, actor, target and expiry, and is single-use.
*Why:* a truncated approval message can hide later parts of a multi-part change.
*Applied in:* P7-01.

**L-107 — `confirm: true` is not human approval.**
Default to approval required. A client that cannot ask the human gets a refusal that is a machine-readable error, not a
success result with `applied: false`.
*Applied in:* ADR-0013, P7-01.

**L-108 — Validate fully, then ask, then re-check, then apply once.**
Validate the whole mutation before prompting, re-read the target right before applying, return an idempotent no-op when
the change is already there, and never retry a mutation that was sent.
*Applied in:* P7-01.

**L-109 — Audit the intent before the mutation.**
Write the intent durably before calling Agility; refuse the write if the intent cannot be recorded; record the outcome
after.
*Applied in:* P7-01.

**L-110 — Dry runs are complete.**
A dry run performs all validation, shows the exact change and states whether this client could approve it, without
sending anything.
*Applied in:* P7-01.

**L-111 — Write limits are deployment-wide.**
Per-isolate counters let bursts through.
*Applied in:* P7-03.

**L-112 — Rehearse writes in a sandbox before enabling them anywhere.**
Dry-run every write tool, apply one change per asset type, read it back, retry a duplicate, clean up, then disable writes
again.
*Applied in:* P7-07.

**L-237 — What an owner switched on, the owner also bounds.**
ADR-0013 says only owners enable writes, but the projects, asset types and end date of a workspace or grant that has write
tools were an administrator's to widen: adding a project to a write-enabled workspace is a decision to allow writes there. The
guard now compares the change with the stored record (a list is a set, no policy equals empty lists, narrowing is never a
widening) and asks for an owner with a recent sign-in only when it widens, so ordinary edits stay with administrators.
*Applied in:* P4-09.

## O. Caching, quotas and budgets

**L-113 — Cache keys carry every scope dimension.**
Connection, credential/key hash, grant, scopes, limits and the normalised query; authorise before the lookup; encrypt
shared cache bodies; never cache writes.
*Applied in:* P8-01.

**L-114 — Declared costs cover the worst case.**
Retries, pagination and polling count. A cost test forces the worst case on every tool and asserts requests ≤ declared
cost.
*Applied in:* P1-01, P6-11.

**L-115 — Hide what cannot fit.**
A tool whose declared cost exceeds the deployment's per-call budget is not registered, rather than served partially.
*Applied in:* P3-03.

**L-116 — Quotas count logical upstream calls.**
Not retries or cache hits; per grant, per UTC day and month; warn at 80%.
*Applied in:* P8-09.

## P. Observability and logging

**L-117 — Redaction is broad and tested.**
Structured logs to stderr; redaction covers `Bearer`/`Basic` and custom schemes, token shapes, credentials in URLs and
query parameters (`access_token`), JSON fields such as `x-api-key`, environment-style names (`DB_PASSWORD`) and PEM
blocks; errors are reduced to class and a redacted message.
*Applied in:* P1-01.

**L-118 — Separate caller faults from server faults.**
Only server faults count toward the service error rate; a refused write or a bad asset number is a caller fault.
*Applied in:* P8-07.

**L-119 — Instrument every MCP method with allowlisted attributes only.**
Never export arguments, asset content, URIs, file paths, emails or tokens.
*Applied in:* P8-07.

**L-120 — Keep security inventories from the first storage task.**
Cryptography, logging and data-protection inventories are living documents, not a pre-launch retrofit.
*Applied in:* P2-15.

**L-165 — Each redaction case asserts its own secret.**
P1-01's first corpus checked every input against one shared list of secret fragments, and one case's fragment was
missing from the list, so a Digest `Proxy-Authorization` header passed while it leaked the `response` value (the
pattern stopped at the first quote). Each case now carries the exact secret it must remove, and fakes are assembled at
run time so gitleaks needs no allowlist for them. Header credentials are redacted to the end of the line, because
schemes such as Digest hold quotes and commas.
*Applied in:* `packages/core/test/redact.test.ts`, `packages/core/src/redact.ts`, P1-01.

**L-238 — An audit row says what changed, not only which field.**
`user.update` recorded `fields: ["role"]` and nothing else: nobody could tell a promotion to owner from a demotion, and a
workspace row could not say which project had been added. A change of privilege records the new value and, for roles, the
previous one; a token issue records the token id (every tool call carries it, so a call traces back to who issued the token)
and its end; an instance row records the host, never the path or query. Values are limited to ids, roles, lists of projects
and tools, switches and reasons; names, emails and labels stay out.
*Applied in:* P4-09.

**L-240 — A feature that adds a secret adds its redaction forms in the same PR: text, key name and URL.**
The admin sign-in added the session cookie, the CSRF token, the PKCE verifier, the nonce, the setup code and the OAuth
callback `code`, and redaction covered the cookie and the setup code (token shape) but not `_csrf=…`, `code_verifier=…`,
`nonce=…` in free text, those names as object keys (`codeVerifier`, `sessionSecret`, `setupCode`) or `?code=…` in a URL.
Nothing logged them (logs carry error names only), so it was a latent gap rather than a leak; the point is that redaction
is the backstop for the day someone logs a request or an error message. Name each new secret in the redaction corpus in all
three forms (a `name=value` string, an object key, a URL query), and keep a plain `code` or `state` key unredacted: error
codes live under that name.
*Applied in:* P4-11 review, `packages/core/src/redact.ts`, `packages/core/test/redact.test.ts`.

**L-242 — A library's own rule is not a test of ours: prove each guard with a case the library lets through.**
`workers-oauth-provider` insists on PKCE for public clients, validates `resource` and the content type of token
requests itself, so our checks for the same things looked tested while a mutation of them survived. A guard is only
proven by a client the library would accept without it (a confidential client without a challenge, a foreign `resource`
that must not spend the code, a refresh after the grant ended). Keep the library's check and ours both, and say in the
test which one it exercises; where only the library can fail (a forged props block), record the mutant as equivalent.
*Applied in:* P5-01 (mutation checks recorded in the task Outcome).

**L-243 — The OAuth library's time is `Date.now()`, ours is injected: give tests one clock.**
Codes expire by the `kv` TTL (our clock) while token records carry the provider's own timestamps, so a test that moves
only the injected clock sees one half expire. Memory-backed tests run on a live clock moved with `vi.setSystemTime`;
a store that captured `Date.now` at open (SQLite) cannot be moved, so those hosts skip the time-travel cases.
*Applied in:* P5-01.

**L-244 — Discovery documents and challenges are functions of the path, not of the database.**
Protected resource metadata and the `WWW-Authenticate` challenge are the first things an unauthenticated caller sees. If
they depend on whether the workspace exists or is enabled (a `404` for unknown ones, a different challenge for known
ones), they enumerate workspaces for free next to an MCP route that is careful to answer one `401`. Build both from the
slug's syntax and the configured public URL only, and test known, unknown and disabled side by side; a slug that is not
valid syntax is the only `404`.
*Applied in:* P5-02, `packages/http-app/src/oauth/server.ts`.

**L-245 — A test stand-in for a missing sibling feature carries a task id and goes in that feature's PR.**
P5-01's SDK `auth()` test named the resource through `validateResourceURL` because discovery did not exist yet. With a
comment pointing at P5-02, the workaround was found and removed in one place, and the same test now proves that the
client learns the resource from the server alone. A stand-in without a pointer outlives its reason and hides the gap.
*Applied in:* P5-02 (suite `auth()` cases).

**L-246 — Per-route cache headers lose to the app-wide response policy: decide, then test the header you get.**
The app sets `Cache-Control: no-store` on every response except the panel's hashed assets. A route that sets its own
cache header silently ends up with `no-store`, so a "cacheable" metadata document was never cacheable. Either teach the
policy an exception on purpose (with a reason) or keep the default and assert it; the document is small and rate limited,
so the default stays (D-65).
*Applied in:* P5-02.

**L-250 — An id a stranger chooses is a storage key: size it to the key limit before it is stored.**
A `client_id` goes into `client:<id>` keys. A URL id near the store's 512-character key limit would make our own `put` of
its validated document throw once the `oauth:client:` prefix is added, so ids are capped at 400 characters before any
fetch. The provider already turns a lookup the store rejects into a `400`, and the KV adapter now also answers `null` for
reads and deletes of keys the store cannot hold; that second guard is defence in depth (a mutation of it survives, as the
provider's own error handling covers it, L-242). Test the long id on every host.
*Applied in:* P5-03, `kv-namespace.ts`, `clients-suite.ts`.

**L-251 — Cap anonymous writes per source first, and by what is stored, not by a shared window.**
relic-bridge's deployment-wide registration window let one address use it up and lock everyone out. Count attempts per
source with an atomic counter that refuses at its own maximum (`kv.increment` with `max`), then cap what is alive (live
registrations, stored documents), and the flood stops at its own limit. A refusal that writes an audit row per request
turns the cap into a storage flood, so audit the first refusal per window and reason.
*Applied in:* P5-03 (relic-bridge Phase 5 review M1 and L4), P5-09.

**L-252 — Rebuild a registration request from an allowlist of fields; do not filter what the client sent.**
RFC 7591 clients send `logo_uri`, `jwks_uri`, `client_uri`, contacts and statements. Anything stored may later be fetched,
shown or trusted by a feature written after this one. Parse, validate, and hand the provider a new body holding only the
fields we use; refuse unsupported grants and auth methods instead of dropping them so the client does not believe it has
them. The same rule keeps metadata-document clients to a name and the callbacks on their own host.
*Applied in:* P5-03, `clients.ts` (`checkRegistration`).

## Q. Testing, evals and live verification

**L-121 — Negative authorization is first-class.**
A route × principal × tool matrix asserts the exact status, the audit reason, zero upstream calls, zero mutations and no
cross-workspace or cross-project data. Every regression test must fail when its fix is reverted.
*Applied in:* P2-12.

**L-122 — Feed tools hostile upstream data.**
Foreign-scope rows, forged identifiers, poisoned strings, malformed payloads, and empty, paginated and
permission-limited responses.
*Applied in:* P1-12.

**L-174 — Check that the upstream answered the question you asked.**
The P2-12 hostile-upstream run found `get_assets` and `resolveAsset` accepting any in-scope row the upstream sent: an
upstream that ignored the `Number`/`ID` filter made `B-01003` (another project) come back as `B-01001`. Scope rechecks
are not enough; a lookup by identity keeps only rows with that identity.
*Applied in:* P2-12, `tools/query/get-assets.ts`, `identity/resolve.ts`.

**L-178 — A tampered random value must differ from the original.**
Four tests made a "wrong" device token by replacing its last character with a fixed letter; one run in 62 the token
already ended with it, the "wrong" token was the right one, and Node 26 CI failed with 200 instead of 429 (2026-10-22).
Derive the tampered value from the original so it always changes (`tamperLast`).
*Applied in:* `packages/auth/test/helpers/tamper.ts`.

**L-123 — Make property tests meaningful and deterministic.**
Generators must produce interesting cases (not worlds where almost everything is rejected), seeds must be replayable,
generated values must not collide with planted secrets, and crypto, cold-start and browser tests need explicit timeouts.
*Applied in:* P1-12.

**L-124 — Evaluate tools the way an agent sees them.**
Lint descriptions, keep a lexical router baseline in CI, and before releases run an LLM eval with the exact `tools/list`
and hostile results — never with real data or credentials.
*Applied in:* P6-10.

**L-125 — Keep live-verification evidence and recipes.**
Record date, instance/project, asset numbers, expected vs actual and redactions; write reproducible recipes for slow
reads, refusals, dry runs and applied writes.
*Applied in:* P0-12.

**L-126 — Browser E2E and a DAST scan find what unit tests miss.**
Schedule both against the admin panel.
*Applied in:* P4-08.

**L-215 — A browser test sees less than the browser, and less than the page's own script.**
Playwright's `page.evaluate` runs through the DevTools protocol, which is exempt from the page's `unsafe-eval` rule (and
`response.headers()` hides `Set-Cookie` and `Clear-Site-Data`; `allHeaders()` shows them). A test that calls `eval` that way
passes whatever the policy says. Assert `eval` and inline script by the exact header, and use the browser for what it
enforces for protocol code too: Trusted Types, `img-src`, `style-src`, `form-action`, framing.
*Applied in:* P4-08.

**L-216 — The forger a CSRF test needs is another origin on the same site, not only another site.**
`http://localhost:<other port>` is the same site as the panel (ports do not count), so `SameSite=Lax` sends the session
cookie with its forms and fetches: only the `Origin` and fetch-metadata checks and the CSRF token stand in the way. A test
with a page on `127.0.0.1` alone (cross-site, cookie withheld) passes even when those checks are gone. Run both, and a plain
link from the other site (a top-level navigation, which must work).
*Applied in:* P4-08.

**L-217 — Cross a time window by moving the stored timestamp, never by waiting or faking the clock of a child process.**
The re-authentication window is 10 minutes. The browser test moves every stored session's `createdAt` back 11 minutes in
the server's own database, then drives the real flow (the stale prompt, the refused other identity, `prompt=login`, the
retry). No sleep, no clock hook in production code.
*Applied in:* P4-08.

**L-159 — Benchmarks must yield to the event loop between requests.**
A loop of `await handler.fetch(...)` never ends the current job, so V8 keeps every request's `WeakRef` targets (the
request's `AbortSignal`, and through its listeners the transport and the whole per-request MCP server) alive until the
loop ends: the P0-07 benchmark ran out of memory and looked like an SDK leak. One `setImmediate` turn per request, as on
a real server, keeps the heap flat. Before blaming a library for a leak, read the heap snapshot's retainer path.
*Applied in:* [spikes/mcp-sdk-v2](../spikes/mcp-sdk-v2/RESULTS.md), P0-09, P3-10, P9-03.

**L-166 — Build invisible characters from code points in tests.**
Biome's formatter rewrote `\u202E`-style escapes in string literals into the raw characters, so a test of bidi
stripping silently put Trojan Source characters into the repository (regex literals kept their escapes). Tests take
such characters from `String.fromCodePoint` constants (`packages/core/test/helpers/chars.ts`), and a review greps for
raw invisible characters.
*Applied in:* P1-05.

## R. CI, release and supply chain

**L-127 — Separate building from publishing.**
Build and test without OIDC; a minimal publish job that runs no project code gets `id-token: write`, verifies checksums
and the tag, and publishes; a staged npm publish needs a second human approval.
*Applied in:* P1-15.

**L-128 — Releases are idempotent and tags never move backwards.**
A rerun detects an identical package already on npm and still creates the GitHub Release; `latest` image tags never
point to an older version.
*Applied in:* P1-15, P2-11.

**L-129 — GitHub-hosted runners only.**
Never fall back to self-hosted runners for public pull requests.
*Applied in:* P0-03.

**L-130 — Pin and verify everything the pipeline runs.**
Actions by full SHA, downloaded tools by version and an independently trusted digest (kept up to date by Renovate),
runner egress policy, least-privilege permissions, no `pull_request_target`.
*Applied in:* P0-03, P0-04.

**L-131 — Guard the release path.**
Fixtures for new migrations, README and version status, changesets naming only published packages, full git history
for version PRs, a backport branch path.
*Applied in:* P1-15, P9-07.

**L-132 — Harden dependency intake.**
Minimum release age for new versions, no trust downgrades, blocked exotic sub-dependencies, explicit build-script
approvals, and published advisory deadlines (critical 7 days, high 14, moderate 30).
*Applied in:* P0-02, P0-04.

**L-157 — Verify a publish against the registry, not through a wrapped client.**
A local npm wrapper that enforces a minimum release age (here Safe-chain) hides versions published minutes ago, so
`npm view` reports a successful publish as missing and a retry fails with 403 "cannot publish over 0.0.0". Check
`https://registry.npmjs.org/<name>` directly and compare the shasum. A first staged publish also creates a public
`0.0.0-stage` stub, and the 2FA approval needs an interactive terminal.
*Applied in:* P1-15.

## S. Documentation and configuration

**L-133 — Execute the documentation.**
Every documented command runs in CI or a verification script against the shipped artifacts (fresh checkout, container,
Worker).
*Why:* documentation drifts silently: paths, environment variables and commands go stale with every release.
*Applied in:* P1-14, P2-16, P3-07.

**L-134 — Generate references from code.**
Tools, CLI, admin API and configuration references are generated, never hand-maintained.
*Applied in:* P1-13, P2-09.

**L-135 — README and docs are release artifacts.**
Reconcile them with the shipped version in the release PR.
*Applied in:* P1-15, P9-04.

**L-136 — One configuration surface.**
One prefix (`AB_`), validated at boot, unknown keys rejected, YAML up to 1 MiB with `${ENV}` or keychain references and a
warning unless mode `0600`, flags override environment, never secrets in flags.
*Applied in:* P1-11.

**L-241 — Numbered indexes are checked by a test, not by eye.**
Lesson L-200 was missing from its theme index for a whole phase and nobody noticed, and decision numbers D-20 and D-21 exist
twice (Phase 0 and Phase 1 files) because two branches took the next free number. History is never renumbered, so the
repeat is pinned as the only accepted one. `scripts/test/numbering.test.ts` fails on a repeated or unlisted lesson, on an
index entry without a lesson and on any new repeated decision number: take the next free number after rebasing, and add the
index entry in the same edit as the heading.
*Applied in:* P4-11 review, `scripts/test/numbering.test.ts`.

## T. Agility platform behaviours

Facts from the Agility documentation that change how the server must behave. Sources are in
[RESEARCH.md](RESEARCH.md) §1; items marked *(verify)* are confirmed or corrected by the P0-06 spike.

**L-137 — Always send an explicit page size.**
Omitting `page` returns the entire result set (the response reports a page size of 2,147,483,647).
*Applied in:* P1-04.

**L-138 — Validate before sending; quotas can count errors.**
Agility rate limits are configured per tenant and can count requests, response size or **errors**. A 429 answers
with a JSON body such as `{"Message": "API request quota exceeded. Maximum of 20 errors per 60 second(s)",
"RetryAfter": "50"}`: the wait is in the body, not in a `Retry-After` header. Invalid requests sent by the server can
lock the member's token out, so validate against metadata first, honour `RetryAfter`, and back off conservatively when
it is missing.
*Applied in:* [ADR-0010](adr/0010-platform-limits-strategy.md), P1-02, P1-04.

**L-139 — `with` is substitution, not a prepared statement.**
Bound values still land inside the filter grammar, and no escaping rule is documented for `rest-1.v1`'s
`$Var=a,b|$Other=c` form. Use the `query.v1` JSON `with` mapping, type-check every value, refuse control characters,
and never pass caller strings as filter tokens.
*Applied in:* [ADR-0012](adr/0012-structured-query-no-raw-passthrough.md), P1-04.

**L-140 — A 404 means "not found or not visible".**
Agility does not distinguish a missing asset from one the member cannot see. Say "not found or not visible with this
token", never "does not exist".
*Applied in:* P1-02, P1-06.

**L-141 — Number prefixes vary per instance.**
Stories appear as `B-` on some instances and `S-` on others; `D-`, `TK-`, `AT-`, `E-`, `I-`, `R-`, `RP-`, `RS-` and
`TS-` are common; `meta.v1` does not expose prefixes. Discover the prefix map per instance (with configuration
overrides) and resolve unknown numbers by querying, never from a hard-coded table *(verify)*.
*Applied in:* P0-06, P1-06.

**L-142 — Status, AssetState and rollup category are different things.**
Status lists are admin-configurable per asset type (and can differ by team process); `AssetState` is the lifecycle
integer (0 Future, 64 Active, 128 Closed, 200 Template, 208 Broken down, 255 Deleted); the rollup category (Not
Started / In Progress / Completed) is for reporting only. Never hard-code status names: read them from the instance.
*Applied in:* P1-03, P1-09, P7-04.

**L-143 — Aggregations include dead assets unless told otherwise.**
`.@Count`, `.@Sum` and friends do not exclude deleted or template assets: add an explicit `AssetState` filter to every
aggregate and to default lists.
*Applied in:* P1-04.

**L-144 — `total = -1` means "not computed".**
Without `needTotal`, `query.v1` returns `-1`; never report it as zero, and request totals only when shown. ADR-0015
settled the shape: an uncomputed total is omitted (no `null` in schemas), and on 26.0.3.2 lists return no totals at all
(L-163).
*Applied in:* P1-05.

**L-145 — Single-asset URLs ignore `where`.**
A filter on `/Data/<Type>/<id>` does nothing, so it can never enforce scope: check the returned asset's scope instead.
*Applied in:* P1-08, P2-12.

**L-146 — The activity stream is not authoritative.**
It "may not contain every change"; use `rest-1.v1/Hist` (or `asof` queries) for history.
*Applied in:* P6-05.

**L-147 — Access tokens are full delegation and never expire.**
A token carries every role and project membership of its member until revoked; there are no scopes. The server's
grants are the only narrowing: recommend dedicated members for shared read-only credentials, revalidate tokens
periodically and document revocation.
*Applied in:* [ADR-0007](adr/0007-secrets-envelope-encryption.md), [ADR-0008](adr/0008-access-model.md), P2-13.

**L-148 — Learn the model from metadata, then verify relations live.**
`meta.v1` needs no authentication and lists attributes, types, operations and inheritance. Abstract types (`BaseAsset`,
`Workitem`, `PrimaryWorkitem`) need downcasts (`Workitems:Story`) to reach subtype attributes; `Note` is now
`Conversation`; Feature and Initiative are not asset types but categories of `Epic`; the portfolio tree uses
`Super`/`Subs` while tasks and tests hang under backlog items through their own parent relation *(verify)*.
*Applied in:* P1-03, P1-04.

**L-149 — Send UTC, read the UTC variants.**
Dates are ISO 8601 with `Z` and up to 7 fractional digits; `ChangeDate`/`ChangeDateUTC`-style pairs exist with
undocumented semantics. Always send `Z`-suffixed UTC, prefer the `…UTC` attributes, and keep the raw value.
*Applied in:* P1-04, P1-05.

**L-162 — A comma in a bound value becomes a list.**
`query.v1`'s `with` keeps quotes, `|`, `;`, parentheses, brackets and newlines literal, but splits a scalar value at
commas: `Number = $v` with `$v = "x,B-01234"` matched `B-01234` on a live 26.0.3.2 tenant. A caller-controlled scalar
can widen a filter into a list. The compiler refuses commas in scalar values (or turns them into an explicit list only
where the argument is a list), and the property tests include this case.
*Why:* found by the P0-06 binding probe; L-139 predicted substitution but not which characters survive it.
*Applied in:* [spikes/agility-api](../spikes/agility-api/RESULTS.md), P1-04, THREAT_MODEL T4.

**L-163 — Sorting by `ChangeDate` costs a second.**
On a live tenant, `sort: ["-ChangeDate"]` cost about 1.1 s per call whatever was selected; `sort: ["ID"]` cost about
0.23 s and pages stayed disjoint and repeatable. Default sorts use `ID`; "most recent first" is an explicit option
whose cost the tool declares. And `needTotal` returned no total on 26.0.3.2: show "more available" (fetch `size + 1`),
not a total.
*Applied in:* [spikes/agility-api](../spikes/agility-api/RESULTS.md), P1-04, P1-08, ADR-0015.

---

## Top 20

The lessons that save the most time, in order:

1. **L-003** Live verification against an Agility sandbox from Phase 0.
2. **L-005** The tool contract before tool number five.
3. **L-057** No string-built queries: bound parameters and metadata-checked identifiers only.
4. **L-063** One effective-permission resolver; tools not granted are neither listed nor callable.
5. **L-038** Every upstream string inside the untrusted-data envelope, on every output path.
6. **L-033** No silent fallbacks or plausible zeros: `partial` and `notes`.
7. **L-013** No request data in module state.
8. **L-105** Writes are a separate, opt-in product.
9. **L-106** Approval binds the complete, exact change.
10. **L-107** `confirm` is not approval; refusals are errors.
11. **L-023** A real-client matrix as a release gate.
12. **L-011** Both MCP protocol eras on every runtime.
13. **L-086** OAuth and configuration state in shared storage, never isolate memory.
14. **L-065** Every alternate writer is an authorization boundary.
15. **L-071** One schema and one migration history for SQLite and D1.
16. **L-074** The master key never lives next to the data.
17. **L-127** Build and publish in separate jobs.
18. **L-121** Negative authorization tests that fail when the fix is reverted.
19. **L-133** Executable documentation.
20. **L-001** Measure before you build.
