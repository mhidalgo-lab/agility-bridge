---
'agility-bridge': minor
---

Optional pass-through workspaces (`AB_PASSTHROUGH=on`, off by default): callers send their own Agility token in
`X-Agility-Token` over HTTPS; nothing is stored, every workspace control applies, and they are read-only. Also: the
startup warning for `AB_RATE_LIMIT=off` is now printed.
