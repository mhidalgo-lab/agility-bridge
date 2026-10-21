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
| [D. Tool design and the output contract](#d-tool-design-and-the-output-contract) | L-030 – L-045, L-150, L-153 |
| [E. The Agility API client](#e-the-agility-api-client) | L-046 – L-056, L-152, L-160 |
| [F. Query safety and limits](#f-query-safety-and-limits) | L-057 – L-062 |
| [G. Access model, tokens and isolation](#g-access-model-tokens-and-isolation) | L-063 – L-070 |
| [H. Storage, migrations and secrets](#h-storage-migrations-and-secrets) | L-071 – L-078, L-161 |
| [I. HTTP, rate limiting and abuse](#i-http-rate-limiting-and-abuse) | L-079 – L-085, L-151 |
| [J. OAuth and identity](#j-oauth-and-identity) | L-086 – L-094, L-164 |
| [K. Admin UI](#k-admin-ui) | L-095 |
| [L. Cloudflare Workers](#l-cloudflare-workers) | L-096 – L-101 |
| [M. Node, Docker and self-hosting](#m-node-docker-and-self-hosting) | L-102 – L-104 |
| [N. Write tools and approvals](#n-write-tools-and-approvals) | L-105 – L-112 |
| [O. Caching, quotas and budgets](#o-caching-quotas-and-budgets) | L-113 – L-116 |
| [P. Observability and logging](#p-observability-and-logging) | L-117 – L-120, L-165 |
| [Q. Testing, evals and live verification](#q-testing-evals-and-live-verification) | L-121 – L-126, L-159 |
| [R. CI, release and supply chain](#r-ci-release-and-supply-chain) | L-127 – L-132, L-157 |
| [S. Documentation and configuration](#s-documentation-and-configuration) | L-133 – L-136 |
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

## K. Admin UI

**L-095 — Server-rendered, script-light, and calling its own API.**
Auto-escaped server rendering only, no inline scripts or styles, a strict CSP with hashed assets,
`frame-ancestors 'none'`, CSRF synchronizer tokens plus Origin/Fetch-Metadata checks, mutations only through POST. The
panel calls the admin API in-process so validation, authorization and audit are identical.
*Applied in:* [ADR-0004](adr/0004-typescript-runtime-agnostic-core.md), P4-03.

## L. Cloudflare Workers

**L-096 — Never share in-flight I/O between requests on Workers.**
I/O started by one request may hang or fail when awaited by another. Cache completed values only; make boot
single-flight per request.
*Applied in:* P3-01.

**L-097 — Design for the Free plan's limits, not its tolerance.**
About 10 ms CPU per request, 50 external subrequests and 6 simultaneous outbound connections on the Free plan *(re-verify)*.
Small responses fit, and short CPU overruns may be tolerated, but never rely on that: enforce response caps (start with
512 KiB on Free and 8 MiB on Paid *(re-measure)*) and per-call budgets.
*Applied in:* ADR-0010, P0-09, P3-03.

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

## Q. Testing, evals and live verification

**L-121 — Negative authorization is first-class.**
A route × principal × tool matrix asserts the exact status, the audit reason, zero upstream calls, zero mutations and no
cross-workspace or cross-project data. Every regression test must fail when its fix is reverted.
*Applied in:* P2-12.

**L-122 — Feed tools hostile upstream data.**
Foreign-scope rows, forged identifiers, poisoned strings, malformed payloads, and empty, paginated and
permission-limited responses.
*Applied in:* P1-12.

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

**L-159 — Benchmarks must yield to the event loop between requests.**
A loop of `await handler.fetch(...)` never ends the current job, so V8 keeps every request's `WeakRef` targets (the
request's `AbortSignal`, and through its listeners the transport and the whole per-request MCP server) alive until the
loop ends: the P0-07 benchmark ran out of memory and looked like an SDK leak. One `setImmediate` turn per request, as on
a real server, keeps the heap flat. Before blaming a library for a leak, read the heap snapshot's retainer path.
*Applied in:* [spikes/mcp-sdk-v2](../spikes/mcp-sdk-v2/RESULTS.md), P0-09, P3-10, P9-03.

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
Without `needTotal`, `query.v1` returns `-1`; report `null`, never zero, and request totals only when shown.
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
