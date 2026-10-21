// SPDX-License-Identifier: Apache-2.0

/** One forward-only migration: statements run in order, atomically, with its `schema_migrations` row. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  /** One SQL statement per entry (D1 batches cannot split scripts; triggers contain semicolons). */
  readonly statements: readonly string[];
}
