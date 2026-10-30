# Pending decisions — Phase 8

> Open questions and owner steps from Phase 8 (power features). Answer inline (`**Owner:** …` with a date).

> The owner authorised the whole phase as a batch (2026-10-30): decisions marked *built as …* are implemented at their
> recommendation; say so if you want the alternative.

## Decisions

### D-242 — The query cache is off by default, with one TTL for everything *(P8-01)*
- **Context:** A cache that is on by default changes what every deployment's agents see (a read up to the TTL old), and the moving windows of Agility reads (`today`, "last 7 days") make long lifetimes misleading.
- **Options:** (a) off by default; `AB_QUERY_CACHE_TTL` 0-60 s, one value for every entry; (b) on by default at 15 s; (c) a TTL per tool or per query kind.
- **Recommendation:** (a), built. Owners opt in knowingly; a single short ceiling (60 s) is easy to explain and test; per-tool TTLs can follow once real traffic shows which reads repeat.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-243 — Where the cache hooks in, and who never uses it *(P8-01)*
- **Context:** Many tools call `AgilityClient.query`; writers must see their own writes (ADR-0013) and a stale pre-read next to an approval would mislead the person approving.
- **Options:** (a) inside `AgilityClient.query`, default on for any context that carries a cache, skipped for callers with write tools and for reads passing `fresh` (the write layer's pre-read does); (b) opt-in per tool call site (safer by default, but every tool must remember); (c) invalidate by generation on every write (works in one process only).
- **Recommendation:** (a), built. One place, keyed from the same context the request runs with, so no call site can forget a scope dimension; (c) would not cover other isolates, so callers with write tools simply do not cache.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-244 — The shared tier is a second switch and is skipped for write callers *(P8-01)*
- **Context:** The Workers Cache API is local to a data centre, may be a silent no-op, and its subrequest accounting on the Free plan is unverified (L-098).
- **Options:** (a) separate `AB_QUERY_CACHE_EDGE=on`, sealed bodies, used only after a read-back proved it works, retried after 10 minutes when unavailable; (b) always on with the cache; (c) no shared tier at all.
- **Recommendation:** (a), built. In-memory covers the common burst of repeats in one isolate; the shared tier is an experiment until P8-13 measures it on a deployed Worker.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-245 — Pass-through callers are keyed by their token fingerprint *(P8-01)*
- **Context:** Every pass-through caller of a workspace has the same credential id, but each acts with their own Agility token and sees what that member sees.
- **Options:** (a) the principal in the key is `pt:` plus the keyed fingerprint already computed for the identity cache (instance and token, `audit-identity` purpose); (b) never cache pass-through requests; (c) key by the credential id and accept the mix.
- **Recommendation:** (a), built; (c) would show one member's data to another. The token itself never enters the key input as plain text, only its fingerprint, and the whole input is hashed again.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-246 — A new `cache-body` key purpose for the shared tier *(P8-01)*
- **Context:** The keyring already reserves `cache-id` (a keyed hash). Sealed bodies need an encryption purpose.
- **Options:** (a) add `KeyPurpose.CacheBody` (AES-GCM, derived with its own label); (b) reuse `Credentials` or `Task` (one key for unrelated data); (c) skip encryption and rely on keyed ids (bodies are Agility data, so no).
- **Recommendation:** (a), built; a key derived for one purpose is useless for another, and the Worker derives it at boot only when the shared tier is on.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-247 — Quota settings: two limits for every grant, off by default *(P8-09)*
- **Context:** The task names `AB_LIMIT_QUOTA`, which is already the error code of a refused quota. Counters are per grant; the limits could also differ per grant or workspace.
- **Options:** (a) `AB_QUOTA_DAILY` and `AB_QUOTA_MONTHLY`, deployment-wide numbers applied to every grant, each off when unset; overrides later (P8-14); (b) one combined setting (`daily=,monthly=`); (c) per-grant limits in the grant policy now (admin API, CLI, panel and access model changes).
- **Recommendation:** (a), built. Two plain integer settings follow the existing ones; `AB_LIMIT_QUOTA` stays the error code; overrides are a separate task because they touch the policy schema, the guards (an administrator must not loosen an owner's value) and three admin surfaces.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-248 — Count logical calls, write the total once per request *(P8-09)*
- **Context:** Workers Free allows 100,000 D1 rows written a day and 50 D1 statements a request; one increment per upstream call (up to 45 a tool call) would eat both.
- **Options:** (a) count in memory per request (a call is counted at its first attempt, a cache hit never reaches the client) and add the total to the day and month counters when the call ends, with one read at the first upstream call; (b) increment per call (exact, atomic, many rows); (c) count in the audit rows and sum them.
- **Recommendation:** (a), built: at most 1 read and 2 increments per request. The cost is a small overshoot when requests of one grant run at once, documented.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-249 — Fail open on a counter outage; writes are counted, not refused *(P8-09)*
- **Context:** L-080 asks for an explicit fail-open or fail-closed choice. A quota is a cost control, not an authorization; a write's approval is single use and the write limiter already fails closed.
- **Options:** (a) reads fail open on an unreadable counter, writes are counted but never refused by the quota; (b) fail closed for everything (a D1 hiccup stops all reads); (c) fail open, and refuse writes over the quota too.
- **Recommendation:** (a), built. `whoami` and the panel show `unknown` rather than "unlimited". A write the person approved should not be lost to a read quota, and the write limiter plus approval already bound writes.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-250 — A refused quota is a tool error, not an HTTP 429 *(P8-09)*
- **Context:** Rate limits answer HTTP 429 with `Retry-After`; a day-long quota would make a client back off for hours and, for some, treat the whole server as down.
- **Options:** (a) a tool-error result with `AB_LIMIT_QUOTA`, the period, the limit, the use and the UTC reset, raised inside the Agility client; (b) HTTP 429 with a `Retry-After` of hours; (c) a protocol error.
- **Recommendation:** (a), built; the agent reads the reason and the reset instant, and tools that need no request keep working.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-251 — No quota on stdio *(P8-09)*
- **Context:** stdio has one process, one token, no grants and no shared store; the per-call budget and the Agility instance's own quota apply.
- **Options:** (a) remote hosts only; (b) an in-process counter per process (resets on restart, so a weak promise).
- **Recommendation:** (a), built; documented in the guide.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-252 — A task runs inside the poll that claims it *(P8-10)*
- **Context:** Workers must not do work after a response, and the SDK has no Tasks runtime, so there is nowhere to run a report "in the background".
- **Options:** (a) creation returns the handle at once and the first `tasks/get` runs the stored call through the normal MCP pipeline, claimed by an atomic lease; (b) run the report at creation and store the result (the client's call still blocks until it ends, so no timeout benefit); (c) a Durable Object or queue worker (new Cloudflare resources, not allowed here).
- **Recommendation:** (a), built. The client's `tools/call` returns at once; each poll is a normal request with its own budget, quota and audit. The report must still fit one request.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-253 — Only report tools become tasks *(P8-10)*
- **Context:** The task names long reports and exports; write tools need an approval round trip that a task would complicate (L-411).
- **Options:** (a) tools in the `reports` group, read-only, when the request declares the extension; (b) every read tool; (c) a per-tool flag.
- **Recommendation:** (a), built. The group already marks the expensive composites and is enabled per workspace; other tools answer inline even for a declaring client.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-254 — Authorised per device, grant and workspace; no tasks for pass-through *(P8-10)*
- **Context:** A task handle must not work for another device of the same person, but a pass-through workspace has one shared identity for all callers.
- **Options:** (a) the record binds grant id, workspace id and the device token id; pass-through callers get no tasks; (b) bind the person only; (c) bind the pass-through token fingerprint too.
- **Recommendation:** (a), built; (c) is possible later.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-255 — `tasks/update` always refuses; `input_required` is never produced *(P8-10)*
- **Context:** The extension allows a task to ask for input (elicitation or sampling). Report tools never ask, and write approvals are out of scope (D-253).
- **Options:** (a) refuse `tasks/update` with invalid params and never enter `input_required`; (b) implement input routing for future tools.
- **Recommendation:** (a), built; the status stays in the vocabulary for the day a task tool asks.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-256 — `AB_TASKS` is on by default *(P8-10)*
- **Context:** The extension is only used by requests that declare it, and only for report tools an owner enabled.
- **Options:** (a) on, with `AB_TASKS=off` as the kill switch; (b) off until verified with a real client.
- **Recommendation:** (a), built, as the task asks for a kill switch; it can be flipped to (b) if the live check (P8-15) finds a client problem.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-257 — Which messages answer without a credential on a public catalogue *(P8-11)*
- **Context:** The task lists `initialize`, `server/discover`, `ping` and `tools/list`. A 2025-era client also sends `notifications/initialized` between `initialize` and `tools/list`; a `401` there ends its handshake and makes some clients start sign-in before they have listed anything. Prompts and resources are not tool discovery and their lists depend on the tools a caller has.
- **Options:** (a) the four listed methods plus `notifications/initialized` (no effect, no data), everything else `401`; (b) exactly the four listed (strict; breaks the 2025-era handshake in clients that stop on a `401` notification); (c) also `prompts/list` and `resources/list` (a larger public surface, more per-workspace shape to keep identical).
- **Recommendation:** (a), built. The notification changes nothing and returns nothing; every method that reads data or depends on a grant still needs a credential.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-258 — What the public catalogue lists *(P8-11)*
- **Context:** The catalogue must say nothing per tenant (D-64, D-201). Which tools exist for a caller depends on workspace groups, grants, budgets and the opt-in switches (reports, attachments, writes).
- **Options:** (a) the read-only tools of the default groups, from the registry, the same list an unconfigured stdio server shows; (b) every read-only tool including the opt-in groups (tells a registry the full capability, but also that those groups exist on every deployment, true or not); (c) a hand-written static document (can drift from the registry).
- **Recommendation:** (a), built, with the group list shared by stdio and HTTP (`PUBLIC_CATALOG_GROUPS`) and a test that pins them equal. A deployment that enables reports or attachments does not show it anonymously, so the list cannot reveal a configuration choice.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-259 — Which tool links which MCP Apps view *(P8-03)*
- **Context:** A tool names one view (`_meta.ui.resourceUri`). The architecture says the two views are linked from `get_sprint` and `sprint_health`, but only `get_sprint` returns a burndown and `byStatusCategory`; `sprint_health` returned neither.
- **Options:** (a) `get_sprint` shows the burndown and `sprint_health` shows the status distribution, and `sprint_health` returns the sprint's `byStatusCategory` (additive, our own codes and numbers); (b) one combined view on `get_sprint` only; (c) a new tool per chart.
- **Recommendation:** (a), built. Each view has one job and one data shape; the report gets a small additive field. (b) leaves the report without a chart, (c) adds tools for a presentation concern.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-260 — Apps are on by default, with a kill switch *(P8-03)*
- **Context:** The task asks for an `AB_MCP_APPS=off` switch. A view reaches only a client that declared the extension, is static, makes no request and carries a strict policy.
- **Options:** (a) on by default, `AB_MCP_APPS=off` turns it off everywhere; (b) off by default, opt in per deployment.
- **Recommendation:** (a), built. Nothing is offered to a client that did not ask, and the text result is unchanged. Choose (b) if you want no HTML served at all unless an operator enabled it.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-261 — Which connections are offered Apps *(P8-03)*
- **Context:** Capabilities are known per request on 2026-07-28, after `initialize` on a stateful 2025-era connection (stdio), and not at all on a 2025-era stateless HTTP request (P0-07). A 2026-07-28 client over stdio never sends `initialize`.
- **Options:** (a) offer where the capability is known (2026-07-28 HTTP, 2025-era stdio) and never guess; (b) also offer to every 2025-era HTTP request (would advertise a view to clients that did not ask); (c) read the declaration of the `initialize` request and remember it in a signed cookie or token (new state for a cosmetic feature).
- **Recommendation:** (a), built. A 2026-07-28 client over stdio is a follow-up when the SDK exposes its per-request envelope to the stdio factory.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-262 — Dependency-free views checked by a fake DOM and a real browser by hand *(P8-03)*
- **Context:** The views must run without a library, so a test needs a DOM. jsdom is a new development dependency; a browser suite needs the e2e workflow.
- **Options:** (a) a minimal fake DOM in the unit test (it records every text and attribute, and fails on any API the script should not use) plus a by-hand run in headless Chromium in a sandboxed frame; (b) add jsdom; (c) add a Playwright spec to the admin E2E workflow.
- **Recommendation:** (a), built. It pins exactly what the script may touch and adds no dependency; (c) is a possible later step once a real client run exists (P8-19).
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-263 — Three fault classes, and which ones mark a span as an error *(P8-07)*
- **Context:** L-118 says only server faults count toward the service error rate. Agility failing (down, slow, throttling) is not a caller fault, and it is not a bug of this server either, but users of the deployment see failures.
- **Options:** (a) `caller`, `upstream`, `server`; the span status is `ERROR` for `server` and `upstream`, and the attribute splits them; (b) two classes, with Agility failures counted as `server`; (c) `ERROR` for `server` only, so an Agility outage never trips an error-rate alert.
- **Recommendation:** (a), built. The error rate shows every failure users feel, and a dashboard can still separate whose it is. (c) hides an outage; (b) pages the wrong people.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-264 — One span per MCP request, ended with the exchange *(P8-07)*
- **Context:** A tool call answers over a stream that is returned before the tool has run (L-426), and the audit already records tool calls separately.
- **Options:** (a) one `SERVER` span per request, emitted when the response stream ends, carrying the tool's outcome; (b) a request span at the headers and a child span per tool call; (c) only tool calls.
- **Recommendation:** (a), built. One span is one request, its duration is the user's wait, and (b) would double the volume for no extra attribute we are allowed to send. (c) would miss every other method (L-015).
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-265 — OTLP/JSON by our own encoder, traces only *(P8-07)*
- **Context:** The OpenTelemetry JavaScript SDK is large, uses Node APIs and context propagation we must not enable (it would forward trace headers to every outgoing request, Agility's included).
- **Options:** (a) a small OTLP/HTTP JSON encoder and one `fetch`, spans only; the backend derives metrics from spans (`spanmetrics`); (b) the official SDK with an exporter; (c) also OTLP metrics and logs.
- **Recommendation:** (a), built. No dependency, runs on Workers and Node alike, and nothing can instrument the Agility client by accident. Metrics from spans give the error rate and latency that were asked for; logs stay on stderr, redacted.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-266 — Trace context only from authenticated callers *(P8-07)*
- **Context:** `traceparent` is caller input. An anonymous caller could write chosen trace ids into the operator's data, or use it to probe.
- **Options:** (a) join the caller's trace only on an authenticated request and only if the header is strictly valid; `tracestate` and `baggage` never read; (b) join whenever the header is valid; (c) never join, always start a trace.
- **Recommendation:** (a), built. A client of the deployment can link its trace to ours; a stranger cannot. (c) loses a useful feature for the people the server is for.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-267 — No workspace, person or address on a span, not even an opaque id *(P8-07)*
- **Context:** Per-workspace dashboards are the obvious next ask. T30 says no ids of members or tokens; a workspace id is not a member id, but it is a tenant label, high in cardinality on a large deployment, and the audit log already holds it.
- **Options:** (a) none; the `agility_bridge.request_id` joins a span to its audit row; (b) the workspace id behind a switch (`AB_OTEL_WORKSPACE_ATTRIBUTE=on`); (c) always.
- **Recommendation:** (a), built. The list stays short enough to read and to prove; (b) is a later, separate decision if operators ask.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-268 — HTTP hosts only; stdio is not instrumented *(P8-07)*
- **Context:** stdio is one local process for one person with no collector in sight; the spans' value is in shared deployments.
- **Options:** (a) `serve` and the Worker; stdio as a follow-up task if anyone asks; (b) stdio too, through the same function.
- **Recommendation:** (a), built; the follow-up is [P8-20](../tasks/phase-8-power-features/P8-20-stdio-telemetry.md).
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-269 — The collector's key is an environment secret, one attempt, no redirect *(P8-07)*
- **Context:** A hosted collector wants an API key. It is a credential this server holds.
- **Options:** (a) `AB_OTEL_HEADERS` in the environment (Worker: a secret), validated without echo, never logged, sent only to the endpoint, no redirect followed, one attempt with a 3 s timeout; (b) a file setting like the master key; (c) store it encrypted in the database.
- **Recommendation:** (a), built. It matches how the Worker's other secrets arrive and adds no storage. (b) and (c) are possible when an operator needs them.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-272 — The reference is `keychain:<name>` as a whole value, with the YAML form kept *(P8-08)*
- **Context:** The YAML file already accepted `${keychain:service/account}` (P1-11). The task asks for `keychain:<name>` references for stdio and `serve`, where the secret is an environment value in a client's `env` block, not a YAML string.
- **Options:** (a) a value that is exactly `keychain:<name>` (service `agility-bridge`) or `keychain:<service>/<account>` is resolved for `AB_AGILITY_TOKEN`, `AB_MASTER_KEY` and `AB_MASTER_KEY_PREVIOUS`; the YAML `${keychain:…}` also takes the bare name; (b) a separate variable per secret (`AB_AGILITY_TOKEN_KEYCHAIN=name`; more names to document and to refuse together); (c) expand `${keychain:…}` inside every environment value (a client's own `${…}` expansion could meet it first).
- **Recommendation:** (a), built. One syntax in both places, nothing to expand inside values, and a value that is not a reference is used as it is. A missing entry stops startup naming the reference, never falling back to the text.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-273 — The Windows backend is PowerShell over the Credential Manager API, unverified on a real machine *(P8-08)*
- **Context:** Windows has no stock command that reads a stored password. `cmdkey` can add one but puts it in argv (L-103 forbids it) and cannot read it back.
- **Options:** (a) `powershell.exe` with a small script compiled by `Add-Type` that calls `CredRead`/`CredWrite`/`CredDelete`; the script travels in `-EncodedCommand`, the operation and target in the child's environment, the secret on standard input; generic credential, local-machine persistence; (b) the WinRT `PasswordVault` (Windows PowerShell 5.1 only, and entries show as web credentials); (c) no Windows support (use `${ENV}`).
- **Recommendation:** (a), built, with every call covered by a fake and the script's contract tested; the script itself has not run on Windows (no Windows machine in this batch), so the manual verification item stays open. CI's Windows job runs the fakes only.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-274 — Names are restricted for writing, and a stored secret is read back *(P8-08)*
- **Context:** `security -i` takes a command line on standard input with its own quoting, and exits 0 even when the command failed; `secret-tool store` can also succeed without a usable store (no D-Bus is reported as an error, a locked keyring may not be).
- **Options:** (a) service and account for writes are 1 to 100 characters of letters, digits and `. _ @ -`; the macOS secret travels as hex (`-X`); every write is followed by a read that must return the same secret, else an error; reads keep the old looser rule so existing references work; (b) quote and escape for each tool; (c) trust exit codes.
- **Recommendation:** (a), built. Nothing needs quoting, and a write that did not take effect is an error instead of a token that is later "not found".
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-275 — Keychain commands, and a master key straight into the keychain *(P8-08)*
- **Context:** A reference is of no use until the secret is stored; asking people to run `security` or `secret-tool` by hand per OS defeats the purpose.
- **Options:** (a) `keychain set|delete|status` (secret from file, `AB_KEYCHAIN_SECRET`, standard input or a hidden prompt, never a flag) and `init --keychain <name>` (generates the master key into the keychain; refuses to replace an entry; says the keychain is not a backup); (b) documentation of the OS commands only; (c) `keychain get` as well (prints a secret: not offered).
- **Recommendation:** (a), built. `status --name` answers only whether an entry exists.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-276 — Import and export are composed on the admin API, client side *(P8-05)*
- **Context:** L-065: every alternate writer is an authorization boundary. An import could write the database directly, or ask the server for an import endpoint, or drive the existing admin API one record at a time.
- **Options:** (a) the CLI reads the lists and posts creations through the admin API (local in process, or remote with the admin token): validation, owner guards and audit rows are the ones every other command gets, and a remote deployment (a Worker too) works; (b) a new server endpoint `POST /config/import` (one more writer to guard and to document, and a large body for the API to cap); (c) write the storage directly (bypasses every guard).
- **Recommendation:** (a), built. Export of tokens is the exception: only the local database and master key can decrypt a token, so `--with-tokens` is local-only and writes an audit row.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-277 — What an export carries, and what an import may do *(P8-05)*
- **Context:** L-078 asks that what moves and what does not be defined. People, their grants and personal credentials belong to the target's sign-in; a personal credential must never be assigned to anyone else (T29).
- **Options:** (a) instances (without TLS file paths), shared credentials, workspaces and service grants; import only creates, matches on instance address, shared credential label and workspace slug, never updates or deletes, and adds grants only to workspaces it creates itself (a file never opens a new way into what exists); a personal credential with the same label is skipped, never used; a workspace that enables writes or pass-through needs `--allow-sensitive`; (b) also users and people's grants (needs the target to hold the same sign-in identities; a grant could then name a user the importer does not control); (c) update existing records to match the file (can widen a workspace).
- **Recommendation:** (a), built. A file cannot widen what exists, name a person or an owner (the reader is strict), or carry a token in the clear.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-278 — Import is a dry run unless `--apply` *(P8-05)*
- **Context:** The task asks for an additive import with a dry run. A default that writes is quicker, one that plans is safer: the file may come from somewhere else.
- **Options:** (a) the plan by default, `--apply` to write (a second explicit word for the one risky step); (b) write by default and `--dry-run` to plan; (c) always ask interactively (not scriptable).
- **Recommendation:** (a), built. The plan names every item as create, exists, skip (with the reason) or failed.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-279 — The passphrase seal binds its own header, and the cost is fixed *(P8-05)*
- **Context:** The task fixes PBKDF2-HMAC-SHA-256 at 600,000 iterations and AES-256-GCM. A file that names its own cost would let a crafted file cost minutes of CPU or choose a weak setting.
- **Options:** (a) the algorithm and the cost are constants: a file naming anything else is refused before deriving a key; the header (format, version, KDF, cost) is the AES-GCM additional data, so editing it fails the open; a wrong passphrase and a changed file give the same message; a passphrase is 12 to 1,024 characters; (b) honour the file's cost within a range; (c) scrypt or Argon2id (not what the task says, and not in Web Crypto).
- **Recommendation:** (a), built.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-280 — One generator for every client snippet, link and the plugin's `.mcp.json` *(P8-06)*
- **Context:** The same stdio entry is written for six clients, the docs, a plugin and install links. Hand-written copies drift (L-027 shows how an upgrade changes what clients expect).
- **Options:** (a) `apps/cli/src/client-snippets.ts` builds them all; the `client-config` command prints them; the plugin's `.mcp.json` is generated by an import-free module the release script also runs; tests compare the committed files with the output; (b) hand-written files and a checklist; (c) a templating script that writes docs.
- **Recommendation:** (a), built. No snippet holds a token: a prompt (VS Code), a variable or `userConfig` the client expands (plugin), a placeholder (Cursor link) or a `keychain:<name>` reference (P8-08).
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-281 — The plugin and its marketplace file live in this repository, pinned to the package version *(P8-06)*
- **Context:** A Claude Code plugin can be listed by a marketplace file in any repository; publishing to Anthropic's directory or another marketplace is an owner step.
- **Options:** (a) `plugins/agility-bridge` plus `.claude-plugin/marketplace.json` at the root (`/plugin marketplace add mhidalgo-lab/agility-bridge` works once pushed), the plugin starting `npx -y agility-bridge@<its version>`, the version synced by `release.ts sync-version`; (b) an unpinned `npx -y agility-bridge` (a plugin update would not change what runs); (c) a separate plugin repository (two repositories to keep in step).
- **Recommendation:** (a), built. A plugin update and a package update are one event, and the pin makes "which server does this plugin run" answerable. Listing in Anthropic's directory or any marketplace is not done (owner).
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-282 — The plugin's settings are `userConfig`, with the token marked sensitive; commands are read-only *(P8-06)*
- **Context:** The plugin needs the instance address and a token. Claude Code stores `sensitive` options in the system credential store and substitutes `${user_config.KEY}` in the MCP entry; the plugin may not hold a secret in a file.
- **Options:** (a) `agility_url` and a `sensitive` `agility_token` as `userConfig`; four read-only commands (my work, find item, sprint status, standup) and two skills (workflows; conduct: untrusted data, scope, secrets, approvals), every command repeating the untrusted-data rule; (b) ask the user to export variables (not reliable for a GUI-started client, L-026); (c) commands that write (ADR-0013: writes stay opt-in and approved, so no command encourages them).
- **Recommendation:** (a), built. The plugin has not been installed in a real Claude Code in this batch (*unverified*; owner step), nor validated with `claude plugin validate` (the tests encode its documented rules).
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-287 — The config bundle authenticates where each token may go *(P8-12, S-1)*
- **Context:** Only the `secrets` block was sealed; `instances[].baseUrl` and the credential-to-instance map sat outside the authenticated data, so someone editing the file could point a decrypted token at another host (the import validates the credential against the instance URL), and the plan showed instance labels only.
- **Options:** (a) put the canonical instance addresses and the credential-to-instance map into the AES-GCM additional data, bump the file version to 2, print addresses in the plan; (b) encrypt `{token, baseUrl}` per credential; (c) a detached signature.
- **Recommendation:** (a), built. Cheapest, no second key, and the same one-message refusal. Version 1 files that carry tokens are refused (re-export them); token-less files only need `version: 2`.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-288 — `config import --add-grants` finishes a partly failed import *(P8-12, Q-3)*
- **Context:** Import never adds grants to an existing workspace, so a run that created a workspace and then failed on a grant could not be completed by import.
- **Options:** (a) an explicit flag, off by default: grants the file has and the existing workspace lacks (by label, not revoked) are created through the admin API; (b) always add missing grants; (c) document a manual recovery only.
- **Recommendation:** (a), built, plus a recovery line on stderr when a run fails or leaves a workspace without its default credential. A file still never opens a new way into what exists unasked.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-289 — `doctor --fix` repairs only directories it would have chosen; foreign text is sanitised *(P8-12, S-6)*
- **Context:** `--fix` did `chmod 0700` on the directory of `AB_DB_PATH`, which can be a group-shared directory; server names from a project's `.mcp.json` were printed raw; a FIFO named `.mcp.json` blocked the open.
- **Options:** (a) the data-directory fix only without `AB_DB_PATH` (reported with the command otherwise), control characters replaced by `?` in every finding, `O_NONBLOCK` open plus `fstat`; (b) drop directory repairs; (c) ask per path.
- **Recommendation:** (a), built.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-290 — Environment keychain references read the `agility-bridge` service only *(P8-12, S-2)*
- **Context:** A project's `.mcp.json` can set `AB_AGILITY_TOKEN=keychain:<service>/<account>` and so make the server read another application's entry.
- **Options:** (a) refuse non-default services in environment values (`AB_AGILITY_TOKEN`, `AB_MASTER_KEY*`), allow them in the user's own YAML file; (b) an allowlist variable (also settable by the same hostile file, so no protection); (c) bind each entry to an instance host.
- **Recommendation:** (a), built. It protects other applications' secrets. It does not stop a hostile file from sending the user's own `agility-bridge` entry to another host: that needs (c), filed as P8-31.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-291 — The stdio server warns about settings only remote hosts read *(P8-12, Q-7)*
- **Context:** `AB_QUOTA_*`, `AB_OTEL_*`, `AB_TASKS`, `AB_QUERY_CACHE_EDGE` and `AB_PUBLIC_TOOL_CATALOG` are valid names that stdio ignores, so a cost control could silently do nothing.
- **Options:** (a) a stderr warning naming them when stdio starts configured; (b) refuse them (breaks shared env blocks); (c) implement them for stdio (P8-20 covers telemetry).
- **Recommendation:** (a), built. The warning is not raised for a shell with no Agility configuration (doctor, management commands).
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-292 — Keychain availability is a probe; `doctor --offline` skips keychain references *(P8-12, Q-8)*
- **Context:** `available()` only checked that the tool started, and `secret-tool` has no documented `--version`; doctor resolved `keychain:` references even with `--offline`.
- **Options:** (a) probe with a lookup of a random attribute (Linux: exit 1 with no message means a reachable store) and require exit 0 for the other tools; doctor skips keychain reads under `--offline` and reports the checks as skipped; (b) leave it.
- **Recommendation:** (a), built.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-293 — The Windows keychain script pins UTF-8 and refuses non-ASCII secrets for now *(P8-12, Q-9)*
- **Context:** The PowerShell script read and wrote through the console's OEM code page, and the read-back used the same path, so a mangled secret verified. The script has never run on Windows (D-273).
- **Options:** (a) set `[Console]::InputEncoding` and `OutputEncoding` to UTF-8 without BOM, and refuse non-ASCII secrets until a real run proves it (P8-32); (b) only the encoding; (c) only the refusal.
- **Recommendation:** (a), built. Access tokens and master keys are ASCII, so nothing is lost.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-295 — Accounting work finishes after the response on Workers *(P8-12 (P-2))*
- **Context:** The quota counters' write (two D1 upserts) and the query cache's shared-tier store (seal, `cache.put`, first read-back) sat on the request's critical path: up to three D1 round trips plus the cache operations of added latency per read call.
- **Options:** (a) hand both to the host's `background` hook (`waitUntil`) where it has one, and await them where it has none (Node, stdio); (b) keep them inline; (c) drop the shared tier's read-back.
- **Recommendation:** (a), built, through an optional `ToolContext.background` set only by a host that has the hook. Only work that proves nothing and is not needed to decide the answer moves: the quota read that decides a refusal, authorization, the budget, audit intent and the write limiter stay on the request path. Cost: on Workers the next request in the first moments after another may read the old counter (the counters were already approximate and fail open, D-249). The memory tier is still filled before the answer returns.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-296 — The quota is a soft cap: document the overshoot bound, no per-call reservation *(P8-12 (S-5))*
- **Context:** Parallel requests of one grant each read the counters once and each may spend up to its own call budget before any of them writes, so the quota can be overshot.
- **Options:** (a) document the bound (requests in flight of one grant times the call budget) and keep one read and one write per request; (b) reserve units atomically with `kv.increment(max)` per call or per batch, a D1 write for every Agility request; (c) reserve a batch of units at the first call.
- **Recommendation:** (a), built. A hard cap costs the D1 rows the design exists to save (L-415, 100,000 a day on Free) and the quota is a cost control that already fails open (D-249). (c) stays possible if an owner needs a hard cap, with a larger overshoot than the saving is worth on Free.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-297 — Shared-tier entries carry the time Agility was asked *(P8-12 (Q-1))*
- **Context:** A copy promoted from the shared tier into an isolate's memory restarted the TTL, so an answer could be served up to twice the TTL (120 s at the 60 s maximum) after it was read, against a guide that promises one TTL.
- **Options:** (a) store the write time in front of the text inside the sealed body (`<ms>:<text>`) and give the promoted copy the remaining life; (b) do not promote shared-tier hits to memory; (c) read the Cache API `Age` header.
- **Recommendation:** (a), built in the cache itself, so every tier implementation keeps one rule and the body stays authenticated (the time is inside the sealed text, bound to the entry id). A time in the future (clock skew between isolates) is clamped to now; an entry without a readable time is a miss. (b) loses the memory saving; (c) depends on a header a no-op or foreign cache may not set.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-298 — The query cache is bypassed by the caller's own write tools, not by the workspace *(P8-12 (Q-11))*
- **Context:** The bypass was keyed on `workspace.writes.enabled`, so a read-only grant in a writing workspace lost the cache (and `whoami`'s block) while the text promised that only a caller with write tools bypasses it.
- **Options:** (a) key it on the caller's write runtime (`ctx.writes`, present only when the server switch and this caller's write tools hold); (b) keep the workspace rule and fix the text.
- **Recommendation:** (a), built. The write layer's reads still pass `fresh`, and a writing caller never reads or fills the cache. Residual, documented: a read-only grant next to a writing one can show up to one TTL of data from before the other grant's write.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-299 — The quota is asked before the call budget is spent *(P8-12 (Q-4))*
- **Context:** `#send` spent a budget unit and then the quota refused the call, so the audit row, the log and the span claimed a request that never reached Agility.
- **Options:** (a) ask the quota first (an exhausted budget is refused before it, so no quota unit is counted for a call that cannot happen) and spend the unit after; (b) refund the unit on refusal.
- **Recommendation:** (a), built; there is no refund path to get wrong.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-300 — A task poll has the request deadline; failures release the lease *(P8-12 (Q-2, P-5))*
- **Context:** The poll that ran a report was outside the deadline race, and a thrown runner, an abandoned poll or a result that could not be saved left the lease for 200 s and then reran the report.
- **Options:** (a) race the run against the request deadline and turn a late, thrown or unsaveable run into a stored `failed` task, release the lease in `finally`; (b) return `working` at once and run in `waitUntil`; (c) a Durable Object or queue.
- **Recommendation:** (a), built. (b) cannot work for a report longer than Workers' post-response budget; (c) needs Cloudflare resources the owner has not allowed ([P8-36](../tasks/phase-8-power-features/P8-36-background-task-runner.md)). The residual is documented: a client that drops the poll can leave the task `working` until the lease ends, after which the next poll runs the report once more.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-301 — A cancel is a marker the finishing poll checks *(P8-12 (Q-5))*
- **Context:** Cancel and completion each read, changed and saved the record, so a cancel acknowledged to the client could be overwritten by the result.
- **Options:** (a) the cancel stores a marker first, then marks the record; the finishing poll saves its result and then checks the marker and rewrites `cancelled`; (b) a conditional write on the record (the `kv` has no compare-and-set on the value).
- **Recommendation:** (a), built: both orders end `cancelled`, at the cost of one extra read in the finishing poll and one extra write in a cancel.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-302 — A task is validated and bounded at creation; a finished result needs the same scope *(P8-12 (S-3, S-4))*
- **Context:** Creation stored arguments unchecked (up to the 1 MiB body), without a cap per grant, and a finished result was returned after the grant lost the tool or was narrowed.
- **Options:** (a) arguments must be an object of at most 8 KiB valid for the tool's schema; 30 creations per grant per 15-minute window through an atomic capped counter; a result is returned only while the tool is still granted and a digest of projects, asset types and limits equals the one stored when it ran; (b) also write an audit row at creation; (c) count creation against the per-grant quota.
- **Recommendation:** (a), built. Creation asks Agility nothing, so it takes no quota unit, and the report's own audit and quota apply when it runs (b and c would double count). Narrowing or widening limits both invalidate a stored result: simple and safe, at the price of a re-run after an admin change.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-303 — A result too large to keep ends the task as failed *(P8-12 (P-5))*
- **Context:** A report result above about 190 KB made the save throw after the report ran.
- **Options:** (a) a result above 150,000 characters (checked before sealing, which also saves CPU) or that fails to save becomes a short `failed` record; (b) truncate; (c) chunk across `kv` values.
- **Recommendation:** (a), built; truncating would hand a client a partial report that looks complete (L-033).
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-304 — Spans of requests that never authenticated are sampled *(P8-12 (P-3, S-8))*
- **Context:** Every 401, 429 and public-catalogue request produced a span and, on Workers, an outgoing OTLP request, so anyone who can reach the server set the volume of the collector's bill and of subrequests.
- **Options:** (a) at most 30 such spans a minute per process or isolate, the rest counted in `stats().sampledOut`; (b) never record them; (c) batch on Workers.
- **Recommendation:** (a), built: refusals stay visible to the operator and the amplification is bounded; authenticated spans are never sampled. (c) stays for [P8-35](../tasks/phase-8-power-features/P8-35-catalogue-cache-single-flight.md).
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-305 — Telemetry endpoint, caller trace ids and the view's `postMessage` target stay as built; the public catalogue advertises no extension *(P8-12 (S-8, S-9, S-10))*
- **Context:** Three low observations: `AB_OTEL_ENDPOINT` has no public-address rule unlike other egress; a caller's `traceparent` trace id is adopted; the MCP Apps view posts to `'*'`; the anonymous `server/discover` listed the Tasks extension.
- **Options:** (a) document the first three (operator-chosen collector, harmless trace id, the host's origin cannot be known) and stop advertising extensions to anonymous callers; (b) apply `checkPublicHost` to the endpoint unless private addresses are allowed; (c) pin a target origin.
- **Recommendation:** (a), built. An internal collector is a legitimate target and the endpoint is operator configuration, not caller input; (c) is impossible for a sandboxed frame. The catalogue fix is a plain defect fix: the anonymous prepared request carries no extensions.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-306 — The host an entry is for lives in a sibling keychain entry `<account>#host` *(P8-31, S-2)*
- **Context:** A project's `.mcp.json` can set `AB_AGILITY_URL` to another host while `AB_AGILITY_TOKEN=keychain:<name>` names the user's own entry (D-290 only protects other applications' entries). The binding has to work with the macOS `security`, Linux `secret-tool` and Windows Credential Manager backends without a secret on argv.
- **Options:** (a) a sibling entry in the same service whose account is `<account>#host` and whose value is the canonical host (lower case, with a non-default port); (b) an attribute on the entry (`secret-tool` has free attributes, `security` has a comment field, Credential Manager has a comment, each needing its own code and read path); (c) one index entry holding every binding as JSON (a read-modify-write of a shared value).
- **Recommendation:** (a), built. It needs only the `get`, `set` and `delete` every backend has, carries no secret, and `#` is outside the writable-name alphabet (D-274), so no secret can be stored under the binding's name through the commands. The host is the part of the instance address a token travels to; the path is not part of the binding.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-307 — A different host is refused at startup; only `keychain bind` confirms it *(P8-31)*
- **Context:** When the resolved keychain token is used with an `AB_AGILITY_URL` whose host differs from the stored one, the server could warn, refuse, or accept an explicit confirmation.
- **Options:** (a) refuse before the token is used, with a stderr message naming both hosts and the command that confirms it; the confirmation is `agility-bridge keychain bind <name> --for-url <url>`, run by the person; (b) refuse unless an environment variable (`AB_KEYCHAIN_ALLOW_HOST`) names the host; (c) warn only.
- **Recommendation:** (a), built. The hostile file that redirects the URL can set any environment variable too, so (b) is no protection and (c) sends the token anyway. `bind` replaces the stored host and is the same command that migrates old entries; it is a deliberate keychain write that a client's env block cannot trigger. Hosts compare case-insensitively and a different port is a different host.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-308 — Entries stored without a host keep working with a warning, for now *(P8-31)*
- **Context:** Entries made by v0.7.0 and earlier have no host. Refusing them would break every existing setup at the next upgrade; accepting them silently leaves the hole open for them.
- **Options:** (a) accept with a stderr warning (and a `doctor` warning) that names `keychain bind <name> --for-url <url>`; refuse them in a later minor release (follow-up P8-41); (b) refuse at once; (c) bind on first use (trust on first use: a hostile file used first would bind the entry to its host).
- **Recommendation:** (a), built. It closes the hole for every entry stored with `--for-url` or bound once, and tells everyone else how to close it; (c) is rejected because the first use is not necessarily the person's. The warning is the only protection of an unbound entry until P8-41.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-309 — Where the host is recorded and reported: `keychain set --for-url`, `keychain bind`, `status`, `doctor`, `client-config` *(P8-31)*
- **Context:** The host has to be recorded when a token is stored, shown without a secret, and reported by diagnostics. `init --keychain` stores a master key, which belongs to a server and not to an Agility instance.
- **Options:** (a) `keychain set <name> --for-url <url>` writes the secret and the binding (replacing a secret without the flag keeps the existing binding); `keychain bind <name> --for-url <url>` binds or moves an existing entry; `keychain delete` removes both; `keychain status --name` prints `boundTo`; `doctor` reports `ok` for a bound token, `warn` for an unbound one and `fail` for a different host; `client-config` snippets print `--for-url` with their `keychain set` hint; `init --keychain` and the master-key references are not bound; (b) bind through `init --keychain` too; (c) bind in the YAML file only.
- **Recommendation:** (a), built. The binding applies to the stdio environment path (`AB_AGILITY_TOKEN`), the one a project file can reach. A `${keychain:...}` inside the user's own YAML file is not checked (the file is the user's; follow-up P8-42).
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-310 — The public catalogue keeps its three answers keyed on everything the answer could echo, with only the id substituted *(P8-35 (P-8))*
- **Context:** The anonymous `tools/list` (about 38 KB), `initialize` and `server/discover` were rebuilt, serialised and, on a cold path, the SDK server built again for every request, bounded only by the per-address limiter.
- **Options:** (a) keep the serialised bytes in a bounded table inside the app (an isolate on Workers), keyed on the method, the `accept` and MCP routing headers and the request's `params`, and substitute only the JSON-RPC `id` (strings and safe integers; anything else is answered the normal way); (b) key on method and protocol version only; (c) cache the tool list but still run the SDK handler.
- **Recommendation:** (a), built. (b) would serve one client's `initialize` negotiation to another that asked for a different version, and (c) keeps most of the cost. The table is bounded (16 entries, 128 KB each, oldest first), holds no storage, workspace, grant or credential data, and a test compares every kept answer with a never-cached world's for several ids, workspace names and both protocol eras. No `Cache-Control`: a POST answer is not cacheable by browsers or the Cache API. Requests are counted apart as `catalog: 'built' | 'cached'` on the request event.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-311 — Single flight is per request context; nothing is shared across requests *(P8-35 (P-10))*
- **Context:** The call budget allows six reads in parallel and identical misses each went to Agility. Workers forbid using a promise (an I/O object) created in another request.
- **Options:** (a) a table of pending reads in a `WeakMap` keyed by the request's `ToolContext`, so identical concurrent misses inside one request send one request and each caller gets a `structuredClone` of the answer; (b) also share across requests on Node only; (c) a documented cross-request limit on Workers.
- **Recommendation:** (a), built; it is the only form that is correct on both hosts and it cannot cross a scope (the entry id binds every dimension and the table dies with the context). A failure is every joined caller's failure and the next read tries again. A joined caller spends no budget unit and no quota unit, like a hit. The cross-request limit is documented in the query-cache guide: two requests that miss at once each ask Agility. Expired entries are also dropped anywhere in the map on every store (they used to hide behind a live head).
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-312 — OTLP span batching is not built here; it becomes its own task *(P8-35 (P-3))*
- **Context:** P8-35 listed batching of spans per isolate on Workers, with a flush through `waitUntil`, as optional, to be done only if small and well tested on both hosts.
- **Options:** (a) leave it for [P8-43](../tasks/phase-8-power-features/P8-43-batch-otlp-spans-on-workers.md); (b) build a per-isolate queue now.
- **Recommendation:** (a). A per-isolate queue is state that outlives a request and needs a size and age flush, a flush racing `waitUntil`, and a decision about spans lost when an isolate is evicted; none of it is small, and D-304 already bounds the unauthenticated volume. The change that matters (the per-request flush) is unchanged.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-313 — The shared tier takes entries up to 64 KiB, as an option of the tier *(P8-38)*
- **Context:** The shared tier stored anything the memory tier accepted (256 KiB); sealing and opening cost CPU in proportion to size on a Free plan with 10 ms.
- **Options:** (a) a cap of 64 KiB of text, an option (`maxEntryChars`) of `EdgeQueryTier` that the `SharedTier` interface exposes, checked by the cache before handing over and by the tier itself, with `whoami` showing it as `queryCache.sharedMaxEntryChars`; (b) 32 KiB; (c) an environment setting; (d) no cap, only the native base64.
- **Recommendation:** (a), built. With the runtime's base64 a 64 KiB seal and open cost about 0.5 ms together on local workerd, and 256 KiB about 2.5 ms, so the cap is conservative for Paid and fair for Free (a 100 KB answer is already a large page of rows). Bigger answers stay in memory only. A setting is not worth an operator decision until the deployed measurement (P8-13) shows a need.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-314 — Use the runtime's base64 where it exists; keep the double parse *(P8-38)*
- **Context:** The byte loop for base64 was most of the cost of a seal on workerd, and the review asked about the extra JSON parse of a hit.
- **Options:** (a) `Uint8Array.prototype.toBase64` and `Uint8Array.fromBase64` when present, the existing loop and `btoa` otherwise; leave the stored format alone; (b) also change the stored format to avoid parsing the sealed wrapper.
- **Recommendation:** (a), built. Measured on local workerd the wrapper parse is 0.01 to 0.3 ms from 8 to 256 KB, so (b) would trade a format change (every entry becomes a miss once) for nothing.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-316 — Metadata requests are not counted by the quota *(P8-39 (Q-10))*
- **Context:** `meta.v1` requests (one to three per cold call, about a dozen on a cold isolate) counted like data queries, so how fast a small quota drained depended on isolate recycling rather than on what the caller asked.
- **Options:** (a) exclude them from the count; (b) count one unit per request however many metadata documents it loaded; (c) keep counting them.
- **Recommendation:** (a), built. A metadata request is still refused when a period is used up (a used-up quota stops every read, and "nothing was asked of Agility" stays true), it is not counted, and the per-call budget still bounds how many one call may make. The tenant's own request quota still sees them; the aim of this quota is the caller's use, and `meta.v1` is cached in D1 on Workers.
- **Owner (2026-10-30):** Decided: exclude metadata from the quota.

### D-317 — One statement adds to both periods, as a new uncapped `kv.incrementMany` *(P8-39 (P-7))*
- **Context:** The meter added to the day and the month counter with two `increment` calls, so a request with a quota cost one read and two writes.
- **Options:** (a) a new `kv.incrementMany(entries)`: one multi-row upsert with the same expiry rules, atomic as one statement, at most 10 distinct keys, uncapped (the quota is a soft cap, D-296); (b) `Promise.all` of two increments (two round trips); (c) a `batch` of two increments in the SQL driver only.
- **Recommendation:** (a), built on all three adapters with a contract test and a statement count in each. `increment` with `max` is unchanged, so the capped atomic counters of the write limiter, tasks and OAuth abuse limits keep their semantics. D-248, D-249, D-295, D-296 and D-299 stay true: still one read and one write per request, fail open, written after the response on Workers, a soft cap, and the quota asked before the budget. Rows written do not fall (two counters are two rows, L-461); statements fall from three to two a request.
- **Owner (2026-10-30):** Decided: as recommended, (a).

### D-318 — Deep links add at most 24,000 characters a result; the base is parsed once *(P8-40 (P-6))*
- **Context:** The server added a `url` to every asset row after the output caps, and each link parsed the pinned base and then the finished link (`new URL` twice), about 3 microseconds a row. A 1,000-row result grew by about 90 KB the caps never saw.
- **Options:** (a) parse the base once per result, build each link by concatenation after the strict OID or number check, prove it stays on the pinned prefix with one strict query pattern instead of a second parse, and stop adding links once they have added 24,000 characters (the default data block cap, about 250 rows), with the one fixed note saying how many rows got none; (b) omit all links above a fixed row count; (c) leave it and document the cost.
- **Recommendation:** (a), built. Every T26 guarantee holds: origin and path are the parsed prefix, identities are matched by the same strict patterns plus a second pattern on the whole query, and a row with its own `url` (a Link asset) is untouched and costs no budget. (b) would drop links a caller can use for rows within the budget; the budget is a number a caller cannot raise, like the output caps.
- **Owner (2026-10-30):** Decided: as recommended, (a).
