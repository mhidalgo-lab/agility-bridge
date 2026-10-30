

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

### D-287 — The config bundle authenticates where each token may go *(P8-12, S-1)*
- **Context:** Only the `secrets` block was sealed; `instances[].baseUrl` and the credential-to-instance map sat outside the authenticated data, so someone editing the file could point a decrypted token at another host (the import validates the credential against the instance URL), and the plan showed instance labels only.
- **Options:** (a) put the canonical instance addresses and the credential-to-instance map into the AES-GCM additional data, bump the file version to 2, print addresses in the plan; (b) encrypt `{token, baseUrl}` per credential; (c) a detached signature.
- **Recommendation:** (a), built. Cheapest, no second key, and the same one-message refusal. Version 1 files that carry tokens are refused (re-export them); token-less files only need `version: 2`.
- **Owner:** *(open; built as (a))*

### D-288 — `config import --add-grants` finishes a partly failed import *(P8-12, Q-3)*
- **Context:** Import never adds grants to an existing workspace, so a run that created a workspace and then failed on a grant could not be completed by import.
- **Options:** (a) an explicit flag, off by default: grants the file has and the existing workspace lacks (by label, not revoked) are created through the admin API; (b) always add missing grants; (c) document a manual recovery only.
- **Recommendation:** (a), built, plus a recovery line on stderr when a run fails or leaves a workspace without its default credential. A file still never opens a new way into what exists unasked.
- **Owner:** *(open; built as (a))*

### D-289 — `doctor --fix` repairs only directories it would have chosen; foreign text is sanitised *(P8-12, S-6)*
- **Context:** `--fix` did `chmod 0700` on the directory of `AB_DB_PATH`, which can be a group-shared directory; server names from a project's `.mcp.json` were printed raw; a FIFO named `.mcp.json` blocked the open.
- **Options:** (a) the data-directory fix only without `AB_DB_PATH` (reported with the command otherwise), control characters replaced by `?` in every finding, `O_NONBLOCK` open plus `fstat`; (b) drop directory repairs; (c) ask per path.
- **Recommendation:** (a), built.
- **Owner:** *(open; built as (a))*

### D-290 — Environment keychain references read the `agility-bridge` service only *(P8-12, S-2)*
- **Context:** A project's `.mcp.json` can set `AB_AGILITY_TOKEN=keychain:<service>/<account>` and so make the server read another application's entry.
- **Options:** (a) refuse non-default services in environment values (`AB_AGILITY_TOKEN`, `AB_MASTER_KEY*`), allow them in the user's own YAML file; (b) an allowlist variable (also settable by the same hostile file, so no protection); (c) bind each entry to an instance host.
- **Recommendation:** (a), built. It protects other applications' secrets. It does not stop a hostile file from sending the user's own `agility-bridge` entry to another host: that needs (c), filed as P8-31.
- **Owner:** *(open; built as (a))*

### D-291 — The stdio server warns about settings only remote hosts read *(P8-12, Q-7)*
- **Context:** `AB_QUOTA_*`, `AB_OTEL_*`, `AB_TASKS`, `AB_QUERY_CACHE_EDGE` and `AB_PUBLIC_TOOL_CATALOG` are valid names that stdio ignores, so a cost control could silently do nothing.
- **Options:** (a) a stderr warning naming them when stdio starts configured; (b) refuse them (breaks shared env blocks); (c) implement them for stdio (P8-20 covers telemetry).
- **Recommendation:** (a), built. The warning is not raised for a shell with no Agility configuration (doctor, management commands).
- **Owner:** *(open; built as (a))*

### D-292 — Keychain availability is a probe; `doctor --offline` skips keychain references *(P8-12, Q-8)*
- **Context:** `available()` only checked that the tool started, and `secret-tool` has no documented `--version`; doctor resolved `keychain:` references even with `--offline`.
- **Options:** (a) probe with a lookup of a random attribute (Linux: exit 1 with no message means a reachable store) and require exit 0 for the other tools; doctor skips keychain reads under `--offline` and reports the checks as skipped; (b) leave it.
- **Recommendation:** (a), built.
- **Owner:** *(open; built as (a))*

