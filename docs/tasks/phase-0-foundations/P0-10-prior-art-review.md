---
id: P0-10
title: Prior-art review
phase: 0
status: done
priority: medium
depends_on: []
adr: []
lessons: [L-001]
owner: "Matias Hidalgo"
---

# P0-10 — Prior-art review

## Goal
Learn from existing work-management MCP servers and Agility integrations before designing tools, and record what to adopt, avoid and do differently.

## Scope
- Method: dated shallow clones or reads; no code copied; unverified items marked.
- Criteria: runtime and transports, authentication (headers, OAuth), multi-instance support, tool count and naming, query construction safety, write gating and approval, paging and output shaping, errors, license, activity.
- Candidates: GitHub's MCP server, Atlassian's remote MCP server (Jira), Azure DevOps MCP servers, Linear's MCP server, the abandoned Agility prototype, the Agility SDKs (Java, Python, JavaScript) for API usage patterns, Digital.ai's Release MCP server.

## Acceptance criteria
- [x] `docs/research/prior-art.md` with the matrix and adopt / avoid / differentiate lists, dated.
- [x] Catalogue or convention changes proposed as follow-up tasks where warranted. *(Seven proposals, routed to P0-11 as inputs rather than new task files: each changes a convention or a task P0-11 already owns.)*

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-001 — Measure before you build.

## Docs to update
- docs/research/prior-art.md (new)
- docs/RESEARCH.md §7

## Out of scope
- Reusing third-party code
