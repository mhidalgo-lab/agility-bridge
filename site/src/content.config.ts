// SPDX-License-Identifier: Apache-2.0
import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// The content is generated from ../docs by `pnpm sync` (scripts/docs-site.ts): never edit it by hand.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