### D-293 — The Windows keychain script pins UTF-8 and refuses non-ASCII secrets for now *(P8-12, Q-9)*
- **Context:** The PowerShell script read and wrote through the console's OEM code page, and the read-back used the same path, so a mangled secret verified. The script has never run on Windows (D-273).
- **Options:** (a) set `[Console]::InputEncoding` and `OutputEncoding` to UTF-8 without BOM, and refuse non-ASCII secrets until a real run proves it (P8-32); (b) only the encoding; (c) only the refusal.
- **Recommendation:** (a), built. Access tokens and master keys are ASCII, so nothing is lost.
### D-295 — Accounting work finishes after the response on Workers *(P8-12 (P-2))*
- **Context:** The quota counters' write (two D1 upserts) and the query cache's shared-tier store (seal, `cache.put`, first read-back) sat on the request's critical path: up to three D1 round trips plus the cache operations of added latency per read call.
- **Options:** (a) hand both to the host's `background` hook (`waitUntil`) where it has one, and await them where it has none (Node, stdio); (b) keep them inline; (c) drop the shared tier's read-back.
- **Recommendation:** (a), built, through an optional `ToolContext.background` set only by a host that has the hook. Only work that proves nothing and is not needed to decide the answer moves: the quota read that decides a refusal, authorization, the budget, audit intent and the write limiter stay on the request path. Cost: on Workers the next request in the first moments after another may read the old counter (the counters were already approximate and fail open, D-249). The memory tier is still filled before the answer returns.
- **Owner:** *(open; built as (a))*

### D-296 — The quota is a soft cap: document the overshoot bound, no per-call reservation *(P8-12 (S-5))*
- **Context:** Parallel requests of one grant each read the counters once and each may spend up to its own call budget before any of them writes, so the quota can be overshot.
- **Options:** (a) document the bound (requests in flight of one grant times the call budget) and keep one read and one write per request; (b) reserve units atomically with `kv.increment(max)` per call or per batch, a D1 write for every Agility request; (c) reserve a batch of units at the first call.
- **Recommendation:** (a), built. A hard cap costs the D1 rows the design exists to save (L-415, 100,000 a day on Free) and the quota is a cost control that already fails open (D-249). (c) stays possible if an owner needs a hard cap, with a larger overshoot than the saving is worth on Free.
- **Owner:** *(open; built as (a))*

### D-297 — Shared-tier entries carry the time Agility was asked *(P8-12 (Q-1))*
- **Context:** A copy promoted from the shared tier into an isolate's memory restarted the TTL, so an answer could be served up to twice the TTL (120 s at the 60 s maximum) after it was read, against a guide that promises one TTL.
- **Options:** (a) store the write time in front of the text inside the sealed body (`<ms>:<text>`) and give the promoted copy the remaining life; (b) do not promote shared-tier hits to memory; (c) read the Cache API `Age` header.
- **Recommendation:** (a), built in the cache itself, so every tier implementation keeps one rule and the body stays authenticated (the time is inside the sealed text, bound to the entry id). A time in the future (clock skew between isolates) is clamped to now; an entry without a readable time is a miss. (b) loses the memory saving; (c) depends on a header a no-op or foreign cache may not set.
- **Owner:** *(open; built as (a))*

### D-298 — The query cache is bypassed by the caller's own write tools, not by the workspace *(P8-12 (Q-11))*
- **Context:** The bypass was keyed on `workspace.writes.enabled`, so a read-only grant in a writing workspace lost the cache (and `whoami`'s block) while the text promised that only a caller with write tools bypasses it.
- **Options:** (a) key it on the caller's write runtime (`ctx.writes`, present only when the server switch and this caller's write tools hold); (b) keep the workspace rule and fix the text.
- **Recommendation:** (a), built. The write layer's reads still pass `fresh`, and a writing caller never reads or fills the cache. Residual, documented: a read-only grant next to a writing one can show up to one TTL of data from before the other grant's write.
- **Owner:** *(open; built as (a))*

### D-299 — The quota is asked before the call budget is spent *(P8-12 (Q-4))*
- **Context:** `#send` spent a budget unit and then the quota refused the call, so the audit row, the log and the span claimed a request that never reached Agility.
- **Options:** (a) ask the quota first (an exhausted budget is refused before it, so no quota unit is counted for a call that cannot happen) and spend the unit after; (b) refund the unit on refusal.
- **Recommendation:** (a), built; there is no refund path to get wrong.
- **Owner:** *(open; built as (a))*

