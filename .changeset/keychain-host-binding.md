---
"agility-bridge": minor
---

A keychain token is bound to the instance it was stored for (P8-31): `agility-bridge keychain set <name> --for-url <address>` records the host next to the token, and the server refuses to send `keychain:<name>` to a different `AB_AGILITY_URL` (a project's client file can no longer redirect your own token). `agility-bridge keychain bind <name> --for-url <address>` binds an existing entry or confirms a new address; entries stored without a host still work with a warning on stderr and in `doctor`. `keychain status --name` shows `boundTo`, `keychain delete` removes both entries.
