---
"agility-bridge": patch
---

A `${keychain:...}` in the `instance.token` of the YAML configuration file is now sent only to the host it was stored for, like `AB_AGILITY_TOKEN=keychain:<name>` (P8-42): a different `instance.url` stops startup before the secret is read and names `keychain bind`. Entries stored without a host still work with a warning.
