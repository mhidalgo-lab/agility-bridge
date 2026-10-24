---
"agility-bridge": minor
---

Add the OAuth token lifecycle (P5-05): refresh tokens rotate on every use with a reuse window (`AB_OAUTH_REFRESH_REUSE_WINDOW`, default 30 s, 0-120 s), so a client that refreshes several times in parallel, or repeats a refresh whose answer it lost, keeps its connection and gets the same new tokens; a spent refresh token used again after the window, or at window 0, disconnects the whole device (access and refresh tokens) and writes an `oauth.refresh.reuse` audit row without any token. The new tokens kept for the window are stored encrypted under a key derived from the spent token and deleted afterwards. Every refresh, also a repeat inside the window, checks that the device is still connected and that the access still exists. Works on `serve` (SQLite) and the Worker (D1).
