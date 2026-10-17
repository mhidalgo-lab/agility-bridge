# ADR-0012 — A validated generic query tool with bound parameters; no raw API passthrough

- **Status:** accepted (owner, 2026-10-16)
- **Date:** 2026-10-16
- **Related:** P1-04, P1-08, L-057 – L-060, L-139, L-141, THREAT_MODEL T4, T22, A3

## Context

Users need "any kind of task": defects, tasks, tests, issues, requests, regression tests, every other asset type the
instance's metadata exposes, and `Custom_` fields, not only the workflows a typed tool anticipates. A raw passthrough of `query.v1`, `rest-1.v1` or
`api/asset` would bypass workspace and Agility-project restrictions, limits, read-only guarantees, redaction and audit. Agility's filter
grammar (`=`, `!=`, `~=`, `|`, `;`, `&`, brackets, downcasts, aggregations) is expressive enough that string-built
filters invite injection, and its `with` binding is named-constant substitution with no documented escaping on the
`rest-1.v1` side.

## Decision

- Offer **both** typed tools for common workflows and a **generic, read-only `query_assets` tool** (plus `get_assets`)
  that works for any asset type the instance exposes.
- `query_assets` takes **structured input only**: `asset_type`, `fields`, `filters` (`{field, op, value}` with an
  operator allowlist: `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `contains`, `in`, `is_set`, `is_not_set`), optional `any_of`
  groups, `sort` (a list of `{ field, direction }`), `limit`, `cursor`, `as_of` (bounded; compiled to Agility's `asof`),
  `include_closed`, `minimal_output`, `format`.
- The server compiles input to `query.v1` JSON: asset types, attribute paths (dot paths, downcasts, filtered aggregations
  from an allowlist) are validated against the instance metadata and the workspace's asset-type allowlist; **every value
  is passed through `with` variables**, type-checked against the attribute type (text length caps, numbers, ISO dates,
  OID tokens `^[A-Za-z]+:\d+(:\d+)?$`), and values with control characters are refused.
- The server adds the **scope restriction at the top level** (AND) and excludes dead assets unless asked; callers cannot
  express OR across it. Page size is always explicit.
- Each asset type has a **scope strategy** derived from metadata — direct (`Scope` relation), derived through a parent,
  workspace-bounded, global (members, teams, list types: only through dedicated tools or an explicit workspace
  allowance) or denied — and unclassified types are denied (ARCHITECTURE §6.3).
- Field count, nesting depth, aggregation count, `any_of` groups and history depth are limited per workspace/grant.
- **No raw passthrough tool** for `query.v1`, `rest-1.v1` or `api/asset`, now or later, without a new ADR. Operators can
  disable `query_assets` per workspace or grant (`tools` lists).

## Consequences

- Every asset type the instance exposes (subject to its scope strategy) is readable from Phase 1, including types we
  never modelled.
- Some valid Agility filter expressions are not expressible; they are added to the structured vocabulary when real use
  shows a need.
- The compiler is the most security-critical component of the read path: fuzz and property tests are mandatory.

## Alternatives considered

- **Raw `query.v1` passthrough with a parser-based checker:** rejected; grammar drift and parser differentials make it a
  permanent risk.
- **Typed tools only:** rejected by the owner; it would repeat the gap that motivated the project.
