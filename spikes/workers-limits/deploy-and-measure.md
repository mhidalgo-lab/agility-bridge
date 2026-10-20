# P0-09 owner checklist: production measurements

What needs the owner's Cloudflare account. Deploy the spike Worker for a short session, measure, then delete everything.
No Agility token and no account ids are committed; the Worker serves synthetic data only.

## 1. Deploy

```sh
cd spikes/workers-limits && pnpm install
pnpm exec wrangler login
pnpm exec wrangler d1 create agility-bridge-spike   # copy the database_id into a git-ignored wrangler.deploy.jsonc
pnpm exec wrangler deploy -c wrangler.deploy.jsonc
```

`wrangler.deploy.jsonc` is `wrangler.jsonc` with the real `database_id` and `"workers_dev": true`. Add it to
`.git/info/exclude` (it holds an account-specific id).

## 2. Measure (Free plan first, then Paid if available)

1. **CPU per payload:** call `/bench?size=10000`, `100000`, `524288`, `1000000`, `5000000` 50 times each, in separate
   minutes. Read `$workers.cpuTimeMs` and `outcome` from Workers Logs (or the `workersInvocationsAdaptive` analytics
   dataset). Note any `exceededCpu` / error 1102.
2. **Cold starts:** redeploy, then call `/bench?size=10000` once; repeat five times.
3. **Byte cap:** `/bench?size=1000000&cap=524288` must fail with the cap error, not a CPU kill.
4. **Storage:** `/d1` on the real D1 must match the local table in RESULTS.md §4 (especially `changes: 2` on the
   cascade).
5. **Private CA:** `/tls?url=https://self-signed.badssl.com/` and `https://untrusted-root.badssl.com/` must fail; record
   the exact error text.
6. **Cache API and Rate Limiting** (optional for P0-09, required before P3-03): add a cached route and a Rate Limiting
   binding, then compare `workers.dev` with a custom domain.

## 3. Record and clean up

- Copy the numbers into RESULTS.md (new section "Production", with the date and the plan) and into RESEARCH §5.
- `pnpm exec wrangler delete` and `pnpm exec wrangler d1 delete agility-bridge-spike`.
