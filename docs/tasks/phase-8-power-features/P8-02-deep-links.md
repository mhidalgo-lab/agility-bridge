---
id: P8-02
title: Deep links to the Agility UI
phase: 8
status: review
priority: low
depends_on: [P6-13]
adr: ["0011"]
lessons: [L-056]
owner: ""
---

# P8-02 — Deep links to the Agility UI

## Goal
Every result row that is an Agility asset carries a link that opens it in the Agility UI, built only from configuration,
and a read never creates a public or share link.

## Scope
- One function (`packages/core/src/output/links.ts`) builds the link from `ctx.instance.baseUrl` (the pinned, canonical
  instance URL) plus `/assetdetail.v1?oid=<Type:id>` (or `?number=<number>` when a row has no OID). The host, scheme and
  path never come from Agility data or from caller input; the only variable parts are an OID or number that match a
  strict allowlist pattern, and a row whose values fail it gets no link.
- The server adds `url` to every `structuredContent` object that is an asset row (it has an `assetType` and a valid
  `oid` or `number`) and does not already carry a `url`, at one choke point after the handler returns, so every tool
  (lists, details, reports, write plans) is covered and a new tool cannot forget it.
- The text output stays compact: one fixed `Note:` line says where links are (`url` in each item) and shows the URL
  pattern once, instead of repeating a URL per row.
- No share, public or "anyone with the link" URL is ever built or fetched; the link needs a signed-in Agility session.
- Out of scope: validating each asset type against a real instance (needs the live pass).

## Acceptance criteria
- [x] `assetLink` builds links only from the pinned origin and path, with OID/number allowlist patterns; hostile and
      malformed values yield no link (unit tests, including an OID that tries to change the host or path).
- [x] Every asset row in `structuredContent` of every tool gets `url`; rows without identity, rows that already have a
      `url` (Agility Link assets) and non-asset objects are left alone (unit and server tests).
- [x] The text output carries one fixed note with the pattern and never a per-row URL or Agility text.
- [x] No tool output contains a URL that is not on the pinned origin (property test over the sample worlds).
- [ ] Links validated for every asset type on the sandbox (*unverified*: needs a real instance; left for the Phase 8
      review's live pass, which also checks that `assetdetail.v1?oid=` redirects as expected).

## ## Security notes
THREAT_MODEL T26.

## Lessons applied
- L-056 — Reads never create public links.

## Docs to update
- docs/reference/tools.md (generated)

## Out of scope
- Anything not listed under Scope.
