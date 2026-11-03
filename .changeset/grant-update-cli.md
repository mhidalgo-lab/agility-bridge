---
"agility-bridge": minor
---

New `agility-bridge grant update <grant-id>` changes a grant from the command line: `--rate-per-minute`, `--writes-per-hour`, `--write-approval page_only|any`, `--tools`, `--project`, `--credential` and `--expires-days` (P7-40). It reads the grant first so a limit you do not name stays as it is, and `none` removes one.
