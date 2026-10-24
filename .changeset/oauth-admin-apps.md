---
"agility-bridge": minor
---

Add the administrators' view of OAuth (P5-08): with `AB_OAUTH=on`, owners and admins see every person's connected apps (panel page "Connected apps", `GET /oauth/devices`) and disconnect one (`POST /oauth/devices/{id}/revoke`; an owner anyone's, an admin a member's), and owners list the registered OAuth clients (dynamic registrations and metadata documents, with where they send people and how many devices use them) and revoke one (`GET /oauth/clients`, `POST /oauth/clients/revoke`, `POST /oauth/clients/restore`). Revoking a client blocks it first, deletes its registration and ends every device of it: nothing new is authorized, no token is refreshed and its access tokens stop. Every change is a POST with the panel's CSRF checks and writes audit rows without token material.
