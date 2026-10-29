---
"agility-bridge": patch
---

Write path review fixes (P7-09): a timeout or unavailable error from a write now always says the change may or may not have been applied, and a 2xx answer with an empty or unreadable body is an applied write; `close_asset` refuses when it cannot count every child; text from Agility is cleaned for display and no longer blocks a write; zero-width joiners between visible characters are allowed in your text; the comment and effort no-ops apply only within 10 minutes; the approval page cleans and caps the title; 2026-07-28 approval rounds are bound to the workspace and instance; overwriting tools advertise `destructiveHint`; the write limiter is required and a refused check spends nothing; the create duplicate check handles unreadable times; `update_fields` refuses to overwrite a rich description.
