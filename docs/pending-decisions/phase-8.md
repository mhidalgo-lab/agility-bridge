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

