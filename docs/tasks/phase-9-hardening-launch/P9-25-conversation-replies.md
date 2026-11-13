---
id: P9-25
title: Replies to comments in get_conversations
phase: 9
status: review
priority: high
depends_on: []
adr: ["0012", "0015"]
lessons: [L-038, L-064, L-505]
owner: "claude (agent)"
---

# P9-25 — Replies to comments in get_conversations

## Goal
A reply to a comment is part of the discussion of a work item, yet no tool returned it. A live report on 2026-11-13: a
defect's comment had one reply (`Replies.@Count = 1`), `get_conversations` listed only the two top-level comments, and
`get_assets` refused `Replies.Content` (`AB_AUTH_FORBIDDEN`). Replies mention nothing: they reach the work item through
the comment they answer (`InReplyTo`), and the derived scope path of `Expression` (`Mentions:Workitem.Scope`) left every
reply outside every workspace.

## Scope
- A derived scope strategy can name alternative paths, ORed with its main path (`DERIVED_SCOPE_ALTERNATIVES`):
  `Expression` is in the workspace through `Mentions:Workitem.Scope` **or** `InReplyTo.Mentions:Workitem.Scope`. An
  alternative that does not resolve on the instance is left out; the main path still applies.
- The alternatives apply wherever the main path did: the server-owned predicate (`(a=$ab_scope|b=$ab_scope)`), the row
  recheck (`inScope`: any path in the workspace) and the related-asset guards (a filter through a hop ORs the hop's
  alternatives; a returned value is kept only when every OID on every path is in the workspace).
- `get_conversations` pages over the comments that mention the asset (at most 50 a page) and reads their replies with
  one more query (`InReplyTo` in the page's comments, oldest first, at most `maxRows`); each reply follows its comment
  with `inReplyTo`. A page cut by the output size cap resumes after the last comment shown with all its replies.
  Declared cost 10 → 11.
- One level of replies, as Agility threads are a comment and its replies: a reply to a reply is reached by no path and
  stays out.

## Acceptance criteria
- [x] Replies of a comment on an asset in scope are listed after it, oldest first, with `inReplyTo` (unit tests).
- [x] A reply to a comment on another project is never returned, also when the upstream ignores the filters; the
      reply query asks only for the page's comments and carries the workspace predicate (negative tests).
- [x] A reply to a reply is left out, with filters evaluated or ignored (test).
- [x] The compiler ORs a derived type's paths in the predicate and in a hop's filter guard, selects every path for the
      recheck, and keeps the stricter value guard (tests); an instance without `InReplyTo` keeps the main path alone.
- [x] Live (read-only tenant): a recent reply is found, and `get_conversations` lists it under its comment in a
      workspace restricted to that one project, within the declared cost (ids only).
- [x] THREAT_MODEL T3, ARCHITECTURE §6.3 and RESEARCH updated; lesson L-505 recorded; changeset added.

## Security notes
THREAT_MODEL T3 (project scope). The alternative path widens nothing: a reply is placed in the workspace by the work item
its own comment mentions, which is the same thread. The recheck still drops any row whose paths all fall outside, and the
reply query is built only from comment ids of the scope-checked page. A1: reply text goes through the shaper and the
untrusted-data envelope like every comment (L-038).

## Lessons applied
- L-038 — reply text is on the same enveloped output path as comments.
- L-064 — every returned reply is rechecked against the workspace, on every scope path.
- L-505 — the live check now asserts on a relation that is optional in Agility (a reply), not only on shapes.

## Docs to update
- `docs/THREAT_MODEL.md` (T3), `docs/ARCHITECTURE.md` (§6.3), `docs/RESEARCH.md`, `docs/LESSONS-LEARNED.md`, the tools
  reference (generated).

## Out of scope
- `query_assets`' `project` argument on `Expression` filters by the main path only, so replies are not narrowed to a
  project there (the workspace predicate still includes them).
- Images inside comments (P9-24).
