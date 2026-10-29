---
"agility-bridge": minor
---

Write tools, wave 2 (P7-05): `create_work_item` (a story, defect, task, test or epic in a project of the workspace; a task or test under its parent) and `update_fields` (title, description, estimate and priority of one open item). Typed fields per asset type only: no custom attributes, project, status, owner, sprint or parent changes. Each shows the exact change for approval (every field of a new item, old to new for an update), a repeated create is refused instead of creating twice, and both are absent unless `AB_WRITE_TOOLS=on` and an owner enables them. The request shapes are verified against a sandbox in P7-07.
