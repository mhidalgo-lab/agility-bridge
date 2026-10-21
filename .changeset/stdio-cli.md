---
'agility-bridge': minor
---

Serve MCP over stdio: `npx agility-bridge` reads `AB_AGILITY_URL` and `AB_AGILITY_TOKEN` (or a YAML file via
`AB_CONFIG`) from the client's environment, validates every `AB_` setting at startup, offers the read tools, explains
how to set itself up when unconfigured, and never accepts secrets as flags.
