---
"agility-bridge": minor
---

Write tools, wave 1 (P7-04): `add_comment`, `update_status`, `log_effort`, `assign_owners` and `move_to_sprint`, in the opt-in `writes` group. Each changes one work item, shows the exact change (old to new) for approval, re-reads the target before sending and sends once; they are absent unless `AB_WRITE_TOOLS=on` and an owner enables them per workspace and grant. The request shapes are the documented ones and are verified against a sandbox in P7-07.
