---
"agility-bridge": minor
---

MCP Tasks extension (P8-10): a 2026-07-28 client that declares `io.modelcontextprotocol/tasks` on a `tools/call` of a report tool gets a task handle at once; `tasks/get` runs the report inside that request, `tasks/cancel` and `tasks/update` complete the lifecycle. Records are sealed, hashed, bound to the owner device, grant and workspace, and expire after 15 minutes; nothing runs after a response. `AB_TASKS=off` removes the extension. See docs/guide/tasks.md.
