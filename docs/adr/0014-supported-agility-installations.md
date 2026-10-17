# ADR-0014 — Supported Agility installations: hosted and on-premises

- **Status:** accepted (owner, 2026-10-16); minimum on-premises version pending P0-06
- **Date:** 2026-10-16
- **Related:** P0-06, P1-02, P2-13, P3-07, L-054, L-055, THREAT_MODEL A9

## Context

Hosted (SaaS) instances use URLs like `https://www{N}.v1host.com/{InstanceName}`; on-premises installations use a
customer-chosen base URL, sometimes with an internal CA and older versions. Agility supports access tokens, Basic
authentication, Windows Integrated Authentication (on-premises) and OAuth2 grants for API calls.

## Decision

- **Both hosted and on-premises instances are supported.**
- **Base URL rules**: HTTPS required (plain HTTP only for loopback in tests); no user info, query or fragment; the path
  (instance name) is preserved; normalised without a trailing slash; defined only by owners/admins (or the operator's
  environment in stdio mode), never by an MCP request. Once credentials exist, an instance's origin and TLS trust can
  only be changed by an owner after a recent sign-in, and the change revokes that instance's credentials (THREAT_MODEL
  A14).
- **TLS**: certificate verification is never disabled. On Node, a custom CA bundle can be configured per instance
  (`AB_CA_FILE`, or `NODE_EXTRA_CA_CERTS`). Cloudflare Workers can reach only publicly trusted, internet-reachable
  instances; on-premises instances behind a private network or private CA need the Node/Docker deployment (or a tunnel).
- **Authentication to Agility**: **access tokens only** in 1.0 (`Authorization: Bearer <token>`). Basic authentication
  and Windows Integrated Authentication are not supported (security and runtime portability); Agility OAuth2 grants may
  be evaluated after 1.0.
- **Versions**: current hosted releases are the primary target (26.x at the time of writing); the oldest supported
  on-premises version is set after P0-06 and documented in the support policy.
- **Redirects** from the instance are not followed with credentials; a redirect to another origin is an error that
  explains the likely misconfiguration.

## Consequences

- One code path for every instance; on-premises specifics are configuration, not forks.
- Instances requiring Basic or NTLM only are out of scope.

## Alternatives considered

- **Hosted only:** rejected by the owner.
- **Allowing `rejectUnauthorized: false`:** rejected; custom CA bundles cover the legitimate cases.
