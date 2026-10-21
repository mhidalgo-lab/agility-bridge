# ADR-0011 — Agility API surface: which endpoint for what

- **Status:** accepted (owner, 2026-10-21, with the P0-06 amendments below; the write rows stay unverified until the
  writable sandbox, P7-07)
- **Date:** 2026-10-16
- **Related:** [RESEARCH.md](../RESEARCH.md) §1, P0-06, P1-02, P1-03, P1-04, P6-05, P7-01, L-137 – L-149

## Context

Digital.ai Agility exposes several API families with different formats and capabilities (details and sources in
RESEARCH §1): `rest-1.v1/Data` (XML by default; reads, single-asset writes, operations via `?op=`), `rest-1.v1/Hist`
(history), `rest-1.v1/New` (templates), `query.v1` (read-only JSON/YAML, nested selections, several queries per call,
`with` variable binding, `asof`, `needTotal`), `meta.v1` (XML schema, no authentication), `api/asset` (JSON bulk
create/update/operations with a `previewOnly` mode), `attachments.img`, `api/ActivityStream` (not authoritative),
`api/tags`, `assetdetail.v1` (UI permalinks) and others. Choosing per use case keeps the client small and the safety
rules uniform.

## Decision

| Use | Endpoint | Notes |
|---|---|---|
| All reads (lists, details, nested children, aggregates) | `POST query.v1` (JSON) | Values only through `with`, with no commas in scalar values (L-162); explicit `page {start,size}` always; "more available" from fetching `size + 1` rows instead of totals (no total on 26.0.3.2); default sort by `ID` (L-163). |
| Point-in-time and history | `query.v1` with `asof`; `rest-1.v1/Hist` (JSON) for change history | `Hist` is authoritative; ActivityStream only as a hint. |
| Schema discovery and validation | `GET meta.v1` (JSON, `Accept: application/json`) | One asset type at a time on Workers; cached per instance and `ETag` (`"<version>.<schema stamp>"`); fixtures are synthetic (D-01). |
| Single-asset updates and operations | `api/asset` (JSON) with `from: "<OID token>"`, or `rest-1.v1/Data` POST | Chosen in P0-06. Never a `where`/`filter`-based multi-asset update. |
| Creating assets | `api/asset` create (or `rest-1.v1/Data` POST), defaults from `rest-1.v1/New` | Dry run via `previewOnly=true` if P0-06 confirms it never applies changes. |
| UI links | `assetdetail.v1?number=` / `?oid=` | Built from the pinned instance origin only. |
| Attachments | Metadata via `query.v1`; content via `attachments.img` | Download is off by default (THREAT_MODEL A8). |

Not used in 1.0: Data Mart (SQL, separate product surface), `loc.v1`/`loc-2.v1` (optional later for labels), webhook
subscriptions (no server-side event handling in 1.0), the OKR audit-log API.

Request conventions: `Accept: application/json` (served by `query.v1`, `meta.v1` and `rest-1.v1` `Data`/`Hist`), an
identifying `User-Agent`, no redirects followed with credentials, response bytes capped before parsing; any remaining
XML parsed with saxes (P0-09: streaming, no entity expansion, works on Workers).

## Consequences

- Reads share one query compiler and one set of safety rules (ADR-0012).
- XML parsing is no longer needed for reads (JSON everywhere measured); it may still be needed for some write paths.
- The API authentication table documents `query.v1` as accepting every authentication method except NTLM, so access
  tokens are supported (RESEARCH §1.3). If P0-06 nevertheless finds an instance (e.g. an older on-premises version)
  where they fail, reads fall back to `rest-1.v1/Data` with the same compiler and a new ADR records it.

## Evidence (P0-06, 2026-10-21)

From [spikes/agility-api/RESULTS.md](../../spikes/agility-api/RESULTS.md), a hosted 26.0.3.2 tenant, reads only:

- **Reads through `query.v1`** hold: bearer access tokens work (also on `query.legacy.v1`), several queries per call,
  nested selections, pages up to 2,000 rows, stable ordering by `ID`. No fallback to `rest-1.v1` reads is needed.
- **`with`:** literal for quotes and operators, but **commas split a scalar into a list** (L-162): the compiler refuses
  commas in scalar values.
- **Totals:** `needTotal` returned no total and `rest-1.v1` no `total` attribute on 26.0.3.2. Paged outputs report
  "more available" (`size + 1`), not totals; the table above should drop "`needTotal: true` when a total is shown".
- **Metadata as JSON:** `meta.v1` and `rest-1.v1` (`Data`, `Hist`) answer JSON with `Accept: application/json`, so the
  schema row should read "`GET meta.v1` (JSON)", and XML parsing (saxes, P0-09) is needed only where JSON is not offered.
  The `ETag` (`"<version>.<schema stamp>"`) is the metadata version (P1-03).
- **History:** `rest-1.v1/Hist` (JSON) and `query.v1` `asof: "All"` return the same versions at the same cost.
- **Cost:** sorting by `ChangeDate` costs about 1.1 s per call against 0.23 s by `ID` (L-163).
- **Not verified here:** every write row (P7-07, writable sandbox), `previewOnly`, `assetdetail.v1` redirects.

## Alternatives considered

- **`rest-1.v1/Data` for everything:** simpler auth story, but XML-first, no nested selections or multi-query calls.
- **Exposing every endpoint as a tool:** rejected (ADR-0012).
