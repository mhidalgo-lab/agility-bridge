# OWASP ASVS 5.0 Level 2 mapping

> P9-06, 2026-11-03. The requirements are those of **ASVS 5.0.0** marked Level 1 or Level 2 (253 of the 345): the
> official CSV of release `v5.0.0`, <https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv>
> (fetched 2026-11-03; the project page is <https://owasp.org/www-project-application-security-verification-standard/>).
> Each row names the code, test or document that backs it; the claims about tests are the ones in the
> [threat evidence map](threat-evidence.md), which a test keeps true. This page is checked by
> `scripts/test/asvs-l2.test.ts` (every Level 1 and 2 requirement present once, every linked file exists).

This is a **self-assessment**, not a certification. Level 3 is out of scope. No external assessor has reviewed it yet
(P9-02 is the external review).

## Result

| Status | Meaning | Requirements |
|---|---|---|
| Met | Implemented, with evidence linked. | 175 |
| Partly | Implemented in the product; a part is not tested or sits with the operator (named in the row). | 7 |
| Delegated | The control belongs to the platform, the identity provider or the operator; the product documents it. | 5 |
| N/A | The feature the requirement is about does not exist in this product (reason given). | 66 |
| Gap | Not met; a task exists. | 0 |
| **Total** | | **253** |

No requirement is a `Gap`. The `Partly` rows are the work list for the hardening that remains: the section notes say what is
missing, and [P9-09](../tasks/phase-9-hardening-launch/P9-09-asvs-partial-rows.md) turns them into checks and tests.

## Requirements

### V1 Encoding and Sanitization

#### V1.1 Encoding and Sanitization Architecture

Untrusted text is decoded once (entities in `htmlToText`) and encoded at the output boundary; the panel escapes every value (`scripts/check-ui-escaping.ts`).

| Req | L | Status | Evidence |
|---|---|---|---|
| V1.1.1 | 2 | Met | [rich text](../../packages/core/src/output/text.ts), [output formats](../../packages/core/src/output/format.ts) |
| V1.1.2 | 2 | Met | [rich text](../../packages/core/src/output/text.ts), [output formats](../../packages/core/src/output/format.ts) |

#### V1.2 Injection Prevention

No SQL, LDAP, XPath, LaTeX or OS interpreter is fed untrusted text: Agility queries use bound values (ADR-0012), storage uses a typed query builder, CSV cells are neutralised, panel output is escaped JSX, `spawnSync` takes an argument array. Regex input is never user-built.

| Req | L | Status | Evidence |
|---|---|---|---|
| V1.2.1 | 1 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [output formats](../../packages/core/src/output/format.ts), [rich text](../../packages/core/src/output/text.ts), [threat evidence](../../docs/security/threat-evidence.md) |
| V1.2.2 | 1 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [output formats](../../packages/core/src/output/format.ts), [rich text](../../packages/core/src/output/text.ts), [threat evidence](../../docs/security/threat-evidence.md) |
| V1.2.3 | 1 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [output formats](../../packages/core/src/output/format.ts), [rich text](../../packages/core/src/output/text.ts), [threat evidence](../../docs/security/threat-evidence.md) |
| V1.2.4 | 1 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [output formats](../../packages/core/src/output/format.ts), [rich text](../../packages/core/src/output/text.ts), [threat evidence](../../docs/security/threat-evidence.md) |
| V1.2.5 | 1 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [output formats](../../packages/core/src/output/format.ts), [rich text](../../packages/core/src/output/text.ts), [threat evidence](../../docs/security/threat-evidence.md) |
| V1.2.6 | 2 | N/A | No LDAP. |
| V1.2.7 | 2 | N/A | No XPath. |
| V1.2.8 | 2 | N/A | No LaTeX. |
| V1.2.9 | 2 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [output formats](../../packages/core/src/output/format.ts), [rich text](../../packages/core/src/output/text.ts), [threat evidence](../../docs/security/threat-evidence.md) |

#### V1.3 Sanitization

No `eval`, templates or SVG from users. Rich text is converted to plain text with a fixed grammar; SSRF is controlled for every fetched URL (T11, A9).

| Req | L | Status | Evidence |
|---|---|---|---|
| V1.3.1 | 1 | Met | [rich text](../../packages/core/src/output/text.ts) Rich text from Agility is converted to plain text (no HTML out). |
| V1.3.2 | 1 | Met | [rich text](../../packages/core/src/output/text.ts), [envelope](../../packages/core/src/output/envelope.ts), [instance URLs](../../packages/core/src/agility/instance.ts), [threat model](../../docs/THREAT_MODEL.md) |
| V1.3.3 | 2 | Met | [rich text](../../packages/core/src/output/text.ts), [envelope](../../packages/core/src/output/envelope.ts), [instance URLs](../../packages/core/src/agility/instance.ts), [threat model](../../docs/THREAT_MODEL.md) |
| V1.3.4 | 2 | N/A | No user-supplied SVG is rendered. |
| V1.3.5 | 2 | Met | [rich text](../../packages/core/src/output/text.ts), [envelope](../../packages/core/src/output/envelope.ts), [instance URLs](../../packages/core/src/agility/instance.ts), [threat model](../../docs/THREAT_MODEL.md) |
| V1.3.6 | 2 | Met | [rich text](../../packages/core/src/output/text.ts), [envelope](../../packages/core/src/output/envelope.ts), [instance URLs](../../packages/core/src/agility/instance.ts), [threat model](../../docs/THREAT_MODEL.md) |
| V1.3.7 | 2 | N/A | No server-side templates built from input. |
| V1.3.8 | 2 | N/A | No JNDI. |
| V1.3.9 | 2 | N/A | No memcache. |
| V1.3.10 | 2 | N/A | No format strings from input. |
| V1.3.11 | 2 | N/A | No SMTP or IMAP. |

#### V1.4 Memory, String, and Unmanaged Code

TypeScript on V8 and Node: memory-safe, no unmanaged code.

| Req | L | Status | Evidence |
|---|---|---|---|
| V1.4.1 | 2 | N/A | section note above |
| V1.4.2 | 2 | N/A | section note above |
| V1.4.3 | 2 | N/A | section note above |

#### V1.5 Safe Deserialization

Document types and entities are refused in XML; configuration import is a strict schema; no native deserialization of untrusted objects.

| Req | L | Status | Evidence |
|---|---|---|---|
| V1.5.1 | 1 | Met | [XML parser](../../packages/core/src/agility/xml.ts), [config bundle](../../apps/cli/src/manage/config-bundle.ts) |
| V1.5.2 | 2 | Met | [XML parser](../../packages/core/src/agility/xml.ts), [config bundle](../../apps/cli/src/manage/config-bundle.ts) |

### V2 Validation and Business Logic

#### V2.1 Validation and Business Logic Documentation

Validation rules, limits and per-user/global caps are documented (query limits, tool conventions, write limits).

| Req | L | Status | Evidence |
|---|---|---|---|
| V2.1.1 | 1 | Met | [query limits guide](../../docs/guide/query-limits.md), [tool conventions](../../docs/dev/tool-conventions.md), [ADR-0015](../../docs/adr/0015-tool-output-contract.md) |
| V2.1.2 | 2 | Met | [query limits guide](../../docs/guide/query-limits.md), [tool conventions](../../docs/dev/tool-conventions.md), [ADR-0015](../../docs/adr/0015-tool-output-contract.md) |
| V2.1.3 | 2 | Met | [query limits guide](../../docs/guide/query-limits.md), [tool conventions](../../docs/dev/tool-conventions.md), [ADR-0015](../../docs/adr/0015-tool-output-contract.md) |

#### V2.2 Input Validation

Every tool input is a strict schema validated server-side against allowlists and instance metadata; combinations (asset type with attribute, operator with kind) are checked.

| Req | L | Status | Evidence |
|---|---|---|---|
| V2.2.1 | 1 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [metadata parser](../../packages/core/src/metadata/model.ts), [tool conventions](../../docs/dev/tool-conventions.md) |
| V2.2.2 | 1 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [metadata parser](../../packages/core/src/metadata/model.ts), [tool conventions](../../docs/dev/tool-conventions.md) |
| V2.2.3 | 2 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [metadata parser](../../packages/core/src/metadata/model.ts), [tool conventions](../../docs/dev/tool-conventions.md) |

#### V2.3 Business Logic Security

Writes are a fixed sequence (enabled, approval, intent audit, one request, outcome); one target per mutation; a stored approval is single-use; limits per grant and deployment.

| Req | L | Status | Evidence |
|---|---|---|---|
| V2.3.1 | 1 | Met | [write pipeline](../../packages/core/src/writes/pipeline.ts), [write tools guide](../../docs/guide/write-tools.md), [ADR-0013](../../docs/adr/0013-opt-in-writes-human-approval.md) |
| V2.3.2 | 2 | Met | [write pipeline](../../packages/core/src/writes/pipeline.ts), [write tools guide](../../docs/guide/write-tools.md), [ADR-0013](../../docs/adr/0013-opt-in-writes-human-approval.md) |
| V2.3.3 | 2 | Met | [write pipeline](../../packages/core/src/writes/pipeline.ts), [write tools guide](../../docs/guide/write-tools.md), [ADR-0013](../../docs/adr/0013-opt-in-writes-human-approval.md) |
| V2.3.4 | 2 | N/A | No limited-quantity resources to double-book. |

#### V2.4 Anti-automation

Per-address, per-token, per-grant, per-workspace and per-call budgets; OAuth endpoints have their own flood caps.

| Req | L | Status | Evidence |
|---|---|---|---|
| V2.4.1 | 2 | Met | [rate limits](../../packages/http-app/src/rate-limit.ts), [OAuth abuse controls](../../packages/http-app/src/oauth/abuse.ts), [quota and limiter](../../packages/core/src/agility/quota.ts), [Cloudflare limits guide](../../docs/guide/cloudflare-limits.md) |

### V3 Web Frontend Security

#### V3.2 Unintended Content Interpretation

Every response has `nosniff` and a correct content type; panel text is rendered through escaped JSX, never as HTML strings.

| Req | L | Status | Evidence |
|---|---|---|---|
| V3.2.1 | 1 | Met | [panel headers](../../packages/admin-ui/src/headers.ts), [edge headers and host checks](../../packages/http-app/src/edge.ts) |
| V3.2.2 | 1 | Met | [panel headers](../../packages/admin-ui/src/headers.ts), [edge headers and host checks](../../packages/http-app/src/edge.ts) |

#### V3.3 Cookie Setup

`__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax` on https; plain name only on http loopback.

| Req | L | Status | Evidence |
|---|---|---|---|
| V3.3.1 | 1 | Met | [sessions](../../packages/auth/src/identity/session.ts), [admin access guide](../../docs/guide/admin-access.md) |
| V3.3.2 | 2 | Met | [sessions](../../packages/auth/src/identity/session.ts), [admin access guide](../../docs/guide/admin-access.md) |
| V3.3.3 | 2 | Met | [sessions](../../packages/auth/src/identity/session.ts), [admin access guide](../../docs/guide/admin-access.md) |
| V3.3.4 | 2 | Met | [sessions](../../packages/auth/src/identity/session.ts), [admin access guide](../../docs/guide/admin-access.md) |

#### V3.4 Browser Security Mechanism Headers

HSTS on https, a strict CSP with `frame-ancestors`, `nosniff`, `Referrer-Policy` on every response; no CORS except listed origins.

| Req | L | Status | Evidence |
|---|---|---|---|
| V3.4.1 | 1 | Met | [edge headers and host checks](../../packages/http-app/src/edge.ts), [panel headers](../../packages/admin-ui/src/headers.ts) |
| V3.4.2 | 1 | Met | [edge headers and host checks](../../packages/http-app/src/edge.ts) No CORS headers unless an origin is configured, then a fixed match. |
| V3.4.3 | 2 | Met | [edge headers and host checks](../../packages/http-app/src/edge.ts), [panel headers](../../packages/admin-ui/src/headers.ts) |
| V3.4.4 | 2 | Met | [edge headers and host checks](../../packages/http-app/src/edge.ts), [panel headers](../../packages/admin-ui/src/headers.ts) |
| V3.4.5 | 2 | Met | [edge headers and host checks](../../packages/http-app/src/edge.ts), [panel headers](../../packages/admin-ui/src/headers.ts) |
| V3.4.6 | 2 | Met | [edge headers and host checks](../../packages/http-app/src/edge.ts), [panel headers](../../packages/admin-ui/src/headers.ts) |

#### V3.5 Browser Origin Separation

State changes are POST with CSRF tokens and fetch-metadata checks; the MCP endpoint checks `Origin` and `Host`; the App view accepts messages from its parent window only.

| Req | L | Status | Evidence |
|---|---|---|---|
| V3.5.1 | 1 | Met | [panel headers](../../packages/admin-ui/src/headers.ts), [MCP request checks](../../packages/http-app/src/mcp-request.ts) |
| V3.5.2 | 1 | Met | [panel headers](../../packages/admin-ui/src/headers.ts), [MCP request checks](../../packages/http-app/src/mcp-request.ts) |
| V3.5.3 | 1 | Met | [panel headers](../../packages/admin-ui/src/headers.ts), [MCP request checks](../../packages/http-app/src/mcp-request.ts) |
| V3.5.4 | 2 | Met | [panel headers](../../packages/admin-ui/src/headers.ts) Panel, OAuth pages and MCP share one origin by design, with the strict CSP and host checks; the App view is sandboxed on the host's origin. |
| V3.5.5 | 2 | Met | [threat evidence](../../docs/security/threat-evidence.md) The view script accepts a message only from its parent window. |

#### V3.7 Other Browser Security Considerations

No legacy client technologies; the return address after sign-in must be a local path (`//host` and `/\` are refused, tested in `identity.test.ts`); OAuth redirects go only to registered URIs.

| Req | L | Status | Evidence |
|---|---|---|---|
| V3.7.1 | 2 | Met | [sign-in routes](../../packages/http-app/src/identity.ts), [OAuth server](../../packages/http-app/src/oauth/server.ts) |
| V3.7.2 | 2 | Met | [sign-in routes](../../packages/http-app/src/identity.ts), [OAuth server](../../packages/http-app/src/oauth/server.ts) |

### V4 API and Web Service

#### V4.1 Generic Web Service Security

Responses carry a content type; HTTP to HTTPS redirects are the deployment layer (Cloudflare, proxy); forwarded headers are trusted only from a configured proxy.

| Req | L | Status | Evidence |
|---|---|---|---|
| V4.1.1 | 1 | Met | [edge headers and host checks](../../packages/http-app/src/edge.ts), [MCP request checks](../../packages/http-app/src/mcp-request.ts) |
| V4.1.2 | 2 | Delegated | [self-hosting guide](../../docs/guide/self-hosting.md) HTTP to HTTPS redirects are made by the platform or proxy; the self-hosting guide requires it. |
| V4.1.3 | 2 | Met | [edge headers and host checks](../../packages/http-app/src/edge.ts) Forwarded headers are used only from a trusted proxy configuration. |

#### V4.2 HTTP Message Structure Validation

Body length is capped (declared and streamed), batches and wrong content types are refused.

| Req | L | Status | Evidence |
|---|---|---|---|
| V4.2.1 | 2 | Met | [MCP request checks](../../packages/http-app/src/mcp-request.ts) |

#### V4.3 GraphQL

No GraphQL. The MCP query tools have their own cost and limit controls (T5).

| Req | L | Status | Evidence |
|---|---|---|---|
| V4.3.1 | 2 | N/A | section note above |
| V4.3.2 | 2 | N/A | section note above |

#### V4.4 WebSocket

No WebSocket. Streamable HTTP uses the same authentication per request.

| Req | L | Status | Evidence |
|---|---|---|---|
| V4.4.1 | 1 | N/A | section note above |
| V4.4.2 | 2 | N/A | section note above |
| V4.4.3 | 2 | N/A | section note above |
| V4.4.4 | 2 | N/A | section note above |

### V5 File Handling

#### V5.1 File Handling Documentation

The server accepts no file uploads. Attachment download is documented in the write and tool guides.

| Req | L | Status | Evidence |
|---|---|---|---|
| V5.1.1 | 2 | N/A | section note above |

#### V5.2 File Upload and Content

No file upload. Attachment downloads are size-counted on the stream and refused above the cap (A8).

| Req | L | Status | Evidence |
|---|---|---|---|
| V5.2.1 | 1 | N/A | section note above |
| V5.2.2 | 1 | N/A | section note above |
| V5.2.3 | 2 | N/A | section note above |

#### V5.3 File Storage

No uploaded files are stored or served; database and backup paths are fixed or operator-set (T35).

| Req | L | Status | Evidence |
|---|---|---|---|
| V5.3.1 | 1 | N/A | section note above |
| V5.3.2 | 1 | N/A | section note above |

#### V5.4 File Download

No file is served: attachment content is returned as text inside the envelope and no file name reaches a header (A8).

| Req | L | Status | Evidence |
|---|---|---|---|
| V5.4.1 | 2 | N/A | section note above |
| V5.4.2 | 2 | N/A | section note above |
| V5.4.3 | 2 | N/A | section note above |

### V6 Authentication

#### V6.1 Authentication Documentation

Rate limits and authentication pathways are documented (device tokens, OAuth, IdP sign-in, break-glass admin token, pass-through).

| Req | L | Status | Evidence |
|---|---|---|---|
| V6.1.1 | 1 | Met | [threat model](../../docs/THREAT_MODEL.md), [rate limits](../../packages/http-app/src/rate-limit.ts), [identity providers guide](../../docs/guide/identity-providers.md) |
| V6.1.2 | 2 | N/A | No passwords. |
| V6.1.3 | 2 | Met | [admin access guide](../../docs/guide/admin-access.md) Pathways are documented together. |

#### V6.2 Password Security

The project stores and checks no passwords: people sign in through an identity provider and tools use random 256-bit tokens.

| Req | L | Status | Evidence |
|---|---|---|---|
| V6.2.1 | 1 | N/A | section note above |
| V6.2.2 | 1 | N/A | section note above |
| V6.2.3 | 1 | N/A | section note above |
| V6.2.4 | 1 | N/A | section note above |
| V6.2.5 | 1 | N/A | section note above |
| V6.2.6 | 1 | N/A | section note above |
| V6.2.7 | 1 | N/A | section note above |
| V6.2.8 | 1 | N/A | section note above |
| V6.2.9 | 2 | N/A | section note above |
| V6.2.10 | 2 | N/A | section note above |
| V6.2.11 | 2 | N/A | section note above |
| V6.2.12 | 2 | N/A | section note above |

#### V6.3 General Authentication Security

Brute force on tokens is throttled and tokens are 256-bit; there are no default accounts (the break-glass token is generated, shown once, and refused when weak). Multi-factor is the identity provider's job (delegated) and is documented as an operator choice.

| Req | L | Status | Evidence |
|---|---|---|---|
| V6.3.1 | 1 | Met | [rate limits](../../packages/http-app/src/rate-limit.ts), [OAuth abuse controls](../../packages/http-app/src/oauth/abuse.ts) Failed-attempt throttling per address on device, admin and OAuth endpoints. |
| V6.3.2 | 1 | Met | [admin access guide](../../docs/guide/admin-access.md) No default accounts: the first owner signs in through the IdP, the break-glass token is generated once. |
| V6.3.3 | 2 | Delegated | [identity providers guide](../../docs/guide/identity-providers.md) Multi-factor is enforced by the identity provider the operator configures; the guide recommends it. |
| V6.3.4 | 2 | Met | [threat model](../../docs/THREAT_MODEL.md), [access model guide](../../docs/guide/access-model.md) Every pathway is listed in the threat model and the access guide; none is undocumented. |

#### V6.4 Authentication Factor Lifecycle and Recovery

No passwords, hints or recovery flows. A lost token is revoked and a new one issued by its owner or an admin.

| Req | L | Status | Evidence |
|---|---|---|---|
| V6.4.1 | 1 | N/A | section note above |
| V6.4.2 | 1 | N/A | section note above |
| V6.4.3 | 2 | N/A | section note above |
| V6.4.4 | 2 | N/A | section note above |

#### V6.5 General Multi-factor authentication requirements

No MFA factors, lookup secrets or OTPs are implemented; consent and approval links are random, single-use and expire (see V10.4.2, V7.x).

| Req | L | Status | Evidence |
|---|---|---|---|
| V6.5.1 | 2 | N/A | section note above |
| V6.5.2 | 2 | N/A | section note above |
| V6.5.3 | 2 | N/A | section note above |
| V6.5.4 | 2 | N/A | section note above |
| V6.5.5 | 2 | N/A | section note above |

#### V6.6 Out-of-Band authentication mechanisms

No out-of-band OTP delivery.

| Req | L | Status | Evidence |
|---|---|---|---|
| V6.6.1 | 2 | N/A | section note above |
| V6.6.2 | 2 | N/A | section note above |
| V6.6.3 | 2 | N/A | section note above |

#### V6.8 Authentication with an Identity Provider

Identities are bound to (provider, subject); signature, issuer, audience, nonce and expiry are verified; recent sign-in is required for sensitive changes.

| Req | L | Status | Evidence |
|---|---|---|---|
| V6.8.1 | 2 | Met | [JWT verification](../../packages/auth/src/identity/jwt.ts), [OIDC client](../../packages/auth/src/identity/oidc.ts), [sign-in policy](../../packages/auth/src/identity/policy.ts), [login transactions](../../packages/auth/src/identity/login.ts) |
| V6.8.2 | 2 | Met | [JWT verification](../../packages/auth/src/identity/jwt.ts), [OIDC client](../../packages/auth/src/identity/oidc.ts), [sign-in policy](../../packages/auth/src/identity/policy.ts), [login transactions](../../packages/auth/src/identity/login.ts) |
| V6.8.3 | 2 | Met | [JWT verification](../../packages/auth/src/identity/jwt.ts), [OIDC client](../../packages/auth/src/identity/oidc.ts), [sign-in policy](../../packages/auth/src/identity/policy.ts), [login transactions](../../packages/auth/src/identity/login.ts) |
| V6.8.4 | 2 | Met | [JWT verification](../../packages/auth/src/identity/jwt.ts), [OIDC client](../../packages/auth/src/identity/oidc.ts), [sign-in policy](../../packages/auth/src/identity/policy.ts), [login transactions](../../packages/auth/src/identity/login.ts) |

### V7 Session Management

#### V7.1 Session Management Documentation

Idle (30 min) and absolute (12 h) limits are documented; concurrent sessions are allowed and listed.

| Req | L | Status | Evidence |
|---|---|---|---|
| V7.1.1 | 2 | Met | [admin access guide](../../docs/guide/admin-access.md), [sessions](../../packages/auth/src/identity/session.ts) |
| V7.1.2 | 2 | Met | [admin access guide](../../docs/guide/admin-access.md) Concurrent sessions are allowed (one per browser) and each ends on its own timeouts; "sign out everywhere" ends all. |
| V7.1.3 | 2 | Met | [identity providers guide](../../docs/guide/identity-providers.md) The only federated system is the configured IdP; documented. |

#### V7.2 Fundamental Session Management Security

Server-side sessions: a random id, only its hash is stored, verified in the backend; a new session on each sign-in.

| Req | L | Status | Evidence |
|---|---|---|---|
| V7.2.1 | 1 | Met | [sessions](../../packages/auth/src/identity/session.ts) |
| V7.2.2 | 1 | Met | [sessions](../../packages/auth/src/identity/session.ts) |
| V7.2.3 | 1 | Met | [sessions](../../packages/auth/src/identity/session.ts) |
| V7.2.4 | 1 | Met | [sessions](../../packages/auth/src/identity/session.ts) |

#### V7.3 Session Timeout

Idle timeout 30 minutes, absolute lifetime 12 hours, tested at the boundary.

| Req | L | Status | Evidence |
|---|---|---|---|
| V7.3.1 | 2 | Met | [sessions](../../packages/auth/src/identity/session.ts), [admin access guide](../../docs/guide/admin-access.md) |
| V7.3.2 | 2 | Met | [sessions](../../packages/auth/src/identity/session.ts), [admin access guide](../../docs/guide/admin-access.md) |

#### V7.4 Session Termination

Logout and "sign out everywhere" end sessions server-side; disabling a user ends theirs; administrators can end a user's sessions.

| Req | L | Status | Evidence |
|---|---|---|---|
| V7.4.1 | 1 | Met | [sessions](../../packages/auth/src/identity/session.ts), [owner guards](../../packages/auth/src/access/guards.ts), [admin access guide](../../docs/guide/admin-access.md) |
| V7.4.2 | 1 | Met | [sessions](../../packages/auth/src/identity/session.ts), [owner guards](../../packages/auth/src/access/guards.ts), [admin access guide](../../docs/guide/admin-access.md) |
| V7.4.3 | 2 | Met | [owner guards](../../packages/auth/src/access/guards.ts), [sessions](../../packages/auth/src/identity/session.ts) Sign out everywhere is offered; disabling and unbinding end sessions. |
| V7.4.4 | 2 | Met | [sessions](../../packages/auth/src/identity/session.ts), [owner guards](../../packages/auth/src/access/guards.ts), [admin access guide](../../docs/guide/admin-access.md) |
| V7.4.5 | 2 | Met | [sessions](../../packages/auth/src/identity/session.ts), [owner guards](../../packages/auth/src/access/guards.ts), [admin access guide](../../docs/guide/admin-access.md) |

#### V7.5 Defenses Against Session Abuse

A recent sign-in (re-authentication at the IdP) is required for sensitive changes; users can end every session but the panel lists devices, not individual browser sessions.

| Req | L | Status | Evidence |
|---|---|---|---|
| V7.5.1 | 2 | Met | [owner guards](../../packages/auth/src/access/guards.ts) Changes to who may sign in or to tokens need a recent sign-in. |
| V7.5.2 | 2 | Partly | [sessions](../../packages/auth/src/identity/session.ts) Users can end all their sessions ("sign out everywhere"); individual browser sessions are not listed. |

#### V7.6 Federated Re-authentication

A session is created only by an explicit sign-in callback bound to the browser (state, nonce, PKCE, binding cookie).

| Req | L | Status | Evidence |
|---|---|---|---|
| V7.6.1 | 2 | Met | [OIDC client](../../packages/auth/src/identity/oidc.ts), [login transactions](../../packages/auth/src/identity/login.ts) |
| V7.6.2 | 2 | Met | [OIDC client](../../packages/auth/src/identity/oidc.ts), [login transactions](../../packages/auth/src/identity/login.ts) |

### V8 Authorization

#### V8.1 Authorization Documentation

Function, data and field rules are documented in the access model guide and architecture.

| Req | L | Status | Evidence |
|---|---|---|---|
| V8.1.1 | 1 | Met | [access model guide](../../docs/guide/access-model.md), [architecture](../../docs/ARCHITECTURE.md) |
| V8.1.2 | 2 | Met | [access model guide](../../docs/guide/access-model.md), [architecture](../../docs/ARCHITECTURE.md) |

#### V8.2 General Authorization Design

One resolver, deny by default: tools, projects, asset types and fields are explicit per grant; a server-owned scope predicate on every query; output fields are allowlisted per tool.

| Req | L | Status | Evidence |
|---|---|---|---|
| V8.2.1 | 1 | Met | [access resolver](../../packages/auth/src/access/resolve.ts), [negative authorization matrix](../../packages/http-app/test/authz.test.ts), [query compiler](../../packages/core/src/query/compiler.ts) |
| V8.2.2 | 1 | Met | [access resolver](../../packages/auth/src/access/resolve.ts), [negative authorization matrix](../../packages/http-app/test/authz.test.ts), [query compiler](../../packages/core/src/query/compiler.ts) |
| V8.2.3 | 2 | Met | [access resolver](../../packages/auth/src/access/resolve.ts), [negative authorization matrix](../../packages/http-app/test/authz.test.ts), [query compiler](../../packages/core/src/query/compiler.ts) |

#### V8.3 Operation Level Authorization

Authorization is enforced in the server for every request; there is no client-supplied permission.

| Req | L | Status | Evidence |
|---|---|---|---|
| V8.3.1 | 1 | Met | [access resolver](../../packages/auth/src/access/resolve.ts), [negative authorization matrix](../../packages/http-app/test/authz.test.ts) |

#### V8.4 Other Authorization Considerations

Workspace-bound tokens (audience first), interleaving tests prove no cross-workspace data or credential mix.

| Req | L | Status | Evidence |
|---|---|---|---|
| V8.4.1 | 2 | Met | [access resolver](../../packages/auth/src/access/resolve.ts), [negative authorization matrix](../../packages/http-app/test/authz.test.ts), [threat evidence](../../docs/security/threat-evidence.md) |

### V9 Self-contained Tokens

#### V9.1 Token source and integrity

Only IdP JWTs are self-contained: signature always verified, an asymmetric allowlist, keys only from the issuer's own JWKS.

| Req | L | Status | Evidence |
|---|---|---|---|
| V9.1.1 | 1 | Met | [JWT verification](../../packages/auth/src/identity/jwt.ts) |
| V9.1.2 | 1 | Met | [JWT verification](../../packages/auth/src/identity/jwt.ts) |
| V9.1.3 | 1 | Met | [JWT verification](../../packages/auth/src/identity/jwt.ts) |

#### V9.2 Token content

Expiry, issuer, audience and type are checked; our own access tokens are opaque reference tokens bound to one workspace audience.

| Req | L | Status | Evidence |
|---|---|---|---|
| V9.2.1 | 1 | Met | [JWT verification](../../packages/auth/src/identity/jwt.ts), [OAuth server](../../packages/http-app/src/oauth/server.ts) |
| V9.2.2 | 2 | Met | [JWT verification](../../packages/auth/src/identity/jwt.ts), [OAuth server](../../packages/http-app/src/oauth/server.ts) |
| V9.2.3 | 2 | Met | [JWT verification](../../packages/auth/src/identity/jwt.ts), [OAuth server](../../packages/http-app/src/oauth/server.ts) |
| V9.2.4 | 2 | N/A | We do not issue JWTs to several audiences; access tokens are opaque and per workspace. |

### V10 OAuth and OIDC

#### V10.1 Generic OAuth and OIDC Security

Tokens go only to the MCP endpoint they are for; the authorization response is bound to our request (state, PKCE).

| Req | L | Status | Evidence |
|---|---|---|---|
| V10.1.1 | 2 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [OAuth guide](../../docs/guide/oauth-how-it-works.md) |
| V10.1.2 | 2 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [OAuth guide](../../docs/guide/oauth-how-it-works.md) |

#### V10.2 OAuth Client

The sign-in client uses state, PKCE and a browser-binding cookie; each provider has its own issuer check.

| Req | L | Status | Evidence |
|---|---|---|---|
| V10.2.1 | 2 | Met | [OIDC client](../../packages/auth/src/identity/oidc.ts), [login transactions](../../packages/auth/src/identity/login.ts) |
| V10.2.2 | 2 | Met | [OIDC client](../../packages/auth/src/identity/oidc.ts), [OAuth server](../../packages/http-app/src/oauth/server.ts) The sign-in client has one fixed issuer per provider; our authorization server publishes `iss` (RFC 9207). |

#### V10.3 OAuth Resource Server

The MCP resource server accepts only tokens for its own workspace audience (RFC 8707/9728) and decides by grant, not by token claims.

| Req | L | Status | Evidence |
|---|---|---|---|
| V10.3.1 | 2 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [access resolver](../../packages/auth/src/access/resolve.ts) |
| V10.3.2 | 2 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [access resolver](../../packages/auth/src/access/resolve.ts) |
| V10.3.3 | 2 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [access resolver](../../packages/auth/src/access/resolve.ts) |
| V10.3.4 | 2 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [access resolver](../../packages/auth/src/access/resolve.ts) |

#### V10.4 OAuth Authorization Server

Exact redirect match, single-use short-lived codes, PKCE S256 for all clients, refresh-token families with replay detection and absolute expiry, DCR with caps, revocation by the user and by admins.

| Req | L | Status | Evidence |
|---|---|---|---|
| V10.4.1 | 1 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [OAuth clients](../../packages/http-app/src/oauth/clients.ts), [OAuth abuse controls](../../packages/http-app/src/oauth/abuse.ts) |
| V10.4.2 | 1 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [OAuth clients](../../packages/http-app/src/oauth/clients.ts), [OAuth abuse controls](../../packages/http-app/src/oauth/abuse.ts) |
| V10.4.3 | 1 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [OAuth clients](../../packages/http-app/src/oauth/clients.ts), [OAuth abuse controls](../../packages/http-app/src/oauth/abuse.ts) |
| V10.4.4 | 1 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [OAuth clients](../../packages/http-app/src/oauth/clients.ts), [OAuth abuse controls](../../packages/http-app/src/oauth/abuse.ts) |
| V10.4.5 | 1 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [OAuth clients](../../packages/http-app/src/oauth/clients.ts), [OAuth abuse controls](../../packages/http-app/src/oauth/abuse.ts) |
| V10.4.6 | 2 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [OAuth clients](../../packages/http-app/src/oauth/clients.ts), [OAuth abuse controls](../../packages/http-app/src/oauth/abuse.ts) |
| V10.4.7 | 2 | Met | [OAuth abuse controls](../../packages/http-app/src/oauth/abuse.ts), [OAuth clients](../../packages/http-app/src/oauth/clients.ts) Dynamic registration is capped per address and per deployment, optionally limited to listed hosts, and unverified clients are labelled on the consent page. |
| V10.4.8 | 2 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [OAuth clients](../../packages/http-app/src/oauth/clients.ts), [OAuth abuse controls](../../packages/http-app/src/oauth/abuse.ts) |
| V10.4.9 | 2 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [OAuth clients](../../packages/http-app/src/oauth/clients.ts), [OAuth abuse controls](../../packages/http-app/src/oauth/abuse.ts) |
| V10.4.10 | 2 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts) Confidential clients authenticate at the token endpoint; public clients use PKCE. |
| V10.4.11 | 2 | Met | [OAuth server](../../packages/http-app/src/oauth/server.ts), [OAuth clients](../../packages/http-app/src/oauth/clients.ts), [OAuth abuse controls](../../packages/http-app/src/oauth/abuse.ts) |

#### V10.5 OIDC Client

Nonce, subject binding, issuer and audience checks on every ID token; no back-channel logout.

| Req | L | Status | Evidence |
|---|---|---|---|
| V10.5.1 | 2 | Met | [OIDC client](../../packages/auth/src/identity/oidc.ts), [JWT verification](../../packages/auth/src/identity/jwt.ts) |
| V10.5.2 | 2 | Met | [OIDC client](../../packages/auth/src/identity/oidc.ts), [JWT verification](../../packages/auth/src/identity/jwt.ts) |
| V10.5.3 | 2 | Met | [OIDC client](../../packages/auth/src/identity/oidc.ts), [JWT verification](../../packages/auth/src/identity/jwt.ts) |
| V10.5.4 | 2 | Met | [OIDC client](../../packages/auth/src/identity/oidc.ts), [JWT verification](../../packages/auth/src/identity/jwt.ts) |
| V10.5.5 | 2 | N/A | No back-channel logout. |

#### V10.6 OpenID Provider

The server is an OAuth authorization server for MCP clients, not an OpenID Provider (no ID tokens issued).

| Req | L | Status | Evidence |
|---|---|---|---|
| V10.6.1 | 2 | N/A | section note above |
| V10.6.2 | 2 | N/A | section note above |

#### V10.7 Consent Management

Every authorization needs an explicit consent page naming the client (marked unverified when dynamic) and scopes; users review and revoke under My access.

| Req | L | Status | Evidence |
|---|---|---|---|
| V10.7.1 | 2 | Met | [consent page](../../packages/http-app/src/oauth/consent.ts), [OAuth guide](../../docs/guide/oauth-how-it-works.md) |
| V10.7.2 | 2 | Met | [consent page](../../packages/http-app/src/oauth/consent.ts), [OAuth guide](../../docs/guide/oauth-how-it-works.md) |
| V10.7.3 | 2 | Met | [consent page](../../packages/http-app/src/oauth/consent.ts) My access lists connected apps and lets the user disconnect them. |

### V11 Cryptography

#### V11.1 Cryptographic Inventory and Documentation

The cryptographic inventory lists every key purpose, algorithm and rotation; the key lifecycle (versions, rotation, retirement) is documented and tested.

| Req | L | Status | Evidence |
|---|---|---|---|
| V11.1.1 | 2 | Met | [cryptography inventory](../../docs/security/cryptography.md), [keyring](../../packages/auth/src/secrets/keyring.ts) |
| V11.1.2 | 2 | Met | [cryptography inventory](../../docs/security/cryptography.md), [keyring](../../packages/auth/src/secrets/keyring.ts) |

#### V11.2 Secure Cryptography Implementation

WebCrypto and the platform only; purpose keys derived with HKDF; versioned keys make algorithm and key changes possible; 256-bit keys.

| Req | L | Status | Evidence |
|---|---|---|---|
| V11.2.1 | 2 | Met | [cryptography inventory](../../docs/security/cryptography.md), [keyring](../../packages/auth/src/secrets/keyring.ts) |
| V11.2.2 | 2 | Met | [keyring](../../packages/auth/src/secrets/keyring.ts) Key versions allow changing keys and encryption purposes without data loss (rotation tested). |
| V11.2.3 | 2 | Met | [cryptography inventory](../../docs/security/cryptography.md), [keyring](../../packages/auth/src/secrets/keyring.ts) |

#### V11.3 Encryption Algorithms

AES-256-GCM with a fresh IV and the record context as additional data; no ECB or padding schemes.

| Req | L | Status | Evidence |
|---|---|---|---|
| V11.3.1 | 1 | Met | [keyring](../../packages/auth/src/secrets/keyring.ts) |
| V11.3.2 | 1 | Met | [keyring](../../packages/auth/src/secrets/keyring.ts) |
| V11.3.3 | 2 | Met | [keyring](../../packages/auth/src/secrets/keyring.ts) |

#### V11.4 Hashing and Hash-based Functions

SHA-256 and HMAC-SHA-256 only; the config bundle derives its key with PBKDF2 (600,000 iterations); no password hashing is needed.

| Req | L | Status | Evidence |
|---|---|---|---|
| V11.4.1 | 1 | Met | [keyring](../../packages/auth/src/secrets/keyring.ts), [config bundle](../../apps/cli/src/manage/config-bundle.ts), [device tokens](../../packages/auth/src/tokens/device.ts) |
| V11.4.2 | 2 | N/A | No passwords are stored. |
| V11.4.3 | 2 | Met | [keyring](../../packages/auth/src/secrets/keyring.ts), [config bundle](../../apps/cli/src/manage/config-bundle.ts), [device tokens](../../packages/auth/src/tokens/device.ts) |
| V11.4.4 | 2 | Met | [config bundle](../../apps/cli/src/manage/config-bundle.ts) PBKDF2 for the config bundle passphrase only. |

#### V11.5 Random Values

Tokens, ids and keys come from `crypto.getRandomValues`.

| Req | L | Status | Evidence |
|---|---|---|---|
| V11.5.1 | 2 | Met | [device tokens](../../packages/auth/src/tokens/device.ts), [keyring](../../packages/auth/src/secrets/keyring.ts) |

#### V11.6 Public Key Cryptography

No key generation of our own; signatures are only verified, with allowlisted algorithms.

| Req | L | Status | Evidence |
|---|---|---|---|
| V11.6.1 | 2 | Met | [JWT verification](../../packages/auth/src/identity/jwt.ts) |

### V12 Secure Communication

#### V12.1 General TLS Security Guidance

On Workers and behind a reverse proxy, TLS versions and cipher suites are the platform's or the operator's. The Node server speaks HTTP on loopback by default and the guide requires a TLS proxy for anything else.

| Req | L | Status | Evidence |
|---|---|---|---|
| V12.1.1 | 1 | Delegated | [self-hosting guide](../../docs/guide/self-hosting.md), [Cloudflare limits guide](../../docs/guide/cloudflare-limits.md) |
| V12.1.2 | 2 | Delegated | [self-hosting guide](../../docs/guide/self-hosting.md), [Cloudflare limits guide](../../docs/guide/cloudflare-limits.md) |
| V12.1.3 | 2 | N/A | No mTLS client authentication. |

#### V12.2 HTTPS Communication with External Facing Services

Public endpoints are https with HSTS; no fallback; Workers use Cloudflare's trusted certificates.

| Req | L | Status | Evidence |
|---|---|---|---|
| V12.2.1 | 1 | Met | [edge headers and host checks](../../packages/http-app/src/edge.ts), [self-hosting guide](../../docs/guide/self-hosting.md) |
| V12.2.2 | 1 | Met | [edge headers and host checks](../../packages/http-app/src/edge.ts), [self-hosting guide](../../docs/guide/self-hosting.md) |

#### V12.3 General Service to Service Communication Security

Every outbound connection (Agility, IdPs, CIMD hosts, telemetry) is https with certificate validation; plain http only for loopback; custom CA only by an owner.

| Req | L | Status | Evidence |
|---|---|---|---|
| V12.3.1 | 2 | Met | [instance URLs](../../packages/core/src/agility/instance.ts), [Agility client](../../packages/core/src/agility/client.ts), [threat model](../../docs/THREAT_MODEL.md) |
| V12.3.2 | 2 | Met | [instance URLs](../../packages/core/src/agility/instance.ts), [Agility client](../../packages/core/src/agility/client.ts), [threat model](../../docs/THREAT_MODEL.md) |
| V12.3.3 | 2 | Met | [instance URLs](../../packages/core/src/agility/instance.ts), [Agility client](../../packages/core/src/agility/client.ts), [threat model](../../docs/THREAT_MODEL.md) |
| V12.3.4 | 2 | Met | [instance URLs](../../packages/core/src/agility/instance.ts) Custom CAs only by an owner, per instance. |

### V13 Configuration

#### V13.1 Configuration Documentation

All outbound and inbound communication is in the trust-boundary table (B1-B8).

| Req | L | Status | Evidence |
|---|---|---|---|
| V13.1.1 | 2 | Met | [threat model](../../docs/THREAT_MODEL.md), [architecture](../../docs/ARCHITECTURE.md) |

#### V13.2 Backend Communication Configuration

Backend credentials are per workspace and never defaults; outbound destinations are only configured instances, IdPs, CIMD hosts and the telemetry endpoint; redirects are refused.

| Req | L | Status | Evidence |
|---|---|---|---|
| V13.2.1 | 2 | Met | [instance URLs](../../packages/core/src/agility/instance.ts), [Agility client](../../packages/core/src/agility/client.ts), [threat model](../../docs/THREAT_MODEL.md) |
| V13.2.2 | 2 | Met | [instance URLs](../../packages/core/src/agility/instance.ts), [Agility client](../../packages/core/src/agility/client.ts), [threat model](../../docs/THREAT_MODEL.md) |
| V13.2.3 | 2 | Met | [instance URLs](../../packages/core/src/agility/instance.ts), [Agility client](../../packages/core/src/agility/client.ts), [threat model](../../docs/THREAT_MODEL.md) |
| V13.2.4 | 2 | Met | [instance URLs](../../packages/core/src/agility/instance.ts), [Agility client](../../packages/core/src/agility/client.ts), [threat model](../../docs/THREAT_MODEL.md) |
| V13.2.5 | 2 | Met | [instance URLs](../../packages/core/src/agility/instance.ts) Outbound requests go only to configured hosts; private addresses can be refused by setting. |

#### V13.3 Secret Management

The master key lives outside the data (environment, file or OS keychain; a Worker secret) and every Agility token is encrypted; the secrets manager itself is the operator's.

| Req | L | Status | Evidence |
|---|---|---|---|
| V13.3.1 | 2 | Partly | [secrets guide](../../docs/guide/secrets.md) Secrets are held by the operator's store (environment, file, OS keychain, Worker secret); encrypted tokens in the database. The project does not ship a key vault. |
| V13.3.2 | 2 | Partly | [secrets guide](../../docs/guide/secrets.md), [cryptography inventory](../../docs/security/cryptography.md) |

#### V13.4 Unintended Information Leakage

Only `dist` and `NOTICE` ship (checked on every release); no debug mode, listing, documentation or monitoring endpoint exists; probes for source-control, environment and debug paths get a fixed refusal with the standard headers (tested).

| Req | L | Status | Evidence |
|---|---|---|---|
| V13.4.1 | 1 | Met | [exposure test](../../packages/http-app/test/exposure.test.ts), [package file list check](../../scripts/check-package.ts) |
| V13.4.2 | 2 | Met | [exposure test](../../packages/http-app/test/exposure.test.ts), [package file list check](../../scripts/check-package.ts) |
| V13.4.3 | 2 | Met | [exposure test](../../packages/http-app/test/exposure.test.ts), [package file list check](../../scripts/check-package.ts) |
| V13.4.4 | 2 | Partly | [edge headers and host checks](../../packages/http-app/src/edge.ts) No `TRACE` handler exists and `TRACE` cannot even be built as a fetch `Request`; the Node listener adapter is not tested with a raw `TRACE`. |
| V13.4.5 | 2 | Met | [threat evidence](../../docs/security/threat-evidence.md) No documentation or monitoring endpoint is exposed unless opted in (public catalogue is off by default). |

### V14 Data Protection

#### V14.1 Data Protection Documentation

Sensitive data classes and their protections are in the threat model assets table and the data-protection inventory.

| Req | L | Status | Evidence |
|---|---|---|---|
| V14.1.1 | 2 | Met | [data protection](../../docs/security/data-protection.md), [threat model](../../docs/THREAT_MODEL.md) |
| V14.1.2 | 2 | Met | [data protection](../../docs/security/data-protection.md), [threat model](../../docs/THREAT_MODEL.md) |

#### V14.2 General Data Protection

No secret in a URL or query (tokens travel in headers); no secrets in logs, audit or output; the query cache is keyed per credential and off by default.

| Req | L | Status | Evidence |
|---|---|---|---|
| V14.2.1 | 1 | Met | [data protection](../../docs/security/data-protection.md), [redaction](../../packages/core/src/redact.ts), [audit](../../packages/http-app/src/audit.ts) |
| V14.2.2 | 2 | Met | [data protection](../../docs/security/data-protection.md), [redaction](../../packages/core/src/redact.ts), [audit](../../packages/http-app/src/audit.ts) |
| V14.2.3 | 2 | Met | [data protection](../../docs/security/data-protection.md), [redaction](../../packages/core/src/redact.ts), [audit](../../packages/http-app/src/audit.ts) |
| V14.2.4 | 2 | Met | [data protection](../../docs/security/data-protection.md), [redaction](../../packages/core/src/redact.ts), [audit](../../packages/http-app/src/audit.ts) |

#### V14.3 Client-side Data Protection

`Cache-Control: no-store` and `Clear-Site-Data` on sign-out; the panel keeps nothing in browser storage.

| Req | L | Status | Evidence |
|---|---|---|---|
| V14.3.1 | 1 | Met | [admin access guide](../../docs/guide/admin-access.md) Sign-out sends `Clear-Site-Data`. |
| V14.3.2 | 2 | Met | [panel headers](../../packages/admin-ui/src/headers.ts), [admin access guide](../../docs/guide/admin-access.md) |
| V14.3.3 | 2 | Met | [panel headers](../../packages/admin-ui/src/headers.ts), [admin access guide](../../docs/guide/admin-access.md) |

### V15 Secure Coding and Architecture

#### V15.1 Secure Coding and Architecture Documentation

Response time frames are in SECURITY.md; an SBOM is attached to every release.

| Req | L | Status | Evidence |
|---|---|---|---|
| V15.1.1 | 1 | Met | [SECURITY.md](../../SECURITY.md) Response time frames are stated in SECURITY.md; the support window for fixes is in the versioning guide. |
| V15.1.2 | 2 | Met | [release workflow](../../.github/workflows/release.yml) SBOM published with every release and the lockfile is frozen. |
| V15.1.3 | 2 | Met | [query limits guide](../../docs/guide/query-limits.md) Expensive functionality (composite reports, large queries) is declared with a cost and capped. |

#### V15.2 Security Architecture and Dependencies

Lockfile with a minimum release age, `pnpm audit`, dependency review and CodeQL on every PR; the Worker and image are built from pinned inputs.

| Req | L | Status | Evidence |
|---|---|---|---|
| V15.2.1 | 1 | Met | [security workflow](../../.github/workflows/security.yml) Renovate and audit gates; the release is blocked on known vulnerabilities. |
| V15.2.2 | 2 | Met | [quota and limiter](../../packages/core/src/agility/quota.ts) Per-call cost budgets, per-credential limiter and breaker, request caps. |
| V15.2.3 | 2 | Met | [threat model](../../docs/THREAT_MODEL.md) Optional features (writes, attachments, apps, tasks, public catalogue) are off by default and not exposed until enabled. |

#### V15.3 Defensive Coding

Tools return only their documented field subset; redirects are not followed; mutation fields are an allowlist per asset type; strict schemas reject unknown keys; maps and sets instead of object literals for untrusted keys.

| Req | L | Status | Evidence |
|---|---|---|---|
| V15.3.1 | 1 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [output formats](../../packages/core/src/output/format.ts), [Agility client](../../packages/core/src/agility/client.ts) |
| V15.3.2 | 2 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [output formats](../../packages/core/src/output/format.ts), [Agility client](../../packages/core/src/agility/client.ts) |
| V15.3.3 | 2 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [output formats](../../packages/core/src/output/format.ts), [Agility client](../../packages/core/src/agility/client.ts) |
| V15.3.4 | 2 | Met | [rate limits](../../packages/http-app/src/rate-limit.ts) The client address is taken from a trusted proxy header only when the deployment says so (Workers: `CF-Connecting-IP`). |
| V15.3.5 | 2 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [output formats](../../packages/core/src/output/format.ts), [Agility client](../../packages/core/src/agility/client.ts) |
| V15.3.6 | 2 | Met | [query compiler](../../packages/core/src/query/compiler.ts), [output formats](../../packages/core/src/output/format.ts), [Agility client](../../packages/core/src/agility/client.ts) |
| V15.3.7 | 2 | Partly | [consent page](../../packages/http-app/src/oauth/consent.ts), [OAuth server](../../packages/http-app/src/oauth/server.ts) Forms and OAuth parameters are read with explicit rules (a repeated CSRF field or `resource` is handled in the code); there is no general test that every endpoint treats repeated parameters the same. |

### V16 Security Logging and Error Handling

#### V16.1 Security Logging Documentation

The logging inventory lists every fixed message and audit column; a test keeps it complete.

| Req | L | Status | Evidence |
|---|---|---|---|
| V16.1.1 | 2 | Met | [logging inventory](../../docs/security/logging.md) |

#### V16.2 General Logging

Structured JSON to stderr with UTC time, request id, who and what; no secrets (redaction).

| Req | L | Status | Evidence |
|---|---|---|---|
| V16.2.1 | 2 | Met | [logger](../../packages/core/src/logger.ts), [audit](../../packages/http-app/src/audit.ts), [logging inventory](../../docs/security/logging.md) |
| V16.2.2 | 2 | Met | [logger](../../packages/core/src/logger.ts) Timestamps are UTC (ISO 8601 with Z). |
| V16.2.3 | 2 | Met | [logging inventory](../../docs/security/logging.md) Logs go to stderr only; audit rows to the database. |
| V16.2.4 | 2 | Met | [logger](../../packages/core/src/logger.ts), [audit](../../packages/http-app/src/audit.ts), [logging inventory](../../docs/security/logging.md) |
| V16.2.5 | 2 | Met | [logger](../../packages/core/src/logger.ts), [audit](../../packages/http-app/src/audit.ts), [logging inventory](../../docs/security/logging.md) |

#### V16.3 Security Events

Authentication failures, authorization refusals, admin changes and write intents and outcomes are audited.

| Req | L | Status | Evidence |
|---|---|---|---|
| V16.3.1 | 2 | Met | [audit](../../packages/http-app/src/audit.ts), [logging inventory](../../docs/security/logging.md) |
| V16.3.2 | 2 | Met | [audit](../../packages/http-app/src/audit.ts), [logging inventory](../../docs/security/logging.md) |
| V16.3.3 | 2 | Met | [audit](../../packages/http-app/src/audit.ts), [logging inventory](../../docs/security/logging.md) |
| V16.3.4 | 2 | Met | [audit](../../packages/http-app/src/audit.ts), [logging inventory](../../docs/security/logging.md) |

#### V16.4 Log Protection

Log lines are JSON-encoded (control characters cannot start a new line) and redacted; audit rows are append-only in the application (no update path); the sink's access control and shipping to a separate system belong to the operator.

| Req | L | Status | Evidence |
|---|---|---|---|
| V16.4.1 | 2 | Partly | [logger](../../packages/core/src/logger.ts), [audit](../../packages/http-app/src/audit.ts), [redaction](../../packages/core/src/redact.ts) |
| V16.4.2 | 2 | Partly | [logger](../../packages/core/src/logger.ts), [audit](../../packages/http-app/src/audit.ts), [redaction](../../packages/core/src/redact.ts) |
| V16.4.3 | 2 | Delegated | [logging inventory](../../docs/security/logging.md) The operator ships stderr and the audit table to their log system; the guide says how (OTel optional). |

#### V16.5 Error Handling

Generic, stable error codes with Agility text withheld; fail closed when storage, audit or limiter state is unavailable for a write; breaker and retry policy for upstream failures.

| Req | L | Status | Evidence |
|---|---|---|---|
| V16.5.1 | 2 | Met | [Agility client](../../packages/core/src/agility/client.ts), [write pipeline](../../packages/core/src/writes/pipeline.ts) |
| V16.5.2 | 2 | Met | [Agility client](../../packages/core/src/agility/client.ts), [write pipeline](../../packages/core/src/writes/pipeline.ts) |
| V16.5.3 | 2 | Met | [Agility client](../../packages/core/src/agility/client.ts), [write pipeline](../../packages/core/src/writes/pipeline.ts) |

### V17 WebRTC

#### V17.1 TURN Server

No WebRTC.

| Req | L | Status | Evidence |
|---|---|---|---|
| V17.1.1 | 2 | N/A | section note above |

#### V17.2 Media

No WebRTC.

| Req | L | Status | Evidence |
|---|---|---|---|
| V17.2.1 | 2 | N/A | section note above |
| V17.2.2 | 2 | N/A | section note above |
| V17.2.3 | 2 | N/A | section note above |
| V17.2.4 | 2 | N/A | section note above |

#### V17.3 Signaling

No WebRTC.

| Req | L | Status | Evidence |
|---|---|---|---|
| V17.3.1 | 2 | N/A | section note above |
| V17.3.2 | 2 | N/A | section note above |
