# Security policy

agility-bridge handles Digital.ai Agility access tokens and Agility data, so we take security reports seriously.

## Supported versions

| Version | Security fixes |
|---|---|
| pre-1.0 (`0.x`) | Latest minor release only, as a patch release. No backports: upgrade to the latest minor. |
| 1.x (future) | Defined by the support policy (P9-05) before 1.0. |

A fix lands on `main` first and ships as a patch of the latest minor. A security fix may tighten a default or refuse
input that used to be accepted, without the usual deprecation period; the advisory and the release notes say so.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for security problems.**

Report privately through **GitHub private vulnerability reporting**:
<https://github.com/mhidalgo-lab/agility-bridge/security/advisories/new> (or the repository's **Security** tab →
**Report a vulnerability**). Include:

- the affected version or commit and the deployment mode (stdio, Node, Docker, Cloudflare Worker)
- steps to reproduce or a proof of concept
- the impact as you understand it

Never include real Agility access tokens or Agility content in a report; use a test instance or redact.

We aim to:

| Step | Target |
|---|---|
| Acknowledge the report | 3 business days |
| Initial assessment and severity | 7 days |
| Fix or mitigation for high and critical issues | 30 days |
| Public advisory and credit (if you want it) | when a fix is released |

This is a volunteer-maintained project; timelines are best effort, and we will keep you informed.

## Advisories in third-party components

Advisories in our dependencies (npm packages, GitHub Actions, container base images) are handled on a clock that starts
when we learn of an advisory that affects a version we ship:

| Severity of the advisory | Target to update, replace or mitigate |
|---|---|
| Critical | 7 days |
| High | 14 days |
| Moderate | 30 days |
| Low | The next scheduled dependency update, or 90 days |

A fix that needs a major upgrade, or that no maintainer has released, may take longer; we then record the reason, the
mitigation and whether the vulnerable code is reachable from agility-bridge. New dependency versions wait 3 days before
they can be installed (`minimumReleaseAge` in `pnpm-workspace.yaml`), except security updates.

## Scope

In scope: code in this repository, the published npm package, container images and release artifacts.

Especially interesting:

- bypassing authentication, or a workspace's or grant's limits on Agility projects, asset types, tools or writes
- reading another member's or workspace's credentials or data
- query injection: caller input reaching Agility other than as a bound parameter or a validated identifier
  ([ADR-0012](docs/adr/0012-structured-query-no-raw-passthrough.md))
- a write without the required human approval, or an approval that does not match the change applied
  ([ADR-0013](docs/adr/0013-opt-in-writes-human-approval.md))
- leaks of Agility access tokens, `ab_` device tokens, OAuth tokens or the master key (logs, errors, tool output)
- OAuth flow flaws (redirects, PKCE, audience and resource binding, client registration)
- admin panel XSS, CSRF or clickjacking
- supply-chain weaknesses in our build and release pipeline

Out of scope: vulnerabilities in Digital.ai Agility, Cloudflare or MCP clients themselves (report those to the vendor);
prompt-injection behaviour of an AI model on content that agility-bridge already marks as untrusted data, unless it
bypasses an agility-bridge control; denial of service that needs unrealistic traffic volumes; findings from automated
scanners without a demonstrated impact.

## Safe harbour

We will not pursue legal action for good-faith research that respects this policy: test only against your own
deployments and Agility instances you are authorised to use, avoid accessing other people's data, and give us
reasonable time to fix before disclosure.

## Our practices

See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) (threats, mitigations and the tasks that implement them) and
[`docs/security/repo-settings.md`](docs/security/repo-settings.md) (repository protections).

## Security acknowledgements

Thank you to everyone who reports a vulnerability or reviews agility-bridge. Credit is given with the reporter's
consent.

_No acknowledgements yet._
