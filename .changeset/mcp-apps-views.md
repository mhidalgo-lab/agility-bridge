---
"agility-bridge": minor
---

MCP Apps views (P8-03): `get_sprint` links a sprint burndown chart and `sprint_health` a status distribution chart (`ui://agility-bridge/…`) for clients that declared the MCP Apps extension; every other client gets the same text and structured result as before. The views are static, dependency-free pages with a strict content security policy and show Agility text only as text. On by default; `AB_MCP_APPS=off` turns them off. `sprint_health` also returns `byStatusCategory`.
