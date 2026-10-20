// SPDX-License-Identifier: Apache-2.0
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer, resolveGrant } from './server.ts';

const grant = resolveGrant(process.env['AB_SPIKE_WORKSPACE'] ?? 'team');
if (!grant) throw new Error('bad AB_SPIKE_WORKSPACE');
serveStdio(({ era }) => buildServer(grant, era));
