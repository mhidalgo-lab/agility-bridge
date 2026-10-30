- **Scope:** the power features of Phase 8 (P8-01 … P8-11): the query cache, deep links, MCP Apps views, `doctor`, configuration
  export and import, client integrations and the Claude Code plugin, self-monitoring, the OS keychain, per-grant quotas, MCP Tasks and
  the public tool catalogue, as merged on `main` at `ae19fbd` (range `eed67c4..ae19fbd`). The live checks (P8-13, P8-15, P8-19) are
  not part of it: the real-client and real-Cloudflare behaviour of every feature stays *unverified*.
- **Date:** 2026-10-30. **Branches:** `task/P8-12-review-fixes-runtime` (server runtime: cache, quotas, Tasks, telemetry,
  docs, this document) and the CLI-side branch of another agent (config bundle, keychain, doctor, client snippets, stdio settings).
- **Method:** three independent, read-only reviews (security, quality and correctness, performance and cost), each reading the
  code and tests without changing or running anything against Agility. Every finding was then **verified against the code here**
  before it was changed; a fix starts with a test that fails without it (L-330), and what did not hold, or could not be fixed
  cheaply, was downgraded or filed with the reason. Reviewer timings came from a loaded machine, so only counts and orders of
  magnitude are used. Nothing was run against Agility.
- **Status of P8-12:** unchanged (`todo`): it waits for the live pass (P8-13, P8-15, P8-19) and the owner's steps (Cloudflare
  resources, real clients). This review is the written part of its acceptance criteria; the feature freeze for 1.0 is the owner's call after
  the live pass.

## Verdict

**No critical or high security finding.** The layering held where the reviewers pushed: query-cache ids bind every scope dimension
and no caller-supplied one, bodies in the shared tier are sealed and bound to their id, the public catalogue is registry-only and
reads no storage, a task is bound to the device, grant and workspace that created it and sealed under its own key, spans carry
an allowlist and nothing else, and no module-level request state was introduced. The runtime side has one medium security-adjacent
finding (the shared tier could serve an answer up to twice its TTL old, contradicting the guide), three further medium quality
findings (the first poll of a task, a refused quota spending budget, the CLI-side import) and a set of lows about Tasks, quotas and
telemetry cost. Of the runtime findings, eighteen are fixed here, four are documented decisions or accepted residuals, and six become
follow-up tasks (P8-35 … P8-40). One statement in the guide was wrong (a task is about 6 statements per poll, not 4) and is corrected.

## Findings, runtime side

IDs are the reviewers' (S = security, Q = quality, P = performance). Verdicts: **fixed here**, **documented** (a decision or an
accepted residual, with the reason), **deferred to <task>**, **not a defect**.

### Query cache

