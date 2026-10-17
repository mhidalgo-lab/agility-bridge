# ADR-0011 — Agility API surface: which endpoint for what

- **Status:** proposed (pending spike P0-06)
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
| All reads (lists, details, nested children, aggregates) | `POST query.v1` (JSON) | Values only through `with`; explicit `page {start,size}` always; `needTotal: true` when a total is shown. |
| Point-in-time and history | `query.v1` with `asof`; `rest-1.v1/Hist` for change history | `Hist` is authoritative; ActivityStream only as a hint. |
| Schema discovery and validation | `GET meta.v1` (XML) | Cached per instance and metadata version; snapshot committed for fixtures. |
| Single-asset updates and operations | `api/asset` (JSON) with `from: "<OID token>"`, or `rest-1.v1/Data` POST | Chosen in P0-06. Never a `where`/`filter`-based multi-asset update. |
| Creating assets | `api/asset` create (or `rest-1.v1/Data` POST), defaults from `rest-1.v1/New` | Dry run via `previewOnly=true` if P0-06 confirms it never applies changes. |
| UI links | `assetdetail.v1?number=` / `?oid=` | Built from the pinned instance origin only. |
| Attachments | Metadata via `query.v1`; content via `attachments.img` | Download is off by default (THREAT_MODEL A8). |

Not used in 1.0: Data Mart (SQL, separate product surface), `loc.v1`/`loc-2.v1` (optional later for labels), webhook
subscriptions (no server-side event handling in 1.0), the OKR audit-log API.

Request conventions: `Accept: application/json` where supported, an identifying `User-Agent`, no redirects followed
with credentials, response bytes capped before parsing, XML parsed with a pure-JavaScript parser that works on Workers
(no `DOMParser` there) and with entity expansion disabled.

## Consequences

- Reads share one query compiler and one set of safety rules (ADR-0012).
- XML parsing is still needed for `meta.v1`, `Hist` and possibly writes.
- The API authentication table documents `query.v1` as accepting every authentication method except NTLM, so access
  tokens are supported (RESEARCH §1.3). If P0-06 nevertheless finds an instance (e.g. an older on-premises version)
  where they fail, reads fall back to `rest-1.v1/Data` with the same compiler and a new ADR records it.

## Alternatives considered

- **`rest-1.v1/Data` for everything:** simpler auth story, but XML-first, no nested selections or multi-query calls.
- **Exposing every endpoint as a tool:** rejected (ADR-0012).
