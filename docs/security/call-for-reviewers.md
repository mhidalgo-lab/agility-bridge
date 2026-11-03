# Call for security reviewers

> P9-02, 2026-11-03. We are looking for an independent security review of agility-bridge before version 1.0. This page is
> the brief: what the project is, what we want looked at, where the code is, what we already know, the rules for testing and
> how to send findings. A reviewer can work from this page, the repository and nothing else.

## The project in one paragraph

agility-bridge is an unofficial, Apache-2.0 [MCP](https://modelcontextprotocol.io) server that lets AI assistants read, and
with explicit opt-in change, work items in Digital.ai Agility. It runs as a local stdio process, as a self-hosted HTTP server
(Node, Docker) or as a Cloudflare Worker. It stores **Agility access tokens** (each carries a member's full permissions),
issues its own device tokens and OAuth 2.1 tokens to AI clients, has an admin panel with sign-in through Google, GitHub,
Cloudflare Access or any OIDC provider, and, when switched on, performs writes that a human approves. The code is TypeScript,
about 60,000 lines of source and about 4,500 tests. Start with [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) and the threat model
([`docs/THREAT_MODEL.md`](../THREAT_MODEL.md)); [`threat-evidence.md`](threat-evidence.md) maps every threat to code and tests.

## What we ask for

A time-boxed review (we suggest 5 to 10 reviewer days) of the six areas below, and a written report with, for each finding:
severity, affected files and versions, a way to reproduce it (a test or a request sequence against a local instance), and a
suggested fix. Findings that show a *missing control* are as useful as exploits. We would also like a short opinion on the
threat model: a threat we did not list, or a mitigation you do not believe.

We cannot pay. We can offer credit in the advisory and the acknowledgements, fast turnaround and a published summary of the
review (see "What we publish").

## The six areas

| # | Area | The question | Entry points |
|---|---|---|---|
| 1 | OAuth 2.1 for MCP clients | Can a client, a browser, or another workspace get a token it should not, or keep one it should lose? | `packages/http-app/src/oauth/server.ts`, `clients.ts`, `consent.ts`, `abuse.ts`, `refresh-family.ts`; [oauth guide](../guide/oauth-how-it-works.md), [ADR-0017](../adr/0017-oauth-secrets-at-rest.md), [dev notes](../dev/oauth.md) |
| 2 | Approval and write path | Can a write happen without the person approving **that** change, twice, or for someone else? | `packages/core/src/writes/` (`pipeline.ts`, `ledger.ts`, `approval.ts`, `mutation.ts`), `packages/http-app/src/approval-page.ts`, `packages/http-app/src/writes.ts`; [ADR-0013](../adr/0013-opt-in-writes-human-approval.md), [write tools guide](../guide/write-tools.md) |
| 3 | Query compiler | Can caller input reach Agility other than as a bound value or a validated identifier, or widen the server's project scope? | `packages/core/src/query/compiler.ts`, `limits.ts`, `cursor.ts`, `packages/core/src/metadata/model.ts`, `identity/scope.ts`; [ADR-0012](../adr/0012-structured-query-no-raw-passthrough.md), [query limits](../guide/query-limits.md) |
| 4 | Access model | Can a principal exceed its grant (tool, project, asset type, workspace), or see another workspace's data, credential or cache? | `packages/auth/src/access/resolve.ts`, `policy.ts`, `guards.ts`, `services.ts`; `packages/http-app/src/app.ts`, `access-cache.ts`; [ADR-0008](../adr/0008-access-model.md), [access model guide](../guide/access-model.md) |
| 5 | Key handling | Can a stored Agility token, a master key, a device token or a session secret be recovered, replayed or logged? | `packages/auth/src/secrets/keyring.ts`, `credentials.ts`, `packages/auth/src/tokens/`, `packages/core/src/redact.ts`, `apps/cli/src/keychain.ts`, `apps/cli/src/manage/config-bundle.ts`; [cryptography inventory](cryptography.md), [ADR-0007](../adr/0007-secrets-envelope-encryption.md), [logging inventory](logging.md) |
| 6 | Admin panel and admin API | Can a lower role reach an owner action, can a page be forged, framed or scripted, is every change audited? | `packages/http-app/src/admin/api.ts`, `admin-ui.ts`, `session.ts`, `identity.ts`, `packages/admin-ui/src/`, `packages/auth/src/identity/`; [admin access guide](../guide/admin-access.md), `e2e/` browser tests |

Also welcome, if time remains: the output shaper and untrusted-data envelope (`packages/core/src/output/`), the Agility
client and SSRF controls (`packages/core/src/agility/`), the Worker (`apps/worker/`) and the release pipeline
(`.github/workflows/`, `scripts/release.ts`).

### Questions we would most like answered

1. In the approval flow, is there any ordering of two concurrent calls, a retry, a lost response or a stale approval page
   that lets a change be applied that the person did not see, or applied twice?
2. Does any code path build an Agility query, filter, sort or URL from a string a caller influenced, including cursors,
   status names, member names and custom attributes?
3. Is every route of the admin API protected by the owner guards that the access model describes (the "alternate writers"
   rule, L-065)? Are there routes that take an id and skip the check that the id belongs to the caller?
4. Can a registered OAuth client (dynamic registration or a metadata document) obtain a token for a workspace the user did
   not consent to, confuse the audience between workspaces, or cause the server to fetch an attacker-chosen URL?
5. Is there a place where a secret can reach a log line, an audit row, an error message, a tool result or a cache entry?
6. Can untrusted Agility content (titles, descriptions, comments) change what the model is told outside the envelope, or what
   a person sees on the approval page?

## Running it

```sh
git clone https://github.com/mhidalgo-lab/agility-bridge && cd agility-bridge
corepack enable && pnpm install
pnpm test                       # about 4,500 tests, no network; unit, property, workerd (Worker) and SQLite/D1 suites
pnpm test:e2e                   # the panel, the approval page and the OAuth consent page in a real browser
node scripts/fixture-agility.ts # a synthetic Agility on 127.0.0.1 (prints its URL); any token works
```

To run a server against the fixture, follow [quickstart-local](../guide/quickstart-local.md) with `AB_AGILITY_URL` set to the
fixture's URL, or use [self-hosting](../guide/self-hosting.md) for the HTTP mode and [Cloudflare deploy](../guide/cloudflare-deploy.md)
for your own Worker. The in-process test world (`packages/http-app/test/helpers/world.ts`) builds the whole HTTP app with two
workspaces and several principals in a few lines; it is the quickest way to write a proof of concept as a test.

You do not need a real Digital.ai Agility instance and we do not provide one. **Do not point agility-bridge at an Agility
tenant you are not authorised to test.**

## Rules for testing and safe harbour

These extend [SECURITY.md](../../SECURITY.md). They apply to everyone who tests agility-bridge in good faith, reviewers included.

- **Test only your own deployments**, the local fixture and Agility instances you are authorised to use. Do not test against
  anyone else's agility-bridge deployment, Cloudflare account or identity provider.
- **No access to other people's data.** If you reach data that is not yours, stop, do not copy it, and tell us.
- **No denial of service** of shared infrastructure (GitHub, npm, Cloudflare, identity providers, Digital.ai). Resource
  exhaustion of your own instance is fine and welcome when it shows a missing limit.
- **No social engineering** of maintainers or users, and no physical attacks.
- **Do not publish** details before we have had a reasonable chance to fix (see below).
- If you follow these rules we will not pursue or support legal action against you for research of this project, we consider
  the research authorised, and we will say so to any third party that asks.

## Reporting

Use GitHub private vulnerability reporting:
<https://github.com/mhidalgo-lab/agility-bridge/security/advisories/new>. One advisory per finding; a single report that
lists several is fine for a review report. Never include real Agility tokens or Agility content. We acknowledge within 3
business days and assess within 7 days, as in [SECURITY.md](../../SECURITY.md).

**Coordinated disclosure.** We ask for 90 days from the report before public details, or until a fixed release is out,
whichever is first; we will agree a shorter or longer time if the issue calls for it. We credit reviewers by name in the
advisory and in [SECURITY.md](../../SECURITY.md) if they want it.

## What we already know (please do not report these as findings)

- The accepted residual risks R-1 to R-13 in [`threat-evidence.md`](threat-evidence.md#accepted-residual-risks) (prompt
  injection is reduced, not eliminated; elicitation is answered by the client; per-isolate limits on Workers are approximate;
  a process with the master key can decrypt the stored tokens; private instance addresses are allowed unless refused by
  setting; and the others listed there). We would still like to hear if you rank one of them higher than we do.
- The evidence that needs a live Agility tenant or a real MCP client is listed as L-1 to L-10 in the same file; the live
  pass has not been run yet.
- The [ASVS 5.0 mapping](asvs-l2.md) (a self-assessment; please challenge it) and the open Scorecard findings
  ([scorecard.md](scorecard.md)).
- An internal pre-review for this call was done on 2026-11-03; its findings and fixes are in
  [`docs/reviews/phase-9-pre-review.md`](../reviews/phase-9-pre-review.md).

## What we publish

After the findings are fixed or accepted we publish a summary of the review (scope, method, number of findings by severity,
what was fixed and what was accepted and why) in `docs/reviews/`, with the reviewer's name if they agree, and link it from
SECURITY.md. Reviewers see and can correct the summary before it goes out. Raw findings stay in the private advisories until
their disclosure window ends.

## How to volunteer

Open a private advisory titled "Review offer" or write through the repository's security contact described in
[SECURITY.md](../../SECURITY.md); say who you are, what you would cover and your time frame. We will answer within the same 3
business days. (The owner chooses the reviewer and the engagement terms; this page does not commit the project to anyone.)
