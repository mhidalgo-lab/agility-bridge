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
