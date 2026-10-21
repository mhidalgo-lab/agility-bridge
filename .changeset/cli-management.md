---
'agility-bridge': minor
---

Management commands for a server: `agility-bridge init`, and `user`, `instance`, `credential`, `workspace`, `grant`,
`token`, `audit tail` and `keys status|rotate|retire`, either on the local database or through the admin API of
`AB_ADMIN_URL`, with the same rules and audit. Secrets come from files, the environment, standard input or a hidden
prompt, never from arguments. See docs/guide/cli.md.
