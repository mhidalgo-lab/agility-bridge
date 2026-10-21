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
  never someone else's. Every way of changing configuration (the admin API, the CLI, imports) enforces this.
- **Write tools** (Phase 7) additionally need the server switch, the workspace's write policy, and both the workspace
  and the grant naming each write tool explicitly: "all tools" never includes a write tool.

## Warnings

Saving a grant that asks for more than it can get is accepted with warnings, because the workspace may change later:
tools the workspace does not enable, limits looser than the workspace's (the workspace's apply), switches the workspace
has off. Projects outside the workspace are refused. At request time the same mismatches are logged for the operator.
