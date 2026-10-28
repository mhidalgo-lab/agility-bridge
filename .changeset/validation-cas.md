---
"agility-bridge": patch
---

A credential validation result is written only while the stored token is the one that was checked (one conditional
write in storage), so a token replaced while Agility was answering can never be marked valid by the old answer.
