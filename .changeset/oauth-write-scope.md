---
"agility-bridge": minor
---

OAuth `mcp:write` scope (P7-24): an app that signs in with OAuth can ask for `mcp:write` next to `mcp:read`; the consent screen then shows a separate, never-ticked, never-remembered "allow changes" box, and the scope is granted only when the server switch, the workspace, the grant and a personal credential allow writes. The token's scope reaches the access layer, so a token without it never lists or runs a write tool; a refresh keeps the scope and cannot add it. `mcp:write` is advertised only with `AB_WRITE_TOOLS=on`.
