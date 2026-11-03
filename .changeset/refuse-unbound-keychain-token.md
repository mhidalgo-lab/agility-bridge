---
"agility-bridge": minor
---

Breaking for unbound keychain entries (P8-41): a keychain token that was stored without a host is no longer accepted. `AB_AGILITY_TOKEN=keychain:<name>` or `${keychain:...}` in the YAML `instance.token` now stops startup, and `agility-bridge doctor` reports a failure, until you run `agility-bridge keychain bind <name> --for-url <address>` once. Tokens stored with `keychain set --for-url`, or bound since v0.8.0, are not affected. v0.8.0 warned about these entries.
