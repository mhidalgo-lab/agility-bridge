---
"agility-bridge": minor
---

Configuration export and import (P8-05): `agility-bridge config export` writes instances, shared credentials, workspaces and service grants to a file with no secrets (tokens only with `--with-tokens`, sealed with a passphrase: PBKDF2-HMAC-SHA-256, 600,000 iterations, AES-256-GCM); `config import` is additive and a dry run unless `--apply`, goes through the admin API, never changes what exists and never assigns or reads a personal credential.
