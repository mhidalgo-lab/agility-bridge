---
"agility-bridge": minor
---

Add the OAuth 2.1 authorization server for MCP clients (P5-01), off by default: RFC 8414 metadata, `/oauth/authorize`, `/oauth/token` (code, refresh and RFC 7009 revocation) and `/oauth/register`, with PKCE S256 for every client, RFC 8707 resources bound to one workspace, RFC 9207 `iss`, single-use codes, hash-only token storage in the database and OAuth access tokens accepted on `/w/{slug}/mcp` through the same access resolver as device tokens. New settings `AB_OAUTH`, `AB_OAUTH_ACCESS_TTL` and `AB_OAUTH_REFRESH_TTL`; `AB_OAUTH=on` is refused until the consent screen arrives. Log redaction learns the OAuth token shape.
