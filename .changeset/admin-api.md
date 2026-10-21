---
'agility-bridge': minor
---

Admin REST API for `agility-bridge serve` at `/api/admin/v1` (instances, credentials, workspaces, grants, device
tokens, users, audit), enabled by a break-glass token from the new `agility-bridge admin-token` command
(`AB_ADMIN_TOKEN_FILE`). Owner/admin/member guards apply to every change, secrets are never returned, and every change
is audited. Reference: docs/reference/admin-api.md.
