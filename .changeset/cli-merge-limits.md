---
"agility-bridge": patch
---

`agility-bridge workspace set --max-rows/--quota-daily/--quota-monthly` now changes only the limit named and keeps the others (row and call budgets, the switches set in the panel, the other quota period); before, it replaced the workspace's whole `limits` and dropped them (P8-46). `none` removes one. `grant update` takes `--quota-daily` and `--quota-monthly` the same way.
