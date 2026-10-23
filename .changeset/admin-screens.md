---
'agility-bridge': minor
---

Admin screens (P4-04): the panel at `/admin` now manages instances, credentials, workspaces, grants, device tokens and
users for owners and admins, on `serve` and on the Worker. Every change goes through the admin API as the signed-in person
(same role rules, re-authentication and audit rows); controls appear only when the API would allow them. Agility tokens are
typed once into a password field and never shown again; a new device token is shown once, behind a single-use form handle,
so a reload never makes a second one; origin changes, token replacement, write settings and owner changes ask for a recent
sign-in; the last active owner is protected with a clear message. The admin API gains `GET /tools`, and last-owner refusals
carry `error.detail: "last_owner"`.
