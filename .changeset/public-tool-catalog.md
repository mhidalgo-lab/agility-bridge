---
"agility-bridge": minor
---

Public tool catalogue (P8-11): `AB_PUBLIC_TOOL_CATALOG=on` (off by default) lets `initialize`, `ping`, `server/discover` and `tools/list` answer without a credential, from a static read-only catalogue that is the same for every workspace name and never lists write, report or attachment tools. Everything else still needs authentication.
