/**
 * SOP signature hashing — re-exported from normalizer.ts.
 *
 * The hashing functions (hashSequence, levenshteinSkipHashes) live in
 * normalizer.ts since they operate on normalized step sequences.
 * This module re-exports them for consumers that import by module name.
 */

export { hashSequence, levenshteinSkipHashes } from './normalizer.js';
export type { NormalizedStep } from './normalizer.js';
