# Pending decisions — Phase 8

> Open questions and owner steps from Phase 8 (power features). Answer inline (`**Owner:** …` with a date).

> The owner authorised the whole phase as a batch (2026-10-30): decisions marked *built as …* are implemented at their
> recommendation; say so if you want the alternative.

## Decisions

### D-257 — Which messages answer without a credential on a public catalogue *(P8-11)*
- **Context:** The task lists `initialize`, `server/discover`, `ping` and `tools/list`. A 2025-era client also sends `notifications/initialized` between `initialize` and `tools/list`; a `401` there ends its handshake and makes some clients start sign-in before they have listed anything. Prompts and resources are not tool discovery and their lists depend on the tools a caller has.
- **Options:** (a) the four listed methods plus `notifications/initialized` (no effect, no data), everything else `401`; (b) exactly the four listed (strict; breaks the 2025-era handshake in clients that stop on a `401` notification); (c) also `prompts/list` and `resources/list` (a larger public surface, more per-workspace shape to keep identical).
- **Recommendation:** (a), built. The notification changes nothing and returns nothing; every method that reads data or depends on a grant still needs a credential.
- **Owner:** *(open; built as (a))*

### D-258 — What the public catalogue lists *(P8-11)*
- **Context:** The catalogue must say nothing per tenant (D-64, D-201). Which tools exist for a caller depends on workspace groups, grants, budgets and the opt-in switches (reports, attachments, writes).
- **Options:** (a) the read-only tools of the default groups, from the registry, the same list an unconfigured stdio server shows; (b) every read-only tool including the opt-in groups (tells a registry the full capability, but also that those groups exist on every deployment, true or not); (c) a hand-written static document (can drift from the registry).
- **Recommendation:** (a), built, with the group list shared by stdio and HTTP (`PUBLIC_CATALOG_GROUPS`) and a test that pins them equal. A deployment that enables reports or attachments does not show it anonymously, so the list cannot reveal a configuration choice.
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
