// SPDX-License-Identifier: Apache-2.0
// A Worker for the OAuth suite (P5-01): the shipped Worker with the consent stand-in of the tests, because the shipped
// one has no consent screen until P5-04 and refuses `AB_OAUTH=on`. Bundled by the test itself; never deployed.
import { VERSION } from '@agility-bridge/core';
import { testConsent } from '../../../../packages/http-app/test/oauth/consent.ts';
import { boot } from '../../src/boot.ts';
import { createWorker } from '../../src/index.ts';

export default createWorker((env) => boot(env, VERSION, testConsent));
