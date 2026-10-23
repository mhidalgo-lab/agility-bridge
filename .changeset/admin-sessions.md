---
'agility-bridge': minor
---

Admin sessions, roles, CSRF and re-authentication (P4-02): a finished sign-in starts a browser session (`__Host-`
cookie, only a hash in the database, idle 30 min / absolute 12 h, at most 20 per user, rotated at every sign-in) that the
admin API accepts as the signed-in user, with a CSRF token plus `Origin` and `Sec-Fetch-Site` checks on every change.
Owner-only management and the last-owner rule apply unchanged; high-impact changes (instance origin, key retirement,
owners and admins, credential replacement, write enablement) need a sign-in from the last 10 minutes
(`403 reauth_required`, `/auth/reauth`). `POST /auth/logout`, `GET /auth/account`, `GET /api/admin/v1/session`,
`POST /api/admin/v1/users/{id}/sessions/revoke` and `agility-bridge user end-sessions`. New settings
`AB_SESSION_IDLE_MINUTES`, `AB_SESSION_MAX_HOURS`, `AB_SESSION_MAX_PER_USER` and `AB_LOGOUT_CLEAR_SITE_DATA`.
