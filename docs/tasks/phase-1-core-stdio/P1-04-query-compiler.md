---
id: P1-04
title: Query builder, safety and limits
phase: 1
status: todo
priority: high
depends_on: [P1-03]
adr: ["0010", "0012"]
lessons: [L-034, L-057, L-058, L-059, L-060, L-061, L-137, L-139, L-143, L-149]
owner: ""
---

# P1-04 — Query builder, safety and limits

## Goal
Compile structured read requests into safe `query.v1` JSON: bound values, validated identifiers, an unwidenable scope predicate, explicit paging and enforced limits.

## Scope
- The structured input model of ADR-0012 and the pipeline of ARCHITECTURE §6.3.
- `with`-variable emission for every value; filter tokens built only from validated attribute paths and allowlisted operators.
- Server-owned predicates at the top level: the workspace's Agility projects through the asset type's scope strategy, and the default dead-asset exclusion.
- Generic ordering as `sort: [{ field, direction }]` and point-in-time reads as `as_of` (compiled to `asof`).
- Explicit `page`, deterministic sort with a unique tiebreaker, optional `needTotal`.
- Limits: fields, nesting depth, aggregations, `any_of` groups, `as_of` age, history window, `limit`.
- Time model: `time_range` parser (UTC, rolling vs calendar periods, Monday weeks, inclusive date-only ends).
- Cursor binding helper; masked rendering of the compiled query for `_meta` and audit.

## Acceptance criteria
- [ ] Property tests: no caller-supplied string ever appears in `filter` tokens; hostile values (quotes, pipes, brackets, Unicode, control characters) only reach `with` or are refused.
- [ ] OR-injection and multi-query attempts cannot escape the scope predicate (tests).
- [ ] Each scope-strategy class has compile tests; global types need an explicit workspace allowance; denied and unclassified types are refused.
- [ ] Limit violations return `AB_LIMIT_QUERY` with the limit's name and unit.
- [ ] `time_range` boundary tests; snapshot tests of compiled queries; filter-before-cap verified.

## Security notes
THREAT_MODEL T4, T5, A3, A10.

## Lessons applied
- L-034 — Filter before you cap.
- L-057 — Never build upstream queries from strings.
- L-058 — Apply limits to every part of a query.
- L-059 — Scope predicates cannot be widened.
- L-060 — Bound time and history before the request.
- L-061 — One time model for the whole server.
- L-137 — Always send an explicit page size.
- L-139 — `with` is substitution, not a prepared statement.
- L-143 — Aggregations include dead assets unless told otherwise.
- L-149 — Send UTC, read the UTC variants.

## Docs to update
- docs/ARCHITECTURE.md §6.3

## Out of scope
- Tool-specific shapes (P1-08 onwards)
