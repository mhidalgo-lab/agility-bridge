# Pending decisions — Phase 7

> Open questions and owner steps from Phase 7 (opt-in writes). Answer inline (`**Owner:** …` with a date).

> The owner authorised the whole phase as a batch (2026-10-29): decisions marked *built as …* are implemented at their
> recommendation; say so if you want the alternative.

## Decisions

### D-155 — What an approval binds, and what it does not *(P7-01)*
- **Context:** ADR-0013 says the approval is bound to "a hash of the canonical arguments, actor, target and expiry". An out-of-band approval (the page, P7-02) is made before the agent repeats the call, so the repeated call has to arrive at the same hash; a hash that included a per-call expiry would never match.
- **Options:** (a) hash the tool, actor, operation, target OID and every field with its old and new value; keep the expiry on the ledger entry and check it on use; display-only data (asset number, title) is not hashed; (b) include the expiry in the hash (the page would have to fix it up front); (c) hash the raw tool arguments.
- **Recommendation:** (a), built. A different value, target, actor, tool or old value gives a different hash; the entry still dies at its expiry and after one use. (c) would let an unchanged argument approve a changed target.
- **Owner:** *(open; built as (a))*

### D-156 — How elicitation approves on each protocol era *(P7-01)*
- **Context:** On 2026-07-28 the client repeats the call with the answer (`input_required`); on a 2025-era connection that kept its capabilities (stdio) the server can push `elicitation/create`; a stateless 2025-era HTTP request cannot be asked (P0-07). The SDK turns an `input_required` for a client without the capability into a protocol error.
- **Options:** (a) the pipeline throws an `InputRequiredSignal` that the server wrapper turns into `input_required`, with an HMAC-sealed state naming a single-use ledger round, and uses the push request only where the connection declared the capability; no capability on the request means no channel and our own `AB_WRITE_APPROVAL_UNAVAILABLE`; (b) return `input_required` on every era and rely on the SDK's server-side shim for 2025-era connections (less code, untested here, and the capability check is then the SDK's); (c) keep the state only in the ledger without a seal.
- **Recommendation:** (a), built. The state and the ledger entry are both needed: the seal proves we issued the state for this change and actor, the ledger makes it single use across isolates.
- **Owner:** *(open; built as (a))*

### D-157 — Where the write limiter plugs in *(P7-01, P7-03)*
- **Context:** The limiter (P7-03) must refuse before a write is sent; it can also bound approval prompts.
- **Options:** (a) after the approval, before the re-read and the send: a refused, declined or unavailable attempt costs nothing, an approved write that the limiter refuses wastes the approval; (b) before the approval: bounds prompt spam too, but counts changes nobody approved; (c) both, with separate counters.
- **Recommendation:** (a), built as a `WriteLimiter.check` seam; P7-03 may add (c) if prompt spam shows up.
- **Owner:** *(open; built as (a))*

### D-158 — A new error code for a failed intent audit *(P7-01)*
- **Context:** The write is refused when its intent cannot be stored (L-109). The existing codes say nothing about this and the agent should not retry blindly.
- **Options:** (a) add `AB_WRITE_AUDIT_UNAVAILABLE` ("nothing was changed, try later, tell the administrator"); (b) reuse `AB_INTERNAL` (reference id only); (c) reuse `AB_AGILITY_UNAVAILABLE` (wrong: Agility was not called).
- **Recommendation:** (a), built; codes are only ever added.
- **Owner:** *(open; built as (a))*

### D-159 — The key that seals round-trip state in remote modes *(P7-01)*
- **Context:** Any isolate must verify the state another one issued, so the key cannot be per process there; stdio can use a random per-process key.
- **Options:** (a) derive it from the master key with the keyring's existing HMAC (`mac(AuditIdentity, 'write-approval-state|v1')`), no new key purpose; (b) add a `WriteApproval` key purpose (clean separation, but it changes the key derivation inventory and every `warm` list); (c) store a random key in `settings`.
- **Recommendation:** (a), built; domain separation comes from the data prefix, and rotating the master key only invalidates open questions (the pipeline asks again). Move to (b) if the cryptography inventory should list it.
- **Owner:** *(open; built as (a))*

### D-160 — What a write audit row holds *(P7-01)*
- **Context:** Old and new values would make the audit more useful, but they are customer text (T8: no Agility content in audit).
- **Options:** (a) the field names, the target and the hash of the change the approval bound; never a value; (b) also store the values (full forensics, customer text in the audit table and its CSV); (c) store the values encrypted.
- **Recommendation:** (a), built; the hash proves what was approved, and Agility's own history holds what changed.
- **Owner:** *(open; built as (a))*

### D-161 — stdio enablement needs the tool named in `AB_TOOLS` *(P7-01)*
- **Context:** On a remote server a write tool must be named in both the workspace and the grant lists ("all tools" never includes it). stdio has one process and no lists.
- **Options:** (a) `AB_WRITE_TOOLS=on` **and** `AB_TOOLS` naming each write tool; with `AB_TOOLS` unset no write is offered; (b) `AB_WRITE_TOOLS=on` alone offers every write tool.
- **Recommendation:** (a), built: the same "name it explicitly" rule as the remote layers, so turning the switch on never adds a tool silently.
- **Owner:** *(open; built as (a))*

### D-162 — Value and approval size limits, and hidden characters *(P7-01)*
- **Context:** The approval must show the whole change (L-106), so there is a size beyond which it is refused; values with invisible characters would show something other than what is sent.
- **Options:** (a) at most 20 changes, 8,000 characters per value, 24,000 characters of approval text, 50 items per list; control, invisible and bidirectional characters are refused (not cleaned); (b) the same limits but strip the characters for the display only (what is shown differs from what is sent); (c) larger limits (more to read; clients truncate long prompts, which the design must not allow).
- **Recommendation:** (a), built. Raise the limits only after seeing what real clients render (P7-12).
- **Owner:** *(open; built as (a))*
