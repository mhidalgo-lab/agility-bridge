

### D-263 — Three fault classes, and which ones mark a span as an error *(P8-07)*
- **Context:** L-118 says only server faults count toward the service error rate. Agility failing (down, slow, throttling) is not a caller fault, and it is not a bug of this server either, but users of the deployment see failures.
- **Options:** (a) `caller`, `upstream`, `server`; the span status is `ERROR` for `server` and `upstream`, and the attribute splits them; (b) two classes, with Agility failures counted as `server`; (c) `ERROR` for `server` only, so an Agility outage never trips an error-rate alert.
- **Recommendation:** (a), built. The error rate shows every failure users feel, and a dashboard can still separate whose it is. (c) hides an outage; (b) pages the wrong people.
- **Owner:** *(open; built as (a))*

### D-264 — One span per MCP request, ended with the exchange *(P8-07)*
- **Context:** A tool call answers over a stream that is returned before the tool has run (L-426), and the audit already records tool calls separately.
- **Options:** (a) one `SERVER` span per request, emitted when the response stream ends, carrying the tool's outcome; (b) a request span at the headers and a child span per tool call; (c) only tool calls.
- **Recommendation:** (a), built. One span is one request, its duration is the user's wait, and (b) would double the volume for no extra attribute we are allowed to send. (c) would miss every other method (L-015).
- **Owner:** *(open; built as (a))*

