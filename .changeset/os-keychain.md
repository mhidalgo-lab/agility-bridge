---
"agility-bridge": minor
---

OS keychain support (P8-08): `AB_AGILITY_TOKEN`, `AB_MASTER_KEY` and `AB_MASTER_KEY_PREVIOUS` (and the YAML `${keychain:…}` form) accept `keychain:<name>` references to macOS Keychain, Linux `secret-tool` and Windows Credential Manager entries. New `agility-bridge keychain set|delete|status` and `init --keychain`. Secrets travel on standard input, never in arguments; a missing tool or entry is an error, with no fallback. The Windows backend is unverified on a real machine.