| # | Finding | Verdict |
|---|---|---|
| Q-1 (medium) | A shared-tier hit promoted to memory restarted the TTL: an answer could be served up to 2 x TTL (120 s at the 60 s maximum) old, against the guide's "never older than half a minute" | **fixed here** (verified at `query-cache.ts`: `#remember` gave `until = now + ttl`). The write time now travels in front of the text inside the sealed body (so it is authenticated and bound to the entry id) and the promoted copy lives only until `writtenAt + ttl`; a missing or unreadable time is a miss, a time in the future is clamped. Test with a clock moved past the first TTL (fails without the fix). D-297, L-448 |
| Q-11 (low) | The bypass was keyed on `workspace.writes.enabled`, not on the caller's own write tools, so a read-only grant in a writing workspace lost the cache and `whoami`'s block, while the guide said a "caller who has write tools" bypasses it | **fixed here**: keyed on `ctx.writes` (present only when this caller has write tools). Residual, documented: a read-only grant beside a writing one can show up to one TTL of pre-write data. D-298 |
| P-1 (medium) | `toBase64` concatenated a string per byte: milliseconds per 64 to 256 KB sealed, against a 10 ms Free CPU budget | **partly fixed here**: slices of 8 K bytes (about 1.6 x faster on Node's V8, bytes identical, tested around the slice edges). The rest (base64 itself, two JSON parses, a lower cap for the shared tier than the memory tier's 256 KiB, a 100 KB bench body) needs workerd numbers: **deferred to [P8-38](../tasks/phase-8-power-features/P8-38-shared-tier-size-and-cpu.md)**; the guide now says the tier suits small answers |
| P-4 (medium) | A miss stringified the whole response before checking the size cap (2.8 to 4.1 ms for 257 to 512 KiB, then discarded) | **fixed here**: `QueryCache.accepts(res.bytes)` is checked before `encodeResponse` (test: an over-cap answer is not stored and the second read asks Agility again) |
| P-10 (low) | No single flight for concurrent identical misses; an expired entry behind a live one lingers | **deferred to [P8-35](../tasks/phase-8-power-features/P8-35-catalogue-cache-single-flight.md)**: sharing a promise across requests is not allowed on Workers (workerd forbids another request's I/O objects), so it needs its own design; the lingering entry is bounded by the entry and byte limits and not worth a change alone |

### Quotas

| # | Finding | Verdict |
|---|---|---|
| Q-4 (medium) | A refused quota still spent a call-budget unit and was reported as a request that reached Agility (audit `requestsUsed`, log, span) | **fixed here** (verified at `client.ts` `#send`): the quota is asked before the unit is spent, and an exhausted budget is refused before the quota counts one. Tests assert `budget.used === 0` after a refusal and no quota unit after a budget refusal. D-299, L-449 |
| S-5 (low) | Parallel requests of a grant each read the counters once and can overshoot by requests in flight x call budget; a counter outage fails open | **documented**: a soft cap by design (D-249, L-415); the bound is now stated in the guide. A hard cap is an atomic reservation per call, a D1 write for every Agility request, which is the budget the design exists to save. D-296 |
| P-2 (medium) | Quota read and flush and the cache's put and read-back all sat on the critical path | **fixed here where it proves nothing**: the counters' write and the shared-tier store move to the host's `background` (`waitUntil`) through an optional `ToolContext.background`, absent on Node and stdio. The quota **read** that decides a refusal, authorization, the budget, audit intent and the write limiter stay on the request path (test: a counter write that never finishes does not delay the response, and the count still lands). D-295, L-450 |
| P-7 (low) | `cloudflare-limits.md` was not updated for the quota's statements on the write flows | **fixed here** (docs): write flows gain 3 statements and about 2 rows with a quota set; a Tasks and telemetry section added. Combining the two periods into one statement: **deferred to [P8-39](../tasks/phase-8-power-features/P8-39-quota-statements-and-metadata.md)** |
| Q-10 (low, quality; not in the fix list) | Metadata requests count against the quota, so drain depends on isolate recycling | **verified in code, deferred to [P8-39](../tasks/phase-8-power-features/P8-39-quota-statements-and-metadata.md)** (an owner decision: exclude or count one unit per request) |

### MCP Tasks

| # | Finding | Verdict |
|---|---|---|
| Q-2 (medium) | The first poll runs the report inline: an abandoned poll leaves a 200 s lease, polls answer `working` for 3+ minutes, then the report runs again; no test for lease expiry or a crashed runner | **partly fixed here**: the poll that runs the report had no deadline at all (it was outside the request's race): it now has the request deadline and a report that does not fit **fails the task** (stored, never rerun); a runner that throws also fails it; the lease is released in `finally`. Tests: a hanging report with a 150 ms deadline, a throwing runner, and lease expiry with a clock (a lease left by a runner that never returned blocks until it expires, then one rerun). **Residual, documented:** a client that drops the poll can still leave the task `working` until the lease ends, because the platform may cancel the request without running our code; only a background runner removes it (**[P8-36](../tasks/phase-8-power-features/P8-36-background-task-runner.md)**, needs the owner's Cloudflare decision). The stated benefit ("survive a client's timeout") holds for the creating call, not for a poll that outlives the client. D-300, L-451 |
| Q-5 (low) | Cancel and complete were read-modify-write without a version check, so an acknowledged cancel could be overwritten | **fixed here**: a cancel stores a marker first; the finishing poll saves, then checks the marker and rewrites `cancelled`; both orders end `cancelled`. The test forces the cancel between the final read and the save (fails without the fix). D-301 |
| Q-6 (low) | `ttlMs` was always 15 minutes | **fixed here**: the remaining life (`expiresAt - now`); test at minute 14 |
| S-3 (low) | Creation unvalidated and unbounded: arguments stored verbatim, no per-grant cap, no quota | **fixed here**: the arguments must be an object of at most 8 KiB valid for the tool's own input schema (refused before anything is stored); 30 creations per grant per 15-minute window through an atomic capped counter (a refusal stores nothing, another grant is unaffected). A quota unit at creation is **not a defect**: creation asks Agility nothing, and the report's own audit and quota apply when it runs. D-302, L-452 |
| S-4 (low) | A finished result was returned without re-checking the grant's current tools or scope | **fixed here**: it is returned only while the caller still holds the report tool and a digest of projects, asset types and limits equals the one stored when the report ran, else the one "Unknown or expired task" (tests at the HTTP level for a removed tool, and on the service for a narrowed scope). Records are not deleted on narrowing; they expire in 15 minutes and are unreadable meanwhile |
| P-5 (low) | A result too large to save failed after the report ran; the lease stayed; the report ran again | **fixed here**: a result above 150,000 characters, checked before sealing, or one that fails to save becomes a short `failed` record; the lease is released; no rerun (test with a 400,000-character result). The guide's cost line (about 4 statements) was wrong: create is 2, the running poll about 6, a finished poll 1; corrected. D-303 |

### Telemetry, Apps and the public catalogue

| # | Finding | Verdict |
|---|---|---|
| P-3 / S-8 (medium perf, info security) | A span and, on Workers, an outgoing OTLP request for every 401, 429 and public-catalogue request; no batching | **fixed here for the amplification**: spans of unauthenticated requests are limited to 30 a minute per process or isolate and counted in `stats().sampledOut` (HTTP test: 12 unauthenticated requests, 3 spans with a budget of 3, authenticated spans never sampled). Batching on Workers: **deferred to [P8-35](../tasks/phase-8-power-features/P8-35-catalogue-cache-single-flight.md)**. D-304, L-453 |
| S-8 (info) | The OTLP endpoint is held to no public-address rule; a caller's trace id is adopted | **documented, not a defect**: the endpoint is operator configuration and an internal collector is a legitimate target; the trace id is adopted only for authenticated requests, never forwarded, and carries no data beyond the allowlist. Written in the guide and T30. D-305 |
| S-9 (info) | The Apps view posts with target `'*'` | **not a defect**: the sandboxed host's origin cannot be known; the listener accepts only the parent as source; the messages carry no secret and the page has no network. The reason is recorded at the call and in T27 |
| S-10 (info) | The anonymous `server/discover` advertised the Tasks extension | **fixed here**: the anonymous prepared request carries no extensions (test: anonymous without, signed in with) |
| P-8 (low) | Uncached 37.6 KB `tools/list` per anonymous request | **deferred to [P8-35](../tasks/phase-8-power-features/P8-35-catalogue-cache-single-flight.md)**: a `Cache-Control` header does nothing for a POST; the fix is an isolate-level serialised answer with the id substituted. The guide states that the per-address limiter is the only brake until then |

### Other performance and docs findings

| # | Finding | Verdict |
|---|---|---|
| P-9 (low) | The bench and baseline cover only the cache; no scenario for quota, Tasks, telemetry, deep links, Apps or the catalogue | **deferred to [P8-37](../tasks/phase-8-power-features/P8-37-bench-phase-8-hot-paths.md)**: a baseline taken on this loaded machine would be noise (the reviewers' own runs flagged every ratio). The `cost` values of tools hold: Phase 8 adds no Agility request |
| P-6 (low, not in the fix list) | Deep links parse the base and every link per row and sit after the output caps | **verified in code, deferred to [P8-40](../tasks/phase-8-power-features/P8-40-deep-links-per-row-cost.md)** |

### CLI side

Branch `task/P8-12-review-fixes-cli`. Decisions D-287 … D-293, lessons L-443 … L-445, follow-ups P8-31 and P8-32.
P8-12 itself stays `todo` (it waits for the live pass).

**S-1 (medium) — Config bundle: addresses and credential-to-instance map not authenticated; the plan hid the URLs** — **fixed**
(verified: only `secrets` was sealed, the AAD was the fixed header; `credentials.create` validates the token against the instance URL,
so an edited `baseUrl` would receive it). The AAD now includes the canonical instance addresses and the credential-to-instance map
(file version 2, D-287); an edit fails with the same message as a wrong passphrase, before any request. The plan names each
address. Tests: seal/open with a binding, an edited file refused with nothing created, the plan shows addresses. Lesson L-443.

**S-2 (low) — `keychain:` reads any service; a project `.mcp.json` can redirect `AB_AGILITY_URL`** — **partly fixed, rest deferred to P8-31**.
Verified. An environment value (`AB_AGILITY_TOKEN`, `AB_MASTER_KEY*`) may now name only the `agility-bridge` service, so another
application's entries cannot be read; the user's own YAML file may still name any service (D-290). The redirect of the user's own
default entry to another host is not closed by that (the hostile file can use the default name): binding an entry to its
instance host is P8-31. The info remark about `keychain set` replacing an item with the same attributes is user-initiated: not a defect.

**S-6 (low) — doctor: chmod of a shared directory, control characters, FIFO** — **fixed** (all three verified; D-289). `--fix` repairs
the data directory only when `AB_DB_PATH` is not set (otherwise the command is printed); control characters are replaced in every
finding; client files are opened with `O_NONBLOCK` and `fstat`ed (a FIFO is skipped; an `lstat` first was a race CodeQL flagged). Tests for each. Lesson L-445.

**S-7 (low) — `client-config claude-code` unquoted** — **fixed**. Every interpolated value is single-quoted, `--keychain` is validated
with the reference parser. The test feeds `;`, `&`, `$()`, `|` and a quote through `--url` and checks that nothing outside quotes
is shell syntax.

**Q-3 (medium) — import cannot finish a partly failed run** — **fixed** (verified: the existing-workspace branch skipped every grant).
`config import --add-grants` (off by default, D-288) creates the file's service grants that an existing workspace lacks by label,
through the same admin checks; stderr prints the recovery steps when a run fails or leaves a workspace without its default credential.
Test: revoke the imported grant, a plain re-run skips it, `--add-grants` creates it once and a third run reports `exists`.

**Q-7 (low) — stdio silently ignores serve-only settings** — **fixed** (verified: no code under `apps/cli/src` reads them). A stderr
warning names the ones present when stdio starts configured (D-291); a shell with no Agility configuration (doctor, management
commands) is not warned.

**Q-8 (low) — `keychain status` "available" without a probe; `doctor --offline` reads the keychain** — **fixed** (D-292, L-444).
`available()` now needs exit status 0 (Linux: a lookup of a random attribute answering exit 1 with no message); `--offline` resolves no
keychain reference and reports the dependent checks as `skip`.

**Q-9 (low) — Windows script code page** — **fixed as far as it can be without a Windows machine** (D-293). The script pins UTF-8
(no BOM) for input and output, and `set` refuses a non-ASCII secret until a real run proves it (P8-32). Verified by reading the
script: the read-back shared the mangling, as the reviewer said; the test checks the script text and the refusal only (*unverified* on
Windows).

## What was found sound

- **Query cache keys:** an HMAC over canonical JSON of endpoint, instance id and URL, workspace, grant, principal, credential kind,
  projects, asset types, limits and the whole compiled body; no dimension is caller-supplied; only successful answers are stored; a
  hit is re-parsed and goes through the same shaper. The edge tier seals with the entry id as additional data, so a copy under
  another id fails to open.
- **Public catalogue:** only without credentials, POST only, 16 KiB body cap, five methods, registry tools of the default groups,
  handlers that refuse, a frozen context and no storage read; the same bytes for every workspace name.
- **Tasks:** a 256-bit handle, only its SHA-256 as the key, a record sealed with its own purpose and the hash as additional data,
  ownership by grant, workspace and device token, one identical "Unknown or expired" for every miss, the run through the normal
  pipeline with current access, an atomic lease, and revocation failing authentication first.
- **MCP Apps views and deep links:** static page, CSP by hash with `connect-src 'none'`, text only through `textContent`; deep links
  built from the pinned origin and path and a strict OID or number, with a post-hoc check.
- **OTel:** a pinned allowlist of 10 span keys and 3 resource keys with shape validators, strict `traceparent`, no redirect, a 3 s
  timeout, headers validated and never echoed.
- **Quota:** one choke point (first attempt only), per-grant keys, counters validated as digits, `unknown` never shown as unlimited.
- **AGENTS.md hard rules:** no `node:*` import in core, auth, http-app or admin-ui in the range, no module-level request state
  (the optional `background` hook is set per request), logs to stderr through the redacting logger.

## Checks

Targeted suites for every changed area pass (query cache, quota, tasks, telemetry, public catalogue, keyring); `pnpm lint` and
`pnpm typecheck` are clean; the full suite runs in CI. A regression check reverted the source changes and re-ran the new tests:
they fail without the fixes and pass with them. Nothing was run against Agility.

## New work

| Id | What | Why |
|---|---|---|
| [P8-35](../tasks/phase-8-power-features/P8-35-catalogue-cache-single-flight.md) | Public catalogue response cache, query-cache single flight, OTLP batching | P-8, P-10, P-3 |
| [P8-36](../tasks/phase-8-power-features/P8-36-background-task-runner.md) | Run MCP Tasks outside the poll (owner's Cloudflare decision) | Q-2 residual |
| [P8-37](../tasks/phase-8-power-features/P8-37-bench-phase-8-hot-paths.md) | Bench scenarios and baseline for the Phase 8 hot paths | P-9 |
| [P8-38](../tasks/phase-8-power-features/P8-38-shared-tier-size-and-cpu.md) | Shared-tier size cap and CPU of sealing, measured on workerd | P-1 |
| [P8-39](../tasks/phase-8-power-features/P8-39-quota-statements-and-metadata.md) | One statement per request for two periods; whether metadata counts | P-7, Q-10 |
| [P8-40](../tasks/phase-8-power-features/P8-40-deep-links-per-row-cost.md) | Deep links: parse once, links under the output cap | P-6 |

Decisions recorded: D-295 … D-305 in [phase-8.md](../pending-decisions/phase-8.md) and D-287 … D-293 on the CLI side.
Lessons: L-448 … L-453 and L-443 … L-445 on the CLI side. CLI-side follow-ups: P8-31 and P8-32.
