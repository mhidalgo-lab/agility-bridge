# ADR-0015 — Tool output contract and untrusted-data envelope

- **Status:** proposed (finalised in P0-11)
- **Date:** 2026-10-16
- **Related:** [tool conventions](../dev/tool-conventions.md), P0-11, P1-05, L-017, L-018, L-030 – L-045, THREAT_MODEL
  T6, A1, A7

## Context

Agility content is user-generated (descriptions, acceptance criteria, comments, names) and often HTML. It reaches a
language model that may follow instructions hidden in it. Agents also need compact, predictable output to choose and
chain tools well, and clients validate outputs against schemas.

## Decision

Every tool returns:

1. **Text**: a one-line summary, notes, then data in the requested `format` (`auto` = table up to 8 columns, CSV above;
   `table`; `csv`; `json`).
2. **`structuredContent`** matching an **additive, open** `outputSchema` (extra properties allowed).
3. **`_meta["agility-bridge/result"]`**: instance, workspace, query actually run (with values masked), requests used, cache
   status, truncation, links.

Rules:

- All Agility-originated text (including names in summaries, notes and candidate lists) is inside an **untrusted-data
  envelope** with a random per-call marker; look-alike markers in data are neutralised; a one-line warning precedes each
  block. Rich text (HTML) is converted to plain text/Markdown with scripts, styles and event attributes removed; control
  and bidirectional-override characters are stripped.
- Caps (defaults / hard maximums): rows 100 / 1,000; value length 300 / 4,000 characters; data block 24,000 / 100,000
  characters; columns 50 / 200. Cuts end with a notice that says how to get the rest.
- Paging: `nextCursor: string | null`; `truncated` only for deliberately bounded lists; `total` from `needTotal` or
  `null` when unknown (never `-1`, never a guess).
- Completeness: `partial: true` with `notes[]` whenever pagination, permissions, limits, budget or a failed section
  prevent a complete answer; no plausible zeros.
- Identity on every row: `number`, `assetType`, `oid`, `state`, `project`, and timestamps where relevant.
- Personal data minimisation: member emails are not returned unless the workspace enables it.
- Errors: `isError: true`, text `CODE: message` plus an optional `Hint:`, `_meta["agility-bridge/error"] = { code,
  requestId }`; stable `AB_*` codes (list in [ARCHITECTURE.md](../ARCHITECTURE.md) §7); raw Agility bodies are never
  returned; unexpected exceptions become `AB_INTERNAL` with a reference id.
- CSV output neutralises spreadsheet formulas.

## Consequences

- One shaper for every tool; every new output path is covered by the poisoned-string probe tests.
- The envelope is advisory for the model, not a security boundary: write tools still need approval (ADR-0013).

## Alternatives considered

- **Envelope only free-text fields:** rejected; names and error texts carried injections in comparable servers.
- **JSON-only output:** rejected; many clients show only text, and CSV/table output is far cheaper in tokens.
