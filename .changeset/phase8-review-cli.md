---
"agility-bridge": patch
---

Phase 8 review fixes (P8-12): config files that carry tokens now authenticate the instance addresses and the credential mapping (file version 2: export again); `config import --add-grants` finishes a partly failed import; environment `keychain:` references read the `agility-bridge` service only; `keychain status` probes the store; `doctor --offline` reads no keychain, `doctor --fix` leaves an explicit `AB_DB_PATH` directory alone and control characters are stripped from its output; `client-config claude-code` prints a quoted command; the stdio server warns about settings only remote hosts read; the Windows keychain script pins UTF-8.
