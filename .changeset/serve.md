---
'agility-bridge': minor
---

New `agility-bridge serve`: a team server over HTTP that exposes each workspace at `/w/<slug>/mcp` to per-device
tokens, with SQLite storage, Agility tokens encrypted under a master key (`AB_MASTER_KEY_FILE`), per-workspace and
per-grant access, and both MCP protocol eras. See docs/guide/secrets.md and docs/guide/access-model.md.
