// SPDX-License-Identifier: Apache-2.0
import { REDACTED } from './redact.ts';

/** `util.inspect` hook (Node); a plain global symbol, so no `node:util` import is needed. */
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/**
 * Holds a secret (an Agility access token) so that it cannot leak through logging, string interpolation, JSON
 * serialisation or `util.inspect` (THREAT_MODEL T8). The only way to read it is `reveal()`, called at the single point
 * where the value goes on the wire (the Agility client, P1-02).
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    Object.defineProperty(this, INSPECT_CUSTOM, { value: () => REDACTED, enumerable: false });
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }
}
