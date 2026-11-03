// SPDX-License-Identifier: Apache-2.0
// P9-03: the mock Agility of scripts/perf/mock-agility.ts as a Worker (`agility-bridge-spike-perf-mock`), so the
// staging Worker can be measured without a real tenant. Synthetic data only; delete it after the run.
import { createMock, MOCK_ORIGIN } from '../../scripts/perf/mock-agility.ts';

const mock = createMock();

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__count') return Response.json({ served: mock.count() });
    return mock.handle(new Request(`${MOCK_ORIGIN}${url.pathname}${url.search}`, request));
  },
};
