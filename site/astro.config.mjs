// SPDX-License-Identifier: Apache-2.0
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';

// The Pages project site is https://mhidalgo-lab.github.io/agility-bridge/. The deploy workflow passes the values from
// actions/configure-pages; unset or empty means these defaults (a fork or a custom domain sets them).
const site = process.env.DOCS_SITE || 'https://mhidalgo-lab.github.io';
const base = process.env.DOCS_BASE || '/agility-bridge';

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: 'agility-bridge',
      description:
        'Unofficial MCP server for Digital.ai Agility: guides, reference, security and design records.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/mhidalgo-lab/agility-bridge' }],
      // Pagefind search is built in; no setup needed.
      components: { Footer: './src/components/Footer.astro' },
      // Internal links and anchors are checked on every build (the sync step writes links with the base path).
      plugins: [starlightLinksValidator()],
      // Mirrors docs/ (tasks/ and pending-decisions/ stay out of the site, D-361).
      sidebar: [
        { label: 'Guide', items: [{ autogenerate: { directory: 'guide' } }] },
        { label: 'Reference', collapsed: true, items: [{ autogenerate: { directory: 'reference' } }] },
        { label: 'Developers', collapsed: true, items: [{ autogenerate: { directory: 'dev' } }] },
        {
          label: 'Security',
          collapsed: true,
          items: [{ slug: 'threat_model' }, { autogenerate: { directory: 'security' } }],
        },
        {
          label: 'Architecture',
          collapsed: true,
          items: [{ slug: 'architecture' }, { autogenerate: { directory: 'adr' } }],
        },
        {
          label: 'Project',
          collapsed: true,
          items: [
            { slug: 'roadmap' },
            { slug: 'lessons-learned' },
            { slug: 'research' },
            { label: 'Research notes', items: [{ autogenerate: { directory: 'research' } }] },
            { label: 'Phase reviews', items: [{ autogenerate: { directory: 'reviews' } }] },
          ],
        },
      ],
    }),
  ],
});
