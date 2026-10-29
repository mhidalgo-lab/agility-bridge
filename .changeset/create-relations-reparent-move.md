---
"agility-bridge": minor
---

Relations on create and update (P7-21): `create_work_item` takes `owners` (at most three members), `team` and `sprint`, and `update_fields` takes `parent` (re-parent under an epic, or a task or test under a story or defect of its own project) and `project` (move a story, defect or epic to another open project of the workspace; an item in a sprint is not moved). Each is found inside the workspace's projects, shown old to new in the approval and re-checked before the write. The declared costs of both tools grow with the new paths. The request shapes are unverified until the sandbox run.
