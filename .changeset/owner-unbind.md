---
'agility-bridge': minor
---

Move a user to another sign-in provider on purpose (P4-12): owners (and the break-glass admin token) can clear a user's
provider identity with `agility-bridge user unbind <user-id> --confirm <email>`, `POST /users/{id}/unbind` or the "Move to
another provider" page of the admin panel, so the next verified sign-in with that email binds again. It needs a recent
sign-in, the user's email typed again and never works on your own account through a session; the clear is one compare-and-set
step, the user's browser sessions end, and the audit log records `user.unbind` with the previous provider only.