### D-265 — OTLP/JSON by our own encoder, traces only *(P8-07)*
- **Context:** The OpenTelemetry JavaScript SDK is large, uses Node APIs and context propagation we must not enable (it would forward trace headers to every outgoing request, Agility's included).
- **Options:** (a) a small OTLP/HTTP JSON encoder and one `fetch`, spans only; the backend derives metrics from spans (`spanmetrics`); (b) the official SDK with an exporter; (c) also OTLP metrics and logs.
- **Recommendation:** (a), built. No dependency, runs on Workers and Node alike, and nothing can instrument the Agility client by accident. Metrics from spans give the error rate and latency that were asked for; logs stay on stderr, redacted.
- **Owner:** *(open; built as (a))*

### D-266 — Trace context only from authenticated callers *(P8-07)*
- **Context:** `traceparent` is caller input. An anonymous caller could write chosen trace ids into the operator's data, or use it to probe.
- **Options:** (a) join the caller's trace only on an authenticated request and only if the header is strictly valid; `tracestate` and `baggage` never read; (b) join whenever the header is valid; (c) never join, always start a trace.
- **Recommendation:** (a), built. A client of the deployment can link its trace to ours; a stranger cannot. (c) loses a useful feature for the people the server is for.
- **Owner:** *(open; built as (a))*

### D-267 — No workspace, person or address on a span, not even an opaque id *(P8-07)*
- **Context:** Per-workspace dashboards are the obvious next ask. T30 says no ids of members or tokens; a workspace id is not a member id, but it is a tenant label, high in cardinality on a large deployment, and the audit log already holds it.
- **Options:** (a) none; the `agility_bridge.request_id` joins a span to its audit row; (b) the workspace id behind a switch (`AB_OTEL_WORKSPACE_ATTRIBUTE=on`); (c) always.
- **Recommendation:** (a), built. The list stays short enough to read and to prove; (b) is a later, separate decision if operators ask.
- **Owner:** *(open; built as (a))*

### D-268 — HTTP hosts only; stdio is not instrumented *(P8-07)*
- **Context:** stdio is one local process for one person with no collector in sight; the spans' value is in shared deployments.
- **Options:** (a) `serve` and the Worker; stdio as a follow-up task if anyone asks; (b) stdio too, through the same function.
- **Recommendation:** (a), built; the follow-up is [P8-20](../tasks/phase-8-power-features/P8-20-stdio-telemetry.md).
- **Owner:** *(open; built as (a))*

### D-269 — The collector's key is an environment secret, one attempt, no redirect *(P8-07)*
- **Context:** A hosted collector wants an API key. It is a credential this server holds.
- **Options:** (a) `AB_OTEL_HEADERS` in the environment (Worker: a secret), validated without echo, never logged, sent only to the endpoint, no redirect followed, one attempt with a 3 s timeout; (b) a file setting like the master key; (c) store it encrypted in the database.
- **Recommendation:** (a), built. It matches how the Worker's other secrets arrive and adds no storage. (b) and (c) are possible when an operator needs them.
- **Owner:** *(open; built as (a))*

### D-242 — The query cache is off by default, with one TTL for everything *(P8-01)*
- **Context:** A cache that is on by default changes what every deployment's agents see (a read up to the TTL old), and the moving windows of Agility reads (`today`, "last 7 days") make long lifetimes misleading.
- **Options:** (a) off by default; `AB_QUERY_CACHE_TTL` 0-60 s, one value for every entry; (b) on by default at 15 s; (c) a TTL per tool or per query kind.
- **Recommendation:** (a), built. Owners opt in knowingly; a single short ceiling (60 s) is easy to explain and test; per-tool TTLs can follow once real traffic shows which reads repeat.
- **Owner:** *(open; built as (a))*

### D-243 — Where the cache hooks in, and who never uses it *(P8-01)*
- **Context:** Many tools call `AgilityClient.query`; writers must see their own writes (ADR-0013) and a stale pre-read next to an approval would mislead the person approving.
- **Options:** (a) inside `AgilityClient.query`, default on for any context that carries a cache, skipped for callers with write tools and for reads passing `fresh` (the write layer's pre-read does); (b) opt-in per tool call site (safer by default, but every tool must remember); (c) invalidate by generation on every write (works in one process only).
- **Recommendation:** (a), built. One place, keyed from the same context the request runs with, so no call site can forget a scope dimension; (c) would not cover other isolates, so callers with write tools simply do not cache.
- **Owner:** *(open; built as (a))*

### D-244 — The shared tier is a second switch and is skipped for write callers *(P8-01)*
- **Context:** The Workers Cache API is local to a data centre, may be a silent no-op, and its subrequest accounting on the Free plan is unverified (L-098).
- **Options:** (a) separate `AB_QUERY_CACHE_EDGE=on`, sealed bodies, used only after a read-back proved it works, retried after 10 minutes when unavailable; (b) always on with the cache; (c) no shared tier at all.
- **Recommendation:** (a), built. In-memory covers the common burst of repeats in one isolate; the shared tier is an experiment until P8-13 measures it on a deployed Worker.
- **Owner:** *(open; built as (a))*

### D-245 — Pass-through callers are keyed by their token fingerprint *(P8-01)*
- **Context:** Every pass-through caller of a workspace has the same credential id, but each acts with their own Agility token and sees what that member sees.
- **Options:** (a) the principal in the key is `pt:` plus the keyed fingerprint already computed for the identity cache (instance and token, `audit-identity` purpose); (b) never cache pass-through requests; (c) key by the credential id and accept the mix.
- **Recommendation:** (a), built; (c) would show one member's data to another. The token itself never enters the key input as plain text, only its fingerprint, and the whole input is hashed again.
- **Owner:** *(open; built as (a))*

### D-246 — A new `cache-body` key purpose for the shared tier *(P8-01)*
- **Context:** The keyring already reserves `cache-id` (a keyed hash). Sealed bodies need an encryption purpose.
- **Options:** (a) add `KeyPurpose.CacheBody` (AES-GCM, derived with its own label); (b) reuse `Credentials` or `Task` (one key for unrelated data); (c) skip encryption and rely on keyed ids (bodies are Agility data, so no).
- **Recommendation:** (a), built; a key derived for one purpose is useless for another, and the Worker derives it at boot only when the shared tier is on.
- **Owner:** *(open; built as (a))*

### D-259 — Which tool links which MCP Apps view *(P8-03)*
- **Context:** A tool names one view (`_meta.ui.resourceUri`). The architecture says the two views are linked from `get_sprint` and `sprint_health`, but only `get_sprint` returns a burndown and `byStatusCategory`; `sprint_health` returned neither.
- **Options:** (a) `get_sprint` shows the burndown and `sprint_health` shows the status distribution, and `sprint_health` returns the sprint's `byStatusCategory` (additive, our own codes and numbers); (b) one combined view on `get_sprint` only; (c) a new tool per chart.
- **Recommendation:** (a), built. Each view has one job and one data shape; the report gets a small additive field. (b) leaves the report without a chart, (c) adds tools for a presentation concern.
- **Owner:** *(open; built as (a))*

### D-260 — Apps are on by default, with a kill switch *(P8-03)*
- **Context:** The task asks for an `AB_MCP_APPS=off` switch. A view reaches only a client that declared the extension, is static, makes no request and carries a strict policy.
- **Options:** (a) on by default, `AB_MCP_APPS=off` turns it off everywhere; (b) off by default, opt in per deployment.
- **Recommendation:** (a), built. Nothing is offered to a client that did not ask, and the text result is unchanged. Choose (b) if you want no HTML served at all unless an operator enabled it.
- **Owner:** *(open; built as (a))*

### D-261 — Which connections are offered Apps *(P8-03)*
- **Context:** Capabilities are known per request on 2026-07-28, after `initialize` on a stateful 2025-era connection (stdio), and not at all on a 2025-era stateless HTTP request (P0-07). A 2026-07-28 client over stdio never sends `initialize`.
- **Options:** (a) offer where the capability is known (2026-07-28 HTTP, 2025-era stdio) and never guess; (b) also offer to every 2025-era HTTP request (would advertise a view to clients that did not ask); (c) read the declaration of the `initialize` request and remember it in a signed cookie or token (new state for a cosmetic feature).
- **Recommendation:** (a), built. A 2026-07-28 client over stdio is a follow-up when the SDK exposes its per-request envelope to the stdio factory.
- **Owner:** *(open; built as (a))*

### D-262 — Dependency-free views checked by a fake DOM and a real browser by hand *(P8-03)*
- **Context:** The views must run without a library, so a test needs a DOM. jsdom is a new development dependency; a browser suite needs the e2e workflow.
- **Options:** (a) a minimal fake DOM in the unit test (it records every text and attribute, and fails on any API the script should not use) plus a by-hand run in headless Chromium in a sandboxed frame; (b) add jsdom; (c) add a Playwright spec to the admin E2E workflow.
- **Recommendation:** (a), built. It pins exactly what the script may touch and adds no dependency; (c) is a possible later step once a real client run exists (P8-19).

### D-272 — The reference is `keychain:<name>` as a whole value, with the YAML form kept *(P8-08)*
- **Context:** The YAML file already accepted `${keychain:service/account}` (P1-11). The task asks for `keychain:<name>` references for stdio and `serve`, where the secret is an environment value in a client's `env` block, not a YAML string.
- **Options:** (a) a value that is exactly `keychain:<name>` (service `agility-bridge`) or `keychain:<service>/<account>` is resolved for `AB_AGILITY_TOKEN`, `AB_MASTER_KEY` and `AB_MASTER_KEY_PREVIOUS`; the YAML `${keychain:…}` also takes the bare name; (b) a separate variable per secret (`AB_AGILITY_TOKEN_KEYCHAIN=name`; more names to document and to refuse together); (c) expand `${keychain:…}` inside every environment value (a client's own `${…}` expansion could meet it first).
- **Recommendation:** (a), built. One syntax in both places, nothing to expand inside values, and a value that is not a reference is used as it is. A missing entry stops startup naming the reference, never falling back to the text.
- **Owner:** *(open; built as (a))*

### D-273 — The Windows backend is PowerShell over the Credential Manager API, unverified on a real machine *(P8-08)*
- **Context:** Windows has no stock command that reads a stored password. `cmdkey` can add one but puts it in argv (L-103 forbids it) and cannot read it back.
- **Options:** (a) `powershell.exe` with a small script compiled by `Add-Type` that calls `CredRead`/`CredWrite`/`CredDelete`; the script travels in `-EncodedCommand`, the operation and target in the child's environment, the secret on standard input; generic credential, local-machine persistence; (b) the WinRT `PasswordVault` (Windows PowerShell 5.1 only, and entries show as web credentials); (c) no Windows support (use `${ENV}`).
- **Recommendation:** (a), built, with every call covered by a fake and the script's contract tested; the script itself has not run on Windows (no Windows machine in this batch), so the manual verification item stays open. CI's Windows job runs the fakes only.
- **Owner:** *(open; built as (a))*

### D-274 — Names are restricted for writing, and a stored secret is read back *(P8-08)*
- **Context:** `security -i` takes a command line on standard input with its own quoting, and exits 0 even when the command failed; `secret-tool store` can also succeed without a usable store (no D-Bus is reported as an error, a locked keyring may not be).
- **Options:** (a) service and account for writes are 1 to 100 characters of letters, digits and `. _ @ -`; the macOS secret travels as hex (`-X`); every write is followed by a read that must return the same secret, else an error; reads keep the old looser rule so existing references work; (b) quote and escape for each tool; (c) trust exit codes.
- **Recommendation:** (a), built. Nothing needs quoting, and a write that did not take effect is an error instead of a token that is later "not found".
- **Owner:** *(open; built as (a))*

### D-275 — Keychain commands, and a master key straight into the keychain *(P8-08)*
- **Context:** A reference is of no use until the secret is stored; asking people to run `security` or `secret-tool` by hand per OS defeats the purpose.
- **Options:** (a) `keychain set|delete|status` (secret from file, `AB_KEYCHAIN_SECRET`, standard input or a hidden prompt, never a flag) and `init --keychain <name>` (generates the master key into the keychain; refuses to replace an entry; says the keychain is not a backup); (b) documentation of the OS commands only; (c) `keychain get` as well (prints a secret: not offered).
- **Recommendation:** (a), built. `status --name` answers only whether an entry exists.
- **Owner:** *(open; built as (a))*

### D-276 — Import and export are composed on the admin API, client side *(P8-05)*
- **Context:** L-065: every alternate writer is an authorization boundary. An import could write the database directly, or ask the server for an import endpoint, or drive the existing admin API one record at a time.
- **Options:** (a) the CLI reads the lists and posts creations through the admin API (local in process, or remote with the admin token): validation, owner guards and audit rows are the ones every other command gets, and a remote deployment (a Worker too) works; (b) a new server endpoint `POST /config/import` (one more writer to guard and to document, and a large body for the API to cap); (c) write the storage directly (bypasses every guard).
- **Recommendation:** (a), built. Export of tokens is the exception: only the local database and master key can decrypt a token, so `--with-tokens` is local-only and writes an audit row.
- **Owner:** *(open; built as (a))*

### D-277 — What an export carries, and what an import may do *(P8-05)*
- **Context:** L-078 asks that what moves and what does not be defined. People, their grants and personal credentials belong to the target's sign-in; a personal credential must never be assigned to anyone else (T29).
- **Options:** (a) instances (without TLS file paths), shared credentials, workspaces and service grants; import only creates, matches on instance address, shared credential label and workspace slug, never updates or deletes, and adds grants only to workspaces it creates itself (a file never opens a new way into what exists); a personal credential with the same label is skipped, never used; a workspace that enables writes or pass-through needs `--allow-sensitive`; (b) also users and people's grants (needs the target to hold the same sign-in identities; a grant could then name a user the importer does not control); (c) update existing records to match the file (can widen a workspace).
- **Recommendation:** (a), built. A file cannot widen what exists, name a person or an owner (the reader is strict), or carry a token in the clear.
- **Owner:** *(open; built as (a))*

### D-278 — Import is a dry run unless `--apply` *(P8-05)*
- **Context:** The task asks for an additive import with a dry run. A default that writes is quicker, one that plans is safer: the file may come from somewhere else.
- **Options:** (a) the plan by default, `--apply` to write (a second explicit word for the one risky step); (b) write by default and `--dry-run` to plan; (c) always ask interactively (not scriptable).
- **Recommendation:** (a), built. The plan names every item as create, exists, skip (with the reason) or failed.
- **Owner:** *(open; built as (a))*

### D-279 — The passphrase seal binds its own header, and the cost is fixed *(P8-05)*
- **Context:** The task fixes PBKDF2-HMAC-SHA-256 at 600,000 iterations and AES-256-GCM. A file that names its own cost would let a crafted file cost minutes of CPU or choose a weak setting.
- **Options:** (a) the algorithm and the cost are constants: a file naming anything else is refused before deriving a key; the header (format, version, KDF, cost) is the AES-GCM additional data, so editing it fails the open; a wrong passphrase and a changed file give the same message; a passphrase is 12 to 1,024 characters; (b) honour the file's cost within a range; (c) scrypt or Argon2id (not what the task says, and not in Web Crypto).
- **Recommendation:** (a), built.

### D-247 — Quota settings: two limits for every grant, off by default *(P8-09)*
- **Context:** The task names `AB_LIMIT_QUOTA`, which is already the error code of a refused quota. Counters are per grant; the limits could also differ per grant or workspace.
- **Options:** (a) `AB_QUOTA_DAILY` and `AB_QUOTA_MONTHLY`, deployment-wide numbers applied to every grant, each off when unset; overrides later (P8-14); (b) one combined setting (`daily=,monthly=`); (c) per-grant limits in the grant policy now (admin API, CLI, panel and access model changes).
- **Recommendation:** (a), built. Two plain integer settings follow the existing ones; `AB_LIMIT_QUOTA` stays the error code; overrides are a separate task because they touch the policy schema, the guards (an administrator must not loosen an owner's value) and three admin surfaces.
- **Owner:** *(open; built as (a))*

### D-248 — Count logical calls, write the total once per request *(P8-09)*
- **Context:** Workers Free allows 100,000 D1 rows written a day and 50 D1 statements a request; one increment per upstream call (up to 45 a tool call) would eat both.
- **Options:** (a) count in memory per request (a call is counted at its first attempt, a cache hit never reaches the client) and add the total to the day and month counters when the call ends, with one read at the first upstream call; (b) increment per call (exact, atomic, many rows); (c) count in the audit rows and sum them.
- **Recommendation:** (a), built: at most 1 read and 2 increments per request. The cost is a small overshoot when requests of one grant run at once, documented.
- **Owner:** *(open; built as (a))*

### D-249 — Fail open on a counter outage; writes are counted, not refused *(P8-09)*
- **Context:** L-080 asks for an explicit fail-open or fail-closed choice. A quota is a cost control, not an authorization; a write's approval is single use and the write limiter already fails closed.
- **Options:** (a) reads fail open on an unreadable counter, writes are counted but never refused by the quota; (b) fail closed for everything (a D1 hiccup stops all reads); (c) fail open, and refuse writes over the quota too.
- **Recommendation:** (a), built. `whoami` and the panel show `unknown` rather than "unlimited". A write the person approved should not be lost to a read quota, and the write limiter plus approval already bound writes.
- **Owner:** *(open; built as (a))*

### D-250 — A refused quota is a tool error, not an HTTP 429 *(P8-09)*
- **Context:** Rate limits answer HTTP 429 with `Retry-After`; a day-long quota would make a client back off for hours and, for some, treat the whole server as down.
- **Options:** (a) a tool-error result with `AB_LIMIT_QUOTA`, the period, the limit, the use and the UTC reset, raised inside the Agility client; (b) HTTP 429 with a `Retry-After` of hours; (c) a protocol error.
- **Recommendation:** (a), built; the agent reads the reason and the reset instant, and tools that need no request keep working.
- **Owner:** *(open; built as (a))*

### D-251 — No quota on stdio *(P8-09)*
- **Context:** stdio has one process, one token, no grants and no shared store; the per-call budget and the Agility instance's own quota apply.
- **Options:** (a) remote hosts only; (b) an in-process counter per process (resets on restart, so a weak promise).
- **Recommendation:** (a), built; documented in the guide.
- **Owner:** *(open; built as (a))*

### D-280 — One generator for every client snippet, link and the plugin's `.mcp.json` *(P8-06)*
- **Context:** The same stdio entry is written for six clients, the docs, a plugin and install links. Hand-written copies drift (L-027 shows how an upgrade changes what clients expect).
- **Options:** (a) `apps/cli/src/client-snippets.ts` builds them all; the `client-config` command prints them; the plugin's `.mcp.json` is generated by an import-free module the release script also runs; tests compare the committed files with the output; (b) hand-written files and a checklist; (c) a templating script that writes docs.
- **Recommendation:** (a), built. No snippet holds a token: a prompt (VS Code), a variable or `userConfig` the client expands (plugin), a placeholder (Cursor link) or a `keychain:<name>` reference (P8-08).
- **Owner:** *(open; built as (a))*

### D-281 — The plugin and its marketplace file live in this repository, pinned to the package version *(P8-06)*
- **Context:** A Claude Code plugin can be listed by a marketplace file in any repository; publishing to Anthropic's directory or another marketplace is an owner step.
- **Options:** (a) `plugins/agility-bridge` plus `.claude-plugin/marketplace.json` at the root (`/plugin marketplace add mhidalgo-lab/agility-bridge` works once pushed), the plugin starting `npx -y agility-bridge@<its version>`, the version synced by `release.ts sync-version`; (b) an unpinned `npx -y agility-bridge` (a plugin update would not change what runs); (c) a separate plugin repository (two repositories to keep in step).
- **Recommendation:** (a), built. A plugin update and a package update are one event, and the pin makes "which server does this plugin run" answerable. Listing in Anthropic's directory or any marketplace is not done (owner).
- **Owner:** *(open; built as (a))*

### D-282 — The plugin's settings are `userConfig`, with the token marked sensitive; commands are read-only *(P8-06)*
- **Context:** The plugin needs the instance address and a token. Claude Code stores `sensitive` options in the system credential store and substitutes `${user_config.KEY}` in the MCP entry; the plugin may not hold a secret in a file.
- **Options:** (a) `agility_url` and a `sensitive` `agility_token` as `userConfig`; four read-only commands (my work, find item, sprint status, standup) and two skills (workflows; conduct: untrusted data, scope, secrets, approvals), every command repeating the untrusted-data rule; (b) ask the user to export variables (not reliable for a GUI-started client, L-026); (c) commands that write (ADR-0013: writes stay opt-in and approved, so no command encourages them).
- **Recommendation:** (a), built. The plugin has not been installed in a real Claude Code in this batch (*unverified*; owner step), nor validated with `claude plugin validate` (the tests encode its documented rules).
- **Owner:** *(open; built as (a))*

### D-252 — A task runs inside the poll that claims it *(P8-10)*
- **Context:** Workers must not do work after a response, and the SDK has no Tasks runtime, so there is nowhere to run a report "in the background".
- **Options:** (a) creation returns the handle at once and the first `tasks/get` runs the stored call through the normal MCP pipeline, claimed by an atomic lease; (b) run the report at creation and store the result (the client's call still blocks until it ends, so no timeout benefit); (c) a Durable Object or queue worker (new Cloudflare resources, not allowed here).
- **Recommendation:** (a), built. The client's `tools/call` returns at once; each poll is a normal request with its own budget, quota and audit. The report must still fit one request.
- **Owner:** *(open; built as (a))*

### D-253 — Only report tools become tasks *(P8-10)*
- **Context:** The task names long reports and exports; write tools need an approval round trip that a task would complicate (L-411).
- **Options:** (a) tools in the `reports` group, read-only, when the request declares the extension; (b) every read tool; (c) a per-tool flag.
- **Recommendation:** (a), built. The group already marks the expensive composites and is enabled per workspace; other tools answer inline even for a declaring client.
- **Owner:** *(open; built as (a))*

### D-254 — Authorised per device, grant and workspace; no tasks for pass-through *(P8-10)*
- **Context:** A task handle must not work for another device of the same person, but a pass-through workspace has one shared identity for all callers.
- **Options:** (a) the record binds grant id, workspace id and the device token id; pass-through callers get no tasks; (b) bind the person only; (c) bind the pass-through token fingerprint too.
- **Recommendation:** (a), built; (c) is possible later.
- **Owner:** *(open; built as (a))*

### D-255 — `tasks/update` always refuses; `input_required` is never produced *(P8-10)*
- **Context:** The extension allows a task to ask for input (elicitation or sampling). Report tools never ask, and write approvals are out of scope (D-253).
- **Options:** (a) refuse `tasks/update` with invalid params and never enter `input_required`; (b) implement input routing for future tools.
- **Recommendation:** (a), built; the status stays in the vocabulary for the day a task tool asks.
- **Owner:** *(open; built as (a))*

### D-256 — `AB_TASKS` is on by default *(P8-10)*
- **Context:** The extension is only used by requests that declare it, and only for report tools an owner enabled.
- **Options:** (a) on, with `AB_TASKS=off` as the kill switch; (b) off until verified with a real client.
- **Recommendation:** (a), built, as the task asks for a kill switch; it can be flipped to (b) if the live check (P8-15) finds a client problem.
- **Owner:** *(open; built as (a))*

