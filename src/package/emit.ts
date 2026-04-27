import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Managed-block writer for CLAUDE.md (or any markdown file Claude Code
 * loads inline on session start).
 *
 * The hook stdout channel caps payload size (~2KB preview, rest persisted
 * to a file the model usually can't read inline). CLAUDE.md is loaded
 * verbatim with no cap, so writing the rebirth handoff into a sentinel
 * block there is the cleanest way to ship large packages inline.
 *
 * Design:
 *   - Bounded by BEGIN/END sentinels so repeated writes are idempotent
 *     and never clobber user-authored content above or below the block.
 *   - If the file doesn't exist, creates it with a leading banner and the
 *     managed block.
 *   - If the file exists but has no sentinels, appends the managed block
 *     at the end with a blank-line separator.
 *   - If the file exists and has sentinels, replaces only the content
 *     between them — everything outside is untouched byte-for-byte.
 *
 * The sentinels themselves are HTML comments so they render invisibly in
 * any markdown viewer and survive round-trips through editors that don't
 * parse markdown (they're just literal lines).
 */

export const BEGIN_SENTINEL = '<!-- BEGIN REBIRTH (auto-managed by rebirth-mcp; do not edit this block) -->';
export const END_SENTINEL = '<!-- END REBIRTH -->';

export interface WriteManagedBlockResult {
  path: string;
  bytes: number;
  mode: 'created' | 'appended' | 'replaced';
}

/**
 * Idempotently write `markdown` into the managed block inside `path`.
 *
 * @param path     Absolute or cwd-relative path to the target markdown file.
 * @param markdown Handoff content to place between the sentinels. Should NOT
 *                 itself contain the sentinel strings (we guard anyway).
 */
export async function writeManagedBlock(
  path: string,
  markdown: string,
): Promise<WriteManagedBlockResult> {
  // Guard: if the caller's markdown accidentally embeds our sentinels we'd
  // corrupt the next round-trip. Strip any literal occurrences so the
  // managed region stays delimitable.
  const safeMarkdown = markdown
    .replaceAll(BEGIN_SENTINEL, '<!-- BEGIN REBIRTH (stripped) -->')
    .replaceAll(END_SENTINEL, '<!-- END REBIRTH (stripped) -->');

  const block = `${BEGIN_SENTINEL}\n${safeMarkdown.trimEnd()}\n${END_SENTINEL}\n`;

  let existing: string | null = null;
  try {
    existing = await fs.readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }

  let next: string;
  let mode: WriteManagedBlockResult['mode'];

  if (existing === null) {
    next = `# CLAUDE.md\n\nThis file is loaded inline at the start of every Claude Code session.\nThe block below is auto-managed by rebirth-mcp; content above and below is preserved.\n\n${block}`;
    mode = 'created';
  } else {
    const beginIdx = existing.indexOf(BEGIN_SENTINEL);
    const endIdx = existing.indexOf(END_SENTINEL, beginIdx + BEGIN_SENTINEL.length);
    if (beginIdx >= 0 && endIdx > beginIdx) {
      // Replace the entire BEGIN…END region (including sentinels) with
      // the freshly-rendered block. Preserve everything before/after.
      const before = existing.slice(0, beginIdx);
      const after = existing.slice(endIdx + END_SENTINEL.length);
      // Strip a single trailing newline from `before` if present so we
      // don't accumulate blank lines on repeated writes, then reattach
      // exactly one.
      const beforeTrimmed = before.endsWith('\n') ? before : `${before}\n`;
      // Same for after: preserve its content but ensure we end with
      // exactly one newline between END and whatever follows.
      const afterTrimmed = after.startsWith('\n') ? after : `\n${after}`;
      next = `${beforeTrimmed}${block.trimEnd()}${afterTrimmed}`;
      mode = 'replaced';
    } else {
      // Append with a blank-line separator so the block stands off from
      // any trailing user content.
      const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
      next = `${existing}${separator}${block}`;
      mode = 'appended';
    }
  }

  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, next, 'utf8');

  return {
    path,
    bytes: Buffer.byteLength(next, 'utf8'),
    mode,
  };
}
