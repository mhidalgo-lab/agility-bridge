// SPDX-License-Identifier: Apache-2.0
// Drives a redirect provider through authorization and completion against a fake IdP.
import type { AuthorizationResult, RedirectIdentityProvider, VerifiedIdentity } from '../../src/index.ts';
import { pkceChallenge, randomValue } from '../../src/index.ts';

export const REDIRECT_URI = 'https://bridge.example.test/auth/callback/test';

export interface Authorizer {
  authorize(url: URL, user?: never): { code: string; state: string };
}

export interface FlowOptions {
  /** Passed to the fake IdP's `authorize` (claims of the user). */
  readonly user?: Record<string, unknown>;
  /** The nonce the callback presents (default: the one in the authorization request). */
  readonly callbackNonce?: string;
  /** The verifier the callback presents (default: the one whose challenge was sent). */
  readonly callbackVerifier?: string;
  readonly issuer?: string;
}

export async function signIn(
  provider: RedirectIdentityProvider,
  idp: { authorize(url: URL, user?: Record<string, unknown>): { code: string; state: string } },
  options: FlowOptions = {},
  hooks?: Parameters<RedirectIdentityProvider['complete']>[1],
): Promise<VerifiedIdentity> {
  const verifier = randomValue();
  const nonce = randomValue();
  const url = await provider.authorizationUrl({
    redirectUri: REDIRECT_URI,
    state: randomValue(),
    nonce,
    codeChallenge: await pkceChallenge(verifier),
  });
  const { code } = idp.authorize(url, options.user);
  const result: AuthorizationResult = {
    code,
    redirectUri: REDIRECT_URI,
    codeVerifier: options.callbackVerifier ?? verifier,
    nonce: options.callbackNonce ?? nonce,
    ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
  };
  return provider.complete(result, hooks);
}
