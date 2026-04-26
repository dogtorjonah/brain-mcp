/**
 * Zod helpers tolerant of LLM tool-call serializers that stringify scalar args.
 *
 * ── The bug these helpers fix ──
 * Many MCP clients (and other agent tool transports) serialize numeric and
 * boolean tool-call arguments as JSON strings. For example:
 *   - boolean `true`  → "true"
 *   - boolean `false` → "false"
 *   - number  `100`   → "100"
 * Strict `z.boolean()` / `z.number()` then reject those with
 *   "Invalid input: expected boolean, received string"
 *   "Invalid input: expected number, received string"
 * — silently breaking perfectly valid tool calls from those clients.
 *
 * ── Why not z.coerce.boolean() ──
 * `z.coerce.boolean()` calls `Boolean(x)` under the hood, which means
 * `Boolean("false") === true`. Any non-empty string — including the word
 * "false" — becomes `true`. That's a dangerous footgun: an agent passing
 * `force: "false"` would accidentally force the operation. We explicitly
 * map the strings "true" / "false" (case- and whitespace-insensitive) and
 * leave every other value untouched so strict `z.boolean()` still rejects
 * junk like "yes" / "1" / numbers / objects.
 *
 * ── Why z.coerce.number() is used as-is ──
 * `z.coerce.number()` calls `Number(x)`. It converts "100" → 100 correctly,
 * and for non-numeric strings returns NaN which `z.number()` rejects
 * (NaN check is default in Zod v3.11+). It does convert "" → 0, which is a
 * known quirk but acceptable for our MCP use case where callers intending
 * empty/absent should simply omit the argument.
 *
 * ── Usage ──
 * Import these helpers in EVERY MCP-exposed tool schema (anything passed to
 * the Claude Agent SDK's `tool(...)` second argument, or registered with the
 * Atlas MCP server) and use them in place of `z.boolean()` and `z.number()`
 * for scalar arguments. Internal types / non-MCP Zod usage can remain strict.
 */
import { z } from 'zod';

/**
 * Preprocessor that maps "true"/"false" strings (case/whitespace insensitive)
 * to real booleans. Any other value passes through unchanged so the inner
 * `z.boolean()` still rejects non-booleans.
 */
function booleanStringPreprocess(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const lower = value.trim().toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  return value;
}

/**
 * Boolean schema tolerant of "true"/"false" JSON strings from MCP clients.
 * Returns optional-compatible schema (use with `.optional()` chaining when
 * callers expect the bare type).
 */
export const coercedBoolean = z.preprocess(booleanStringPreprocess, z.boolean());

/**
 * Optional boolean. Prefer this over `coercedBoolean.optional()` — the
 * preprocess runs before the outer optional, so writing `.optional()` on the
 * outside keeps the schema shape predictable.
 */
export const coercedOptionalBoolean = z.preprocess(booleanStringPreprocess, z.boolean().optional());

/**
 * Number schema tolerant of JSON string inputs ("100" → 100).
 * Non-numeric strings coerce to NaN which `z.number()` rejects by default.
 */
export const coercedNumber = z.coerce.number();

/** Optional version of coercedNumber. */
export const coercedOptionalNumber = z.coerce.number().optional();

/**
 * Integer schema tolerant of JSON string inputs ("100" → 100). Rejects
 * non-integer floats and non-numeric strings.
 */
export const coercedInt = z.coerce.number().int();

/** Optional integer version. */
export const coercedOptionalInt = z.coerce.number().int().optional();
