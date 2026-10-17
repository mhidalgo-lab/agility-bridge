# Pending decisions — Phase 0

> Open questions for the owner, each with options and a recommendation. Answer inline (`**Owner:** …` with a date);
> P0-13 turns answers into ADR updates and tasks. **Gate (P0-14):** D-01, D-02, D-05, D-15 and D-19 shape the first
> Phase 0 tasks and must be answered before P0-01, P0-11 and P0-12 start; D-10 – D-12 must be answered before ADR-0013's
> approval details are accepted. Decisions already taken on 2026-10-16 are listed at the end for
> reference (L-009).

## Open decisions

### D-01 — Agility sandbox access *(blocks P0-06, P0-12)*
- **Options:** a Digital.ai trial instance; a dedicated sandbox in an existing tenant; an on-premises test installation
  (in addition).
- **Recommendation:** a dedicated hosted sandbox with two least-privilege members (reader, writer) and synthetic seed
  data; an on-premises instance as well if one is available, to cover TLS with a private CA and older versions.
- **Owner:**

### D-02 — Package, registry and domain names *(P0-01, P1-15)*
- **Options:** npm `agility-bridge` (unscoped) or a scope; container `ghcr.io/mhidalgo-lab/agility-bridge`; MCP Registry
  namespace `io.github.mhidalgo-lab/agility-bridge`; docs on GitHub Pages or a custom domain.
- **Recommendation:** reserve the unscoped npm name now; GitHub Pages for docs until a domain is needed.
- **Owner:**

### D-03 — Release cadence *(P1-15)*
- **Options:** publish at the end of every phase (v0.1 after Phase 1); or publish only once remote modes exist.
- **Recommendation:** release every phase from v0.1. Local stdio with read access to every asset type is already useful,
  and early users find client and instance differences the sandbox cannot.
- **Owner:**

### D-04 — Pass-through workspaces in 1.0 *(P2-14)*
- **Options:** keep (a workspace setting, off by default, read-only); defer after 1.0; drop.
- **Recommendation:** keep as a workspace setting, off by default and read-only in 1.0: the caller's Agility token
  replaces the device token on the workspace's normal URL, and every workspace control (Agility projects, asset types,
  tools, limits, rate limits, audit) still applies. It is the simplest way for a team to share one server without
  storing tokens.
- **Owner:**

### D-05 — Default tool groups *(P0-11)*
- **Options:** everything on; core groups on and `reports` off; a minimal default (core + query only).
- **Recommendation:** core groups on, `reports` off by default (20 read tools by default; 34 with every group and all
  writes), keeping well under Cursor's 40-tool cap.
- **Owner:**

### D-06 — Member emails in output *(P1-10)*
- **Options:** on; off with a workspace switch.
- **Recommendation:** off by default (personal data minimisation, THREAT_MODEL A7).
- **Owner:**

### D-07 — Generic query defaults *(P1-04, P1-08)*
- **Options:** generic tools on or off by default; limits for fields, nesting depth, aggregations, `any_of` groups.
- **Recommendation:** on, with starting limits of 30 fields, nesting depth 2, 5 aggregations, 3 `any_of` groups, 100 rows
  per call (hard 1,000); revisit after P0-06 measurements.
- **Owner:**

### D-08 — Attachments *(P6-04)*
- **Options:** metadata only; an opt-in download tool with size and type limits.
- **Recommendation:** metadata only in 1.0 (THREAT_MODEL A8).
- **Owner:**

### D-09 — Write scope for 1.0 *(P7-04 – P7-06)*
- **Options:** wave 1 only; waves 1–2; waves 1–2 plus close/reopen; anything more (delete, bulk, conversions).
- **Recommendation:** waves 1–2 plus close/reopen; no delete, no multi-asset updates, no conversions, no attachment
  upload.
- **Owner:**

### D-10 — Relaxing write approval *(P7-01)*
- **Options:** never; allowed per deployment with a startup warning; allowed only in stdio mode (single user, own token).
- **Recommendation:** allowed only in stdio mode with an explicit `AB_WRITE_APPROVAL=off` and a warning; shared
  deployments always require approval.
- **Owner:**

### D-11 — Approval on HTTP deployments without the panel *(P7-01, P7-02)*
- **Options:** require the panel (sign-in) for any remote write; allow elicitation-only remote writes when the panel is not
  configured.
- **Recommendation:** allow elicitation-only remote writes; clients that cannot elicit are refused until the panel is
  configured (documented).
- **Owner:**

### D-12 — Out-of-band approval page *(P7-02)*
- **Options:** build it; rely on elicitation only.
- **Recommendation:** build it. VS Code and Cursor cannot be elicited over stateless HTTP and mobile apps may not elicit;
  without the page, remote writes would be unusable from primary clients (L-156).
- **Owner:**

### D-13 — Oldest supported on-premises Agility version *(P0-06, P9-05)*
- **Options:** current hosted release only; releases still maintained by the vendor; a fixed minimum version.
- **Recommendation:** decide after P0-06 from measured differences; start with "releases under vendor maintenance".
- **Owner:**

### D-14 — Telemetry *(P8-07)*
- **Options:** none; opt-in export to the operator's collector only.
- **Recommendation:** never any maintainer telemetry; opt-in OpenTelemetry to the operator's own collector, off by
  default.
- **Owner:**

