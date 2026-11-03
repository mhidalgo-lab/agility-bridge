---
"agility-bridge": minor
---

A workspace and a grant can carry their own Agility request quota (`limits.quota`, `daily` and `monthly`, P8-14). The quota that applies is the lowest of the server's `AB_QUOTA_DAILY` / `AB_QUOTA_MONTHLY`, the workspace's and the grant's, so an override only lowers; a value above the server's is refused, and raising or removing one that is set needs an owner with a recent sign-in. Set it in the admin panel, the admin API, or with `--quota-daily` and `--quota-monthly` of `workspace add|set` and `grant add`.
