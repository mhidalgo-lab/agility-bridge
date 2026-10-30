---
"agility-bridge": patch
---

Shared tier of the query cache (P8-38): entries above 64 KiB stay in the isolate's memory instead of being sealed into the Cache API (an option of the tier, shown by `whoami` as `queryCache.sharedMaxEntryChars`), and sealing uses the runtime's own base64 where it exists (about 100 times faster on workerd).