### D-300 — A task poll has the request deadline; failures release the lease *(P8-12 (Q-2, P-5))*
- **Context:** The poll that ran a report was outside the deadline race, and a thrown runner, an abandoned poll or a result that could not be saved left the lease for 200 s and then reran the report.
- **Options:** (a) race the run against the request deadline and turn a late, thrown or unsaveable run into a stored `failed` task, release the lease in `finally`; (b) return `working` at once and run in `waitUntil`; (c) a Durable Object or queue.
- **Recommendation:** (a), built. (b) cannot work for a report longer than Workers' post-response budget; (c) needs Cloudflare resources the owner has not allowed ([P8-36](../tasks/phase-8-power-features/P8-36-background-task-runner.md)). The residual is documented: a client that drops the poll can leave the task `working` until the lease ends, after which the next poll runs the report once more.
- **Owner:** *(open; built as (a))*

### D-301 — A cancel is a marker the finishing poll checks *(P8-12 (Q-5))*
- **Context:** Cancel and completion each read, changed and saved the record, so a cancel acknowledged to the client could be overwritten by the result.
- **Options:** (a) the cancel stores a marker first, then marks the record; the finishing poll saves its result and then checks the marker and rewrites `cancelled`; (b) a conditional write on the record (the `kv` has no compare-and-set on the value).
- **Recommendation:** (a), built: both orders end `cancelled`, at the cost of one extra read in the finishing poll and one extra write in a cancel.
- **Owner:** *(open; built as (a))*

### D-302 — A task is validated and bounded at creation; a finished result needs the same scope *(P8-12 (S-3, S-4))*
- **Context:** Creation stored arguments unchecked (up to the 1 MiB body), without a cap per grant, and a finished result was returned after the grant lost the tool or was narrowed.
- **Options:** (a) arguments must be an object of at most 8 KiB valid for the tool's schema; 30 creations per grant per 15-minute window through an atomic capped counter; a result is returned only while the tool is still granted and a digest of projects, asset types and limits equals the one stored when it ran; (b) also write an audit row at creation; (c) count creation against the per-grant quota.
- **Recommendation:** (a), built. Creation asks Agility nothing, so it takes no quota unit, and the report's own audit and quota apply when it runs (b and c would double count). Narrowing or widening limits both invalidate a stored result: simple and safe, at the price of a re-run after an admin change.
- **Owner:** *(open; built as (a))*

### D-303 — A result too large to keep ends the task as failed *(P8-12 (P-5))*
- **Context:** A report result above about 190 KB made the save throw after the report ran.
- **Options:** (a) a result above 150,000 characters (checked before sealing, which also saves CPU) or that fails to save becomes a short `failed` record; (b) truncate; (c) chunk across `kv` values.
- **Recommendation:** (a), built; truncating would hand a client a partial report that looks complete (L-033).
- **Owner:** *(open; built as (a))*

### D-304 — Spans of requests that never authenticated are sampled *(P8-12 (P-3, S-8))*
- **Context:** Every 401, 429 and public-catalogue request produced a span and, on Workers, an outgoing OTLP request, so anyone who can reach the server set the volume of the collector's bill and of subrequests.
- **Options:** (a) at most 30 such spans a minute per process or isolate, the rest counted in `stats().sampledOut`; (b) never record them; (c) batch on Workers.
- **Recommendation:** (a), built: refusals stay visible to the operator and the amplification is bounded; authenticated spans are never sampled. (c) stays for [P8-35](../tasks/phase-8-power-features/P8-35-catalogue-cache-single-flight.md).
- **Owner:** *(open; built as (a))*

### D-305 — Telemetry endpoint, caller trace ids and the view's `postMessage` target stay as built; the public catalogue advertises no extension *(P8-12 (S-8, S-9, S-10))*
- **Context:** Three low observations: `AB_OTEL_ENDPOINT` has no public-address rule unlike other egress; a caller's `traceparent` trace id is adopted; the MCP Apps view posts to `'*'`; the anonymous `server/discover` listed the Tasks extension.
- **Options:** (a) document the first three (operator-chosen collector, harmless trace id, the host's origin cannot be known) and stop advertising extensions to anonymous callers; (b) apply `checkPublicHost` to the endpoint unless private addresses are allowed; (c) pin a target origin.
- **Recommendation:** (a), built. An internal collector is a legitimate target and the endpoint is operator configuration, not caller input; (c) is impossible for a sandboxed frame. The catalogue fix is a plain defect fix: the anonymous prepared request carries no extensions.
- **Owner:** *(open; built as (a))*
