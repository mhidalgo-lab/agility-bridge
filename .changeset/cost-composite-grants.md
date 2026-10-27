---
"agility-bridge": patch
---

`whoami` and the admin panel (workspace and grant pages) now warn when a composite report is granted without the sibling
tools it reads. The admin API's tool catalogue (`GET /tools`) lists each composite's `siblings`. The cost of every tool is
now tested against its declared worst case in one test over the whole catalogue.
