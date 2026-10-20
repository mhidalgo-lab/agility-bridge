// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  dts: false,
  clean: true,
});
