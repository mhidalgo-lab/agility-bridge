# Pending decisions — Phase 4

> Open questions and owner steps from Phase 4. Answer inline (`**Owner:** …` with a date).

## Owner steps

1. **A real sign-in, once** (P4-01): the providers are tested against local fakes only. Before relying on them, run each
   one you will use against a real application and record the result in
   [RESEARCH.md §9](../RESEARCH.md#9-admin-sign-in-providers-p4-01):
   - Create the application (steps in [identity providers](../guide/identity-providers.md#create-the-applications)),
     start `agility-bridge serve` with `AB_PUBLIC_URL` set to an address the provider can redirect to (an
     `https://` tunnel or the staging Worker), issue a link with `agility-bridge setup-link`, sign in, and check the
     user row (`agility-bridge user list`) and the audit rows (`agility-bridge audit tail --kind auth`).
   - Google: also try an account outside `AB_GOOGLE_HOSTED_DOMAIN` (must be refused with `hd_mismatch`).
   - GitHub: an unverified primary email must be refused; a pending organization invitation must not count as
     membership; the OAuth app's authorized-applications list should not keep a token after sign-in.
   - Cloudflare Access: confirm the `keys` array of `/cdn-cgi/access/certs` is read (unverified, RESEARCH §9).
   The agent run may not create OAuth apps or Access applications.

## Open decisions

### D-29 — Allowlists need auto-provisioning *(P4-01)*
- **Context:** `AB_LOGIN_ALLOW_*` with `AB_LOGIN_AUTO_PROVISION=off` admits nobody new: only users an admin already
  created can sign in. relic-bridge made the same choice and added the start-up warning, which this task has too.
- **Options:** (a) keep: allowlists only matter together with auto-provisioning, and a warning explains it; (b) let an
  allowlisted identity sign in as `member` without a flag.
- **Recommendation:** (a). Provisioning a user is a decision, and `off` is the safe default.
- **Owner:** _pending_ (implemented as (a)).

### D-30 — Several identities per user *(P4-01)*
- **Context:** one `(idp, subject)` per user, and an email bound to another identity is refused. A person who wants to
  use both Google and GitHub, or who changes provider accounts, cannot today (task P4-12 adds an owner-only,
  confirmed unbind).
- **Options:** (a) one identity per user, with an owner-only unbind (P4-12); (b) several identities per user; (c) link
  by verified email across providers.
- **Recommendation:** (a): (c) is an account-takeover path when one provider's email checks are weaker, and (b) needs a
  linking flow that proves control of both accounts.
- **Owner:** _pending_ (implemented as one identity per user).

### D-31 — Sign-in limit on Workers *(P4-01)*
- **Context:** `AB_RATE_LIMIT_SIGN_IN` counts per isolate on Workers, as the other non-backstopped rules do; the
  Rate Limiting binding has one fixed rule per namespace. A distributed client can exceed it, each start costing a D1
  write that expires after 10 minutes.
- **Options:** (a) accept (documented); (b) a binding namespace for sign-in; (c) the exact limiter (P3-12).
- **Recommendation:** (a) until P3-12 decides the limiter.
- **Owner:** _pending_.

### D-32 — Identity provider calls on Node default to public addresses only *(P4-01)*
- **Context:** `AB_IDENTITY_PRIVATE_ADDRESSES=refuse` is the default (THREAT_MODEL T11), which blocks an OIDC provider on a
  private network (an internal Keycloak) until the operator sets `allow`.
- **Options:** (a) refuse by default; (b) allow by default, like `AB_INSTANCE_PRIVATE_ADDRESSES`.
- **Recommendation:** (a): the issuer's discovery document chooses the other endpoints, so a compromised or mistyped
  issuer should not reach internal addresses by default.
- **Owner:** _pending_ (implemented as (a)).

### D-33 — `Clear-Site-Data: "cookies"` on logout *(P4-02)*
- **Context:** the task asks logout to send `Clear-Site-Data`. The `"cookies"` directive clears the cookies of the whole
  registered domain and its subdomains ([RESEARCH §9](../RESEARCH.md#sessions-clear-site-data-and-re-authentication-p4-02)),
  so a server at `mcp.example.com` signs the user out of every sibling application on `example.com`.
- **Options:** (a) send `"cookies"` by default and offer `AB_LOGOUT_CLEAR_SITE_DATA=off`; (b) off by default; (c) never.
- **Recommendation:** (a): a dedicated host is the common case, the session cookie is cleared and deleted either way, and
  the guide warns about shared domains.
- **Owner:** _pending_ (implemented as (a)).

### D-34 — Re-authentication strength at Google and GitHub *(P4-02)*
- **Context:** a recent sign-in is required for high-impact changes. OIDC providers are asked for `prompt=login&max_age=0`
  and their `auth_time` is checked when sent; Cloudflare Access must show an assertion issued in the last 10 minutes.
  Google sends no `auth_time` (and documents no `prompt=login`), and GitHub has no way to ask: for them the proof is "the
  browser still has a session at the provider and the same account answered", i.e. no new password prompt is guaranteed.
- **Options:** (a) accept it for every provider, documented; (b) refuse re-authentication for providers that cannot show
  recency, so those owners use the break-glass token for high-impact changes; (c) add a second factor of our own.
- **Recommendation:** (a) until a real run (owner step 1) shows what Google does with `prompt=login`: the session was
  already created by a fresh provider round trip, and (b) would lock Google- and GitHub-only teams out of key rotation.
- **Owner:** _pending_ (implemented as (a)).

### D-35 — The owner setup page's policy has no `form-action` *(P4-03)*
- **Context:** the panel's CSP restricts `form-action` to `'self'`. The owner setup form posts to this server and is answered
  with a redirect to the identity provider, and Chromium applies `form-action` to the redirects that follow a form post
  ([L-195](../LESSONS-LEARNED.md)), so under the panel policy the first-owner sign-in would stop at the redirect. The setup
  page alone (`UI_CSP_SETUP`) drops that one directive; everything else is unchanged.
- **Options:** (a) keep: one page, one directive, tested as the panel policy minus `form-action`; (b) make the setup post
  answer with a same-origin page that has a link to the provider (needs the login transaction to travel in a cookie or a
  URL); (c) drop `form-action` from every page.
- **Recommendation:** (a). The page holds no session and no secret except the code the visitor types, and (b) needs a design
  of its own. Verify in a real browser in the P4-08 run (Chromium and Firefox treat redirects after form posts differently).
- **Owner:** _pending_ (implemented as (a)).

### D-36 — Validation sentences from the admin API are shown beside panel forms *(P4-04)*
- **Context:** P4-03 decided that no text from an admin API error body is displayed (it can carry names or upstream text). Forms
  that only say "invalid" are hard to correct (which limit is out of range? which project id is malformed?).
- **Options:** (a) show the message of a `422 invalid_input` only, as escaped text cut to 300 characters, beside the form, and fixed
  sentences for every other status; (b) keep P4-03's rule and show only our own client-side messages; (c) show every message.
- **Recommendation:** (a). A 422 message names the field and the rule from our own validators, never upstream text; the other
  statuses (403, 404, 409, 502) are where names and Agility's words can appear, and they stay fixed.
- **Owner:** _pending_ (implemented as (a)).

### D-37 — No new index for the audit viewer; statistics read the newest 10,000 rows *(P4-05)*
- **Context:** The viewer filters by user, workspace, kind, outcome and action; statistics group `tool_call` rows. The audit
  table has `(ts, id)` and `(workspace_id, ts, id)` indexes. A member's view filters by user, which no index covers, and
  every extra index costs a written row on every audit append (D1 Free caps writes far below reads, *re-verify*).
- **Options:** (a) no new index; every list is a newest-first keyset scan bounded by the time range (default 7 days) and the
  page size, and statistics read at most the newest 10,000 `tool_call` rows and say when they stopped; (b) add
  `(user_id, ts, id)` (a migration, one more written row per audit row); (c) pre-aggregated daily counters (more writes, a
  new table, retention to match).
- **Recommendation:** (a). Reads are the plentiful quota; revisit (b) if the benchmark task (P4-14) or a live server shows
  member views scanning a lot, and (c) only if windows beyond 10,000 calls matter in practice.

### D-39 — No per-workspace switch for personal tokens, and no member-created grants *(P4-07)*
- **Context:** a member brings their own Agility token and chooses which of their grants uses it. Grants (scope, tools, limits)
  are assigned by administrators. Nothing lets a workspace say "personal tokens not allowed here", and a member cannot create
  a grant for themselves.
- **Options:** (a) keep: administrators assign grants, members choose among their own valid tokens; the workspace and the
  grant still limit projects and tools; (b) a workspace flag letting members create their own grant with the workspace's
  defaults; (c) a workspace flag forbidding personal tokens (members stay on the shared default).
- **Recommendation:** (a). A personal token only changes *whose* Agility permissions answer, never what the workspace allows,
  and relic-bridge decided the same way (2026-10-09). Revisit (c) if a team wants shared-only workspaces: a pass-through or
  shared-only workspace already behaves that way.
- **Owner:** _pending_ (implemented as (a)).

### D-40 — Personal credential caps and where they apply *(P4-07)*
- **Context:** a member can add personal tokens and device tokens without an administrator. Unbounded, each is a storage row
  and a validation call to Agility.
- **Options:** (a) fixed caps in the services: 10 personal credentials per person (revoked ones count until deleted) and 20
  live device tokens per grant, re-checked after the insert; (b) configurable caps (environment variables); (c) no caps for
  owners and admins.
- **Recommendation:** (a): the numbers match relic-bridge, apply to every writer (API, panel, command line), and owners and
  admins are people too. Make them settings only if a team asks.
- **Owner:** _pending_ (implemented as (a)).

### D-41 — No third-party bridge for Claude Desktop and claude.ai *(P4-06)*
- **Context:** Claude Desktop's config file starts stdio servers only, claude.ai and mobile need a connector (OAuth, Phase 5).
  relic-bridge's connect page offered a Claude Desktop snippet that runs the third-party `mcp-remote` package through `npx` with
  the token in the file's `env`.
- **Options:** (a) no snippet until the OAuth connector exists (listed as "needs OAuth"); (b) the `mcp-remote` snippet; (c) a
  first-party stdio-to-HTTP proxy mode in the CLI.
- **Recommendation:** (a). (b) puts an unpinned third-party package, run on every start, between a person and a token that acts as
  them in Agility; (c) is a feature of its own (a new task if a team needs Desktop before Phase 5).
- **Owner:** _pending_ (implemented as (a)).

### D-42 — Environment variable name and where the client keeps the token *(P4-06)*
- **Context:** snippets read the device token from a variable instead of a command-line value. The server itself reads `AB_*`
  variables, and Claude Code blanks credential-looking names such as `*_AUTH_TOKEN` in project files.
- **Options:** (a) `AGILITY_BRIDGE_TOKEN` (outside the `AB_` namespace the server validates, not on Claude Code's list);
  (b) `AB_DEVICE_TOKEN`; (c) no variable, literal values everywhere.
- **Recommendation:** (a). `claude mcp add` and `copilot mcp add` still write the expanded value into the client's own file
  (`~/.claude.json`, `~/.copilot/mcp-config.json`, plain text): the snippets say so, and short device-token lifetimes are the
  mitigation (the default is 90 days).
- **Owner:** _pending_ (implemented as (a)).

### D-47 — What `cf:setup --sign-in` asks and where client secrets go *(P4-13)*
- **Context:** the first task draft kept the allowlists as dashboard variables and said nothing about `--secrets-file`.
  Setting providers without the policy leaves a Worker that refuses every unknown identity until someone edits variables
  by hand, and the server warns about exactly that combination.
- **Options:** (a) ask for the providers and also the `AB_LOGIN_ALLOW_*` allowlists and `AB_LOGIN_AUTO_PROVISION`, send
  client secrets only to `wrangler secret put` (stdin), never to `--secrets-file`; (b) providers only, policy in the
  dashboard; (c) also write client secrets to `--secrets-file`.
- **Recommendation:** (a). The identity provider keeps the client secret (rotating it is one click there), while the
  secrets file exists for values only Cloudflare would hold; a second copy of a client secret is one more place to leak.

### D-45 — What the unbind audit row records about the old binding *(P4-12)*
- **Context:** `user.unbind` must let an auditor tell which provider was cleared. The provider subject is a stable identifier of a
  person at that provider; a hash of it is no safer when the subject is a number (GitHub) or an email-like string.
- **Options:** (a) the previous provider id only; (b) provider id plus a truncated hash of the subject; (c) provider id plus
  the subject.
- **Recommendation:** (a): the user id in the row already says whose account it was, and a short unsalted hash of a guessable
  id can be reversed by anyone who can read the audit log.
- **Owner:** _pending_ (implemented as (a)).

### D-46 — After an unbind, who may claim the account *(P4-12)*
- **Context:** once the binding is cleared, the next verified sign-in whose email matches binds the account, at any configured
  provider (L-092). A provider with weaker email verification is a way in during that window.
- **Options:** (a) ship as is and document the residual (keep configured providers to ones whose email checks you trust);
  (b) let the owner name the provider the next binding must come from, with an expiry (task P4-24).
- **Recommendation:** (a) now, (b) when a deployment has providers of different strength; it is a small follow-up (P4-24).
- **Owner:** _pending_ (implemented as (a)).

### D-51 — How `GET /tokens` pages and who sees what *(P4-15)*
- **Context:** the panel-wide device token list needs a stable page key and a rule for members. The storage lists tokens whole
  (live tokens are capped at 20 per grant; revoked and expired rows accumulate).
- **Options:** (a) keyset on `(createdAt, id)` computed in the service over the storage list, opaque `after` cursor, owners and
  admins see every token and anyone else the tokens of their own grants; (b) the same with a storage-level keyset (task P4-31);
  (c) owners and admins only (members keep the per-grant list).
- **Recommendation:** (a) now, (b) when a deployment holds thousands of tokens. Members already see their own tokens per grant, so
  the API answering the same set through one call costs nothing and the panel screen stays admin-only.
- **Owner:** _pending_ (implemented as (a)).

### D-52 — Number prefixes: edit now, apply later *(P4-15)*
- **Context:** `instances.numberPrefixes` was stored and shown, never validated, and no host passes it to the metadata service,
  so editing it has no effect on number lookups today.
- **Options:** (a) validate on every writer, add the panel form, say in the form that the values are not applied yet, and make the
  runtime use them in task P4-30; (b) wire them into the resolver in this task; (c) leave the field out of the panel until P4-30.
- **Recommendation:** (a): the validator and the form do not depend on the wiring, and P4-30 touches the access resolver and the
  metadata cache, which deserves its own review. Until then the prefixes are an inert, validated record.
- **Owner:** _pending_ (implemented as (a)).
