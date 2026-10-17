# ADR-0008 — Access model: instances, credentials, workspaces, grants and device tokens

- **Status:** accepted for the token policy (owner, 2026-10-16); details proposed, refined in P2-04
- **Date:** 2026-10-16
- **Related:** [ARCHITECTURE.md](../ARCHITECTURE.md) §4, P2-04, P2-05, P2-13, P4-07, L-062 – L-070, THREAT_MODEL T3, A5,
  A6

## Context

A shared deployment serves several teams, devices and Agility instances. Agility access tokens have no scopes: a token
can do everything its member can do, and every change is recorded in Agility under that member. A shared token would
widen what everyone sees and make every change look like it came from one account.

## Decision

Entities:

- **Instance** — an Agility base URL defined by an owner or admin (with TLS options). Members can never add instance
  URLs; they only attach tokens to existing instances (this also closes the SSRF path through user-supplied URLs). The
  origin and TLS trust of an instance are immutable while credentials exist: changing them is owner-only, needs a recent
  sign-in and revokes every credential and grant of that instance, so a rogue admin cannot redirect stored tokens to
  another server (THREAT_MODEL A14).
- **Credential** — an Agility access token for one instance, encrypted (ADR-0007), either **personal** (owned by a user;
  bring-your-own-token) or **shared** (owned by the deployment, e.g. a dedicated service member). Validated on save:
  member id, name and reachable Agility projects are recorded.
- **Workspace** — what an MCP URL (`/w/{slug}/mcp`) exposes: one instance, allowed Agility projects (scopes/planning
  levels, optionally with their descendants), allowed asset types, enabled tools, limits, an optional default shared
  credential, and its write policy.
- **Grant** — who (a user, or a labelled service) may use which workspace, with which credential, which tools, Agility
  projects, asset types, limits, rate limits and expiry.
- **Device token / OAuth device** — how a grant is presented; one per device, revocable individually.

Token policy (owner decision):

- **Bring-your-own-token is the default** for user grants: the grant uses the user's own personal credential for that
  instance.
- **Shared credentials are allowed only for read-only grants.** A grant using a shared credential can never be given
  write tools.
- **Writes always use the caller's own token**, so Agility history attributes each change to the person who approved it.

Effective permissions for a request:

```
tools      = workspace.enabledTools ∩ grant.tools          (write tools: both list them explicitly, writes are enabled
                                                          on the server, and the credential is the grant user's own)
projects   = workspace.allowedProjects ∩ grant.projects    (∩ what the token's member can see, enforced by Agility)
assetTypes = workspace.assetTypes ∩ grant.assetTypes
credential = grant.credential (personal) ?? workspace.defaultCredential (shared, read-only grants only)
limits     = workspace.limits tightened by grant.limits    (numbers: min; allow lists: ∩; deny lists: ∪)
```

Anything missing, disabled, revoked, expired, unvalidated or malformed denies. Tools outside the effective set are not
listed and are refused if called. Every alternate writer (admin API, CLI, import, panel) applies the same owner/admin
guards.

## Consequences

- Agility's own permissions remain the ceiling, and the server narrows them further per workspace and grant.
- Attribution in Agility is per person for writes; reads through a shared credential are attributed in our audit log
  only.
- Teams must create personal tokens (documented with screenshots); members manage their own tokens in the panel (P4-07).

## Alternatives considered

- **Shared token for everything:** rejected (visibility widening, attribution loss).
- **Pass-through only (each request carries a token):** kept as an optional, off-by-default workspace setting (P2-14):
  the caller's Agility token replaces the device token on the workspace's normal URL, every workspace control still
  applies, and it stays read-only in 1.0; it offers no per-user grants or OAuth.
