---
'agility-bridge': patch
---

Admin security review (P4-09): setting an instance's TLS trust (a CA file) through the admin API needs an owner with a recent
sign-in, as the panel already said; adding projects, child projects or asset types to a workspace or grant that has write
tools, making a workspace pass-through, and issuing a device token that lasts more than 90 days (or never expires) need a
recent sign-in (owner for the first three); a device token issued while its grant moves to a personal token is revoked; a
credential validation that started before a token replacement can no longer vouch for the new token; the admin API stops
reading a request body at its 64 KiB cap; and audit rows of admin changes now record the role (and previous role), project
and tool lists, write switches, the token id and end, and the instance host.