### D-15 — Supported Node versions *(P0-01)*
- **Options:** Node 24 LTS only; 22 and 24.
- **Recommendation:** Node 24 LTS and later (built-in `node:sqlite`, current npm publishing requirements).
- **Owner:**

### D-16 — Default Workers preset *(P3-03)*
- **Options:** Free-plan presets by default; Paid-plan presets by default.
- **Recommendation:** Free-safe presets by default (`AB_PLAN=free`), Paid recommended for teams in the guide.
- **Owner:**

### D-17 — Dynamic client registration posture *(P5-03)*
- **Options:** on with caps; off (CIMD only); on, then restricted after verifying CIMD with target clients.
- **Recommendation:** on with caps, then restrict redirect hosts or turn it off once the client matrix shows CIMD works.
- **Owner:**

### D-18 — Agility authentication methods *(ADR-0014)*
- **Options:** access tokens only; also Agility OAuth2 grants; also Basic / Windows authentication.
- **Recommendation:** access tokens only in 1.0; evaluate Agility OAuth2 grants after 1.0; never Basic or NTLM.
- **Owner:**

### D-19 — Vocabulary in tools *(P0-11)*
- **Options:** `sprint` vs `iteration`; "backlog item" vs "story".
- **Recommendation:** `sprint` in arguments; descriptions say "backlog item (story)" and "sprint (iteration)"; schemas use
  the API names.
- **Owner:**

### D-20 — Acceptance criteria field *(P1-09)*
- **Options:** fixed attribute name; discovered from metadata; configured per instance.
- **Recommendation:** discovered from metadata where a convention exists, overridable per instance, because instances
  store acceptance criteria in different (often custom) attributes.
- **Owner:**

### D-21 — Backlog-item quality rubric *(P6-07, P6-08)*
- **Options:** none; a default rubric; a default rubric overridable per workspace.
- **Recommendation:** a versioned default rubric (INVEST-style: clear title, user value, description, testable acceptance
  criteria, estimate, size, owner, parent, linked tests), overridable per workspace.
- **Owner:**

### D-22 — Documentation language *(P1-14)*
- **Recommendation:** English only for 1.0.
- **Owner:**

### D-23 — Phase order *(ROADMAP)*
- **Options:** as planned (remote platform 3–5, tool breadth 6 in parallel); tool breadth before Cloudflare.
- **Recommendation:** as planned, running Phase 6 in parallel once Phase 2 is done.
- **Owner:**

### D-24 — Governance *(P0-03, P0-04)*
- **Options:** single maintainer with 0 required approvals; require a second maintainer before 1.0.
- **Recommendation:** start with 0 required approvals plus required checks; add CODEOWNERS and 1 required approval as soon
  as a second maintainer joins (before 1.0 at the latest).
- **Owner:**

## Owner checklist (manual actions, in order)

1. Reserve the npm package name and enable 2FA; later configure trusted publishing and staged publishing (P1-15).
2. Repository settings: rulesets (no force push or deletion, PRs required, squash merges, required checks), secret
   scanning and push protection, private vulnerability reporting, Dependabot alerts, read-only default Actions
   permissions, approval for first-time contributors' workflows (P0-03, P0-04).
3. Environments: `live` (reviewers, `main` only, `AB_LIVE_*` secrets), `release` (reviewers, `main` and tags), `staging`
   (Phase 3).
4. Agility sandbox (D-01): instance, reader and writer members, access tokens, seed data (P0-12).
5. Optional on-premises test instance (P0-06).
6. Client accounts for verification: GitHub Copilot (VS Code, JetBrains, CLI), Claude (a plan with custom connectors),
   Cursor, Windsurf/Devin Desktop (P0-07, P5-06).
7. Cloudflare account (Free, optionally Paid) and a custom domain for staging (P0-09, Phase 3).
8. Identity-provider apps: Google OAuth client, GitHub OAuth app, optionally Cloudflare Access and a test OIDC provider
   (P4-01).
9. Container registry visibility and image signing (P2-11).
10. MCP Registry namespace (P1-15, P8-06) and OpenSSF Best Practices project (P9-06).
11. Documentation site hosting (P9-04).

## Decisions already taken (2026-10-16)

| Topic | Decision | Recorded in |
|---|---|---|
| Name | `agility-bridge`; `AB_` variables; `ab_` device tokens | ADR-0002 |
| Plan format | ADRs + per-phase task files in Markdown | ADR-0001 |
| License | Apache-2.0 with DCO | ADR-0003 |
| Architecture | Same as planned for every runtime; stdio, Node/Docker and Cloudflare Worker in 1.0 | ADR-0004, ADR-0005 |
| Writes | Read-only by default; typed writes opt-in per workspace/grant; human approval by default | ADR-0013 |
| Generic reads | Typed tools plus a validated generic query tool; no raw passthrough | ADR-0012 |
| Tokens | Bring-your-own by default; shared tokens read-only only; writes with the caller's own token | ADR-0008 |
| Installations | Hosted and on-premises; HTTPS except loopback; custom CA bundles | ADR-0014 |
| Clients | Copilot (VS Code, JetBrains, CLI), Claude (Code, Desktop, web, mobile), Cursor, Windsurf, MCP Inspector documented equally | ADR-0016 |
| Lessons | Standalone, source-neutral LESSONS-LEARNED.md, cross-referenced from ADRs and tasks | LESSONS-LEARNED.md |
