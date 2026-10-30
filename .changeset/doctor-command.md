---
"agility-bridge": minor
---

`agility-bridge doctor` (P8-04): a read-only diagnosis of the configuration, the instance (an unauthenticated probe over HTTPS), the token (only with `--check-token`), the local database and master key, and the MCP client files of every primary client. Output is scrubbed; `--fix` applies only the owner-only file modes it lists.
