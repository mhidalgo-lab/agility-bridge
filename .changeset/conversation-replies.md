---
"agility-bridge": patch
---

`get_conversations` now lists the replies to each comment, right after it and oldest first, with `inReplyTo` (P9-25). Replies mention no work item, so they were outside every workspace before: the scope of a comment now also follows the comment it answers (`InReplyTo.Mentions`), in the query, the row recheck and related-asset guards. Pages hold at most 50 comments; the declared cost is 11 Agility requests.
