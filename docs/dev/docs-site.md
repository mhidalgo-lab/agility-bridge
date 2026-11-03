# The documentation site

The site at <https://mhidalgo-lab.github.io/agility-bridge/> is built from this `docs/` folder with
[Astro Starlight](https://starlight.astro.build). `docs/` stays the source of truth: nothing in `site/` is a copy that
you edit. Fix a page here, in `docs/`.

## What is on the site

Everything under `docs/` except `tasks/` and `pending-decisions/` (planning records for maintainers; links from site
pages to them open the file in the repository). The sidebar mirrors the folders: Guide, Reference, Developers
(`dev/`), Security (the threat model and `security/`), Architecture (the architecture page and the ADRs) and Project
(roadmap, lessons, research, phase reviews). Search is Starlight's built-in Pagefind index, built with the site. The
project disclaimer is in the footer of every page.

## Build and preview locally

The site is its own pnpm workspace: the root `pnpm install` does not install it.

```sh
pnpm --dir site install --frozen-lockfile
pnpm --dir site build      # sync docs/ into site/src/content/docs, build, index for search, check every link
pnpm --dir site preview    # serve site/dist at http://localhost:4321/agility-bridge/
```

`pnpm --dir site dev` runs the development server (it syncs first; re-run it after editing `docs/`). From the repository
root, `pnpm docs:site` is the same build.

## How `docs/` becomes pages

`node scripts/docs-site.ts sync` (run by the site's `build` and `dev` scripts) writes the included pages into
`site/src/content/docs/` (not committed):

- the first `# heading` becomes the page title and is removed from the body, and an "Edit page" link is added;
- a relative link to another page becomes a site link with the base path; a link to an excluded page, a source file or
  a folder becomes a link into the repository on `main`;
- a `README.md` becomes the `index` of its folder (`adr/README.md` is `/adr/`);
- `site/landing.md` is the home page.

## Link checks

- `pnpm docs:links` (also part of `pnpm lint`): every relative link in `docs/`, including links that leave it, must
  reach a file or folder, and a `#anchor` must match a heading of the target (GitHub-style slugs).
- The site build runs `starlight-links-validator`: an invalid internal link or anchor in the built pages fails the
  build. External links are not checked in CI (D-364).

To see the checker work, append `[x](../guide/nope.md)` to a page and run `pnpm docs:links`.

## Deployment

`.github/workflows/docs-site.yml` builds and link-checks the site on pull requests that touch `docs/`, `site/` or the
sync script. On `main` it also deploys to GitHub Pages, but only when Pages is enabled with the GitHub Actions source
(repository Settings, Pages, Source: GitHub Actions); until then the run warns and skips the deploy. The deploy job
holds `pages: write` and `id-token: write` and runs no project code.

Pinned versions (Astro, Starlight, the link validator) live in `site/package.json`; they follow the same 3-day release
age as the rest of the repository (`site/pnpm-workspace.yaml`).
