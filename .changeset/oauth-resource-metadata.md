---
"agility-bridge": minor
---

Publish OAuth protected resource metadata per workspace (P5-02, RFC 9728) at `/.well-known/oauth-protected-resource/w/{slug}/mcp`, and name it in the `WWW-Authenticate` challenge of every `401` on `/w/{slug}/mcp` when OAuth is on, so MCP clients that start without a token discover the authorization server and the workspace's resource themselves. The document and the challenge are identical for known, unknown and disabled workspaces. Nothing changes while OAuth is off.
