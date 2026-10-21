#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { main } from './main.ts';

const result = await main(process.argv.slice(2), {
  env: process.env,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
if (result !== 'serving') process.exitCode = result;
