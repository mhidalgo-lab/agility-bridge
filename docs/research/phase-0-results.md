# Phase 0 results and go/no-go

> P0-13, 2026-10-21. **Decision: go for Phase 1** (owner). This page consolidates what the Phase 0 spikes measured and
> where each finding went; the detailed evidence stays in each spike's `RESULTS.md`.

## Spikes

| Spike | Where | Status | Headline |
|---|---|---|---|
| P0-06 Agility API | [spikes/agility-api](../../spikes/agility-api/RESULTS.md) | done | Read-only probes of a hosted 26.0.3.2 tenant through the P0-12 guard. `with` binding splits scalars at commas; no totals; `ChangeDate` sorts cost about 1.1 s; JSON everywhere; relations and scope paths mapped. |
| P0-07 MCP SDK and clients | [spikes/mcp-sdk-v2](../../spikes/mcp-sdk-v2/RESULTS.md) | done | SDK 2.3.1 serves both protocol eras on Node, workerd and stdio; approval through elicitation works on stdio and 2026-07-28 HTTP, never on 2025-era HTTP; JSON Schema cached once is about 7× cheaper per request; five real clients verified. |
| P0-08 OAuth 2.1 | [spikes/oauth](../../spikes/oauth/RESULTS.md) | done | workers-oauth-provider 1.2.3 gives one protected resource per workspace on Node and Workers; verified in production with Claude Code and VS Code (CIMD) and Inspector (DCR); parallel refreshes leave one refresh token usable. |
| P0-09 Workers limits | [spikes/workers-limits](../../spikes/workers-limits/RESULTS.md) | done | About 8 ms CPU per MB on Workers Free (512 KiB cap: 4 ms p50); saxes for XML; `node:sqlite` and D1 agree except change counts after cascades; envelope encryption portable; untrusted certificates return 526. |
| P0-10 Prior art | [research/prior-art.md](prior-art.md) | done | No maintained Agility MCP server; bound query values and change-bound approval are differentiators; seven follow-ups decided in P0-11. |
| P0-12 Live harness | [dev/verification.md](../dev/verification.md) | done | Read-only guard, shape-only output, local and CI live runs against the third-party tenant. |

## Findings and where they went

| Finding | Lesson | Applied in |
|---|---|---|
| A comma in a scalar `with` value becomes a value list | L-162 | THREAT_MODEL T4, tool conventions, P1-04 |
| Agility returns no totals (`needTotal` ignored on 26.0.3.2) | L-163 | tool conventions (`limit + 1`), ADR-0011, ADR-0015, P1-04, P1-08 |
| Sorting by `ChangeDate` costs about 1.1 s per call | L-163 | `ID` as the default sort, P1-04 |
| `meta.v1`, `rest-1.v1` Data and Hist answer JSON; `ETag` versions the schema | — | ADR-0011, P1-02, P1-03 |
| The SDK answers JSON-RPC batches on the 2025-era path | L-014 | ADR-0005, P2-06 |
| 2025-era HTTP cannot elicit; 2026-07-28 can (`input_required`) | L-025, L-156 | ADR-0005, P7-01, P7-02 |
| An `inputRequired` to a client without the capability becomes an SDK error | — | tool conventions, P7-01 |
| Nullable `type` arrays are unportable | — | tool conventions (no `null`), P1-13 |
| Benchmarks must yield to the event loop | L-159 | P0-09, P3-10, P9-03 |
| Untrusted certificates: 526 on Workers, opaque error locally | L-160 | `AB_AGILITY_TLS`, P1-02, ADR-0014 |
| D1 counts cascaded rows in `meta.changes` | L-161 | ADR-0006, P2-01 |
| The OAuth provider keeps one refresh token per grant | L-164 | ADR-0009, P5-05 |
| Task titles with `: ` were invalid YAML | L-158 | `pnpm tasks lint` |
| A minimum-release-age npm wrapper hides fresh versions | L-157 | P1-15 |

## ADRs

All Phase 0 ADRs are accepted: 0005 (P0-07), 0006, 0007, 0008 and 0010 (P0-13), 0009 (P0-08), 0011 (P0-06), 0015
(P0-11), with 0014 unchanged plus evidence. ADR-0013's approval details follow the owner's answers to D-10 – D-12 and
are verified in Phase 7.

## Known gaps (tracked, not blockers)

- **Writes and quotas:** no writable instance yet. Writes, `previewOnly`, rate limits, `RetryAfter` and the error-count
  quota are measured on a writable sandbox before Phase 7 (owner checklist item 5, P7-07).
- **Clients not tested:** Cursor and Windsurf (no subscription), Claude Desktop (cannot reach WSL), claude.ai web and
  Claude mobile (custom connectors, P5-06); community reports through the client-compatibility issue template.
- **On-premises:** no instance; the minimum version is deferred to P9-05 (D-13).
- **Workers Paid:** not available; Paid presets stay on the documented limits.
- **Agility versions:** totals and other behaviour on 26.2 and later are unverified (one tenant on 26.0.3.2).

## Go/no-go

**Go** (owner, 2026-10-21). Phase 1 starts with P1-01 (core skeleton, tool registry and error model).
