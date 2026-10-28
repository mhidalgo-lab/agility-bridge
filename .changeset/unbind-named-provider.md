---
"agility-bridge": minor
---

`agility-bridge user unbind --to <provider> [--ttl-minutes N]` (and `provider`, `ttlMinutes` in the admin API and a field in
the panel) narrow who can claim an unbound account: only a verified sign-in at the named provider can bind it while the
claim lasts (default 24 hours, at most 7 days).
