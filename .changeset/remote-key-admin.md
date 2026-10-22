---
'agility-bridge': minor
---

Master-key status and retirement through the admin API (`GET /keys`, `POST /keys/{version}/retire`, owners; retiring
needs a recent sign-in and is audited), so `agility-bridge keys status` and `keys retire` work remotely too (for
example against a Cloudflare Worker). `agility-bridge init --version <N>` writes a key for the next version of a
rotation. `keys rotate` stays local.
