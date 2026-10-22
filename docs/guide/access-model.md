# Access model: who can use what

> Applies to the server (`agility-bridge serve`, v0.2, and later the Cloudflare Worker). The local stdio mode has one
> workspace, configured by its environment ([configuration](configuration.md)).

agility-bridge never gives anyone more than Agility gives the member behind the token, and narrows that further per
workspace and per grant ([ADR-0008](../adr/0008-access-model.md)).

| Thing | What it is | Who defines it |
|---|---|---|
| **Instance** | An Agility address (`https://…/YourInstance`) and its TLS trust | Owners and admins only; members never add URLs |
| **Credential** | An Agility access token for one instance, stored encrypted ([secrets](secrets.md)); **personal** (a member's own) or **shared** (a service member's) | Members add their own; admins add shared ones |
| **Workspace** | What one MCP address `/w/<slug>/mcp` exposes: an instance, its Agility projects, asset types, tools and limits, and optionally a default shared credential | Admins |
| **Grant** | Who may use a workspace (a user, or a labelled service), with which credential, and narrower tools, projects, asset types and limits; optional expiry | Admins |
| **Device token** | How a grant is presented by one device (`ab_live_…`); revocable one by one | Issued per device |

## What a request may do

For every request the server resolves, from scratch or from a cache of at most 60 seconds:

| Dimension | Effective value |
|---|---|
| Tools | the workspace's enabled tools (default: every read tool) **∩** the grant's tools (default: no narrowing) |
| Agility projects | the workspace's projects **∩** the grant's projects (exact ids), and Agility still applies the member's own visibility |
| Asset types | allow lists intersect (none = every type), deny lists add up |
| Limits | the workspace's values (default: the server's), capped by the runtime, then **lowered** by the grant: numbers take the minimum, switches such as member emails or the generic query tools stay on only if both leave them on |
| Credential | the grant's credential, or the workspace's default shared credential |

Anything missing, disabled, revoked, expired, not yet validated or malformed **denies**. Tools a caller may not use are
not even listed. A device token is bound to its workspace: used at another workspace's address, it is refused before
anything else is looked at.

## The token policy

- **Bring your own token is the default.** A user's grant uses that user's personal credential, so Agility shows each
  change under the person who made it and applies their permissions.
- **Shared credentials are read-only.** A grant that uses a shared credential (its own or the workspace default) never
  gets write tools, and service grants are always read-only.
- **Nobody uses another person's token.** A grant can name a shared credential or its own user's personal credential —
  never someone else's. Only that user can put a grant on their personal credential or issue device tokens for such a
  grant (a device token acts as them in Agility), and switching a grant to a personal credential revokes the grant's
  existing device tokens. Every way of changing configuration (the admin API, the CLI, imports) enforces this, and the
  database itself refuses to leave the server without an active owner or to un-revoke anything.
- **Write tools** (Phase 7) additionally need the server switch, the workspace's write policy, and both the workspace
  and the grant naming each write tool explicitly: "all tools" never includes a write tool.

## Warnings

Saving a grant that asks for more than it can get is accepted with warnings, because the workspace may change later:
tools the workspace does not enable, limits looser than the workspace's (the workspace's apply), switches the workspace
has off. Projects outside the workspace are refused. At request time the same mismatches are logged for the operator.

## Device tokens

Each device gets its own token, so losing a laptop means revoking one entry:

- Format `ab_live_<43 letters and digits>_<6-character checksum>` (`ab_test_…` on test deployments): 256 random bits; the
  checksum lets secret scanners (GitHub, gitleaks) recognise a leaked token and lets the server reject typos without a
  database lookup. It is not a security control.
- Shown **once** when issued. The server stores only its SHA-256 and a display prefix (`ab_live_` and the first four
  characters) for lists.
- Expires after **90 days** by default; tokens that never expire are possible, with a warning.
- Bound to one workspace: used at another workspace's address it is refused before anything else is checked.
- Revoking the token, its grant, its credential or its workspace stops it at the next request (or within the access
  cache's lifetime, at most 60 seconds, on other server processes).
- Its last use is recorded at most every five minutes.

## Credential validation

A credential is used only once Agility has confirmed it (status `valid`):

- **On save** (and when its token is replaced), the server asks Agility who the token belongs to and which Agility
  projects it can see, and records the member and those projects. The list is a hint for operators (a warning when a
  workspace names a project the member could not see); Agility still decides what each request returns.
- **On demand**: `agility-bridge credential validate <id>` or `POST /api/admin/v1/credentials/{id}/validate`.
- **Periodically**: every `AB_CREDENTIAL_REVALIDATION_HOURS` (default 24; `0` = never).
- **After repeated refusals**: three `AB_AGILITY_AUTH` errors in a row on one credential trigger a revalidation (at most
  every 10 minutes), so a revoked token is marked `invalid` instead of failing every call.

Results: `valid`; `invalid` with `AB_AGILITY_AUTH` (the token is revoked, mistyped or for another instance: create a new
one on the Agility *Applications* page), `AB_AGILITY_WRONG_INSTANCE` (the address answers with a redirect or a web
page: check the address you open Agility at) or `AB_AGILITY_TLS`; an outage or rate limit keeps the previous status and
records the code.

**New or changed instance addresses** are probed first with an unauthenticated `meta.v1` request: no token is ever sent
to an address that does not answer like Agility, and the change is refused (`502`) otherwise.
