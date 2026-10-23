---
'agility-bridge': minor
---

Member self-service (P4-07): every signed-in person has "My access" in the panel (`/admin/me`) to add, check, replace, revoke and
delete their own personal Agility token (checked against Agility at once, never shown again), choose which of their grants
uses it, and issue and revoke their own device tokens, without an administrator handling the secret. Everything goes
through the admin API as the signed-in person: another person's or a shared credential, a grant or device token that is not
theirs, and an instance they have no grant on are refused with no effect. The admin API gains `GET /me/grants`, `POST
/me/grants/{id}/credential` and `GET /me/audit`; a member may now delete their own personal credential; caps of 10 personal
credentials per person and 20 live device tokens per grant apply to every writer.
