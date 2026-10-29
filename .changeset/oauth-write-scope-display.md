---
"agility-bridge": minor
---

Show the OAuth write scope on My access and on the administrators' Connected apps list (P7-32): each connected app is marked "can ask for changes" (its authorization holds `mcp:write`) or "read only", and `canWrite` is in `GET /api/admin/v1/me/oauth-devices` and `GET /api/admin/v1/oauth/devices`. No scope string is shown, and the way to remove it is still to disconnect the app.
