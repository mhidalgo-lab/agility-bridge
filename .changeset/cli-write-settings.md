---
"agility-bridge": minor
---

`agility-bridge workspace set` takes `--writes on|off` and `--write-approval any|page_only` (P7-34). It reads the workspace's write policy first and sends it merged, so the custom attributes stay. `grant update --write-approval` (from P7-40) does the same for a grant. There is no deployment-wide default for the approval policy (D-208).
