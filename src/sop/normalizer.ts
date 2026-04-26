/**
 * SOP sequence normalizer — extracts tool-call sequences from transcript
 * chunks and normalizes them into hashable signatures.
 *
 * A SOP candidate is a sequence of (tool_name, primary_arg) tuples where:
 *   - tool_name is the MCP tool name (e.g., "atlas_query", "Edit", "Bash")
 *   - primary_arg is a stable key argument (file_path for file tools,
 *     command-prefix for Bash, action for atlas tools)
 *
 * Sequences are ≥N steps long (default 3) and must appear ≥M times
 * (default 3) across distinct sessions for the same identity.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

// ── Types ──────────────────────────────────────────────────────────────

/** A single step in a normalized tool-call sequence. */
export interface NormalizedStep {
  toolName: string;
  primaryArg: string;
}

/** A mined sequence with metadata. */
export interface MinedSequence {
  /** The normalized steps. */
  steps: NormalizedStep[];
  /** SHA-256 hash of the normalized sequence. */
  signatureHash: string;
  /** Number of distinct tool kinds in the sequence. */
  toolKinds: number;
  /** Session ID this sequence was mined from. */
  sessionId: string;
  /** Identity name. */
  identityName: string;
  /** Epoch ms of the first step. */
  timestampMs: number;
}

// ── Configuration ──────────────────────────────────────────────────────

export interface NormalizerConfig {
  /** Minimum sequence length to consider. Default 3. */
  minSequenceLength?: number;
  /** Maximum sequence length to consider. Default 8. */
  maxSequenceLength?: number;
  /** Minimum distinct tool kinds in a sequence. Default 2. */
  minToolKinds?: number;
  /** Maximum fraction of steps that can share the same primary_arg. Default 0.8. */
  maxPathSpecificity?: number;
}

const DEFAULT_CONFIG: Required<NormalizerConfig> = {
  minSequenceLength: 3,
  maxSequenceLength: 8,
  minToolKinds: 2,
  maxPathSpecificity: 0.8,
};

// ── Step extraction ────────────────────────────────────────────────────

/**
 * Extract the primary argument from a tool_call chunk.
 *
 * Primary arg is something stable:
 *   - file_path / filePath / path for file tools (Read, Edit, Write)
 *   - command prefix (first word) for Bash
 *   - action for composite tools (atlas_query, atlas_admin, etc.)
 *   - query for search tools
 */
export function extractPrimaryArg(toolName: string, toolInput?: Record<string, unknown>): string {
  if (!toolInput) return '';

  // File tools: use the file path
  for (const key of ['file_path', 'filePath', 'path']) {
    const v = toolInput[key];
    if (typeof v === 'string' && v.length > 0) {
      // Normalize: keep only the basename to reduce path-specificity
      const parts = v.split('/');
      return parts.length > 1 ? parts.slice(-2).join('/') : v;
    }
  }

  // Bash: use the command prefix (first word)
  if (toolName === 'Bash' || toolName === 'bash') {
    const cmd = toolInput['command'] ?? toolInput['script'];
    if (typeof cmd === 'string') {
      return cmd.trim().split(/\s+/)[0] ?? '';
    }
  }

  // Composite tools: use the action
  if (toolName.startsWith('atlas_') || toolName.startsWith('brain_')) {
    const action = toolInput['action'];
    if (typeof action === 'string' && action.length > 0) {
      return action;
    }
  }

  // Search tools: use query (truncated)
  for (const key of ['query', 'search', 'q']) {
    const v = toolInput[key];
    if (typeof v === 'string' && v.length > 0) {
      return v.slice(0, 40);
    }
  }

  return '';
}

// ── Sequence mining ────────────────────────────────────────────────────

interface ToolCallRow {
  chunk_id: string;
  session_id: string;
  tool_name: string;
  file_paths: string;  // JSON
  text: string;
  timestamp_ms: number;
}

/**
 * Mine tool-call sequences from a session's chunks.
 *
 * Returns all sequences of length [minLen, maxLen] from the session's
 * tool_call chunks, after normalization.
 */
export function mineSequencesFromSession(
  chunks: ToolCallRow[],
  identityName: string,
  config?: NormalizerConfig,
): MinedSequence[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const results: MinedSequence[] = [];

  if (chunks.length < cfg.minSequenceLength) return results;

  // Normalize each chunk to a step
  const steps: NormalizedStep[] = [];
  const stepMeta: { sessionId: string; timestampMs: number }[] = [];

  for (const chunk of chunks) {
    if (!chunk.tool_name) continue;

    // Parse file_paths to extract primary arg (prefer file paths from metadata)
    let primaryArg = '';
    try {
      const paths: string[] = JSON.parse(chunk.file_paths || '[]');
      if (paths.length > 0) {
        // Normalize path: keep last 2 components
        const parts = paths[0].split('/');
        primaryArg = parts.length > 1 ? parts.slice(-2).join('/') : paths[0];
      }
    } catch { /* ignore */ }

    // If no path from metadata, try to extract from chunk text
    if (!primaryArg) {
      // The chunk text format is: [tool_call] tool:Name file:path args: {...}
      const pathMatch = chunk.text.match(/file:(\S+)/);
      if (pathMatch) {
        const parts = pathMatch[1].split('/');
        primaryArg = parts.length > 1 ? parts.slice(-2).join('/') : pathMatch[1];
      }
    }

    // Skip internal/noise tools
    if (chunk.tool_name === 'phone_screenshot' ||
        chunk.tool_name === 'phone_device_info' ||
        chunk.tool_name.startsWith('rebirth_')) {
      continue;
    }

    steps.push({ toolName: chunk.tool_name, primaryArg });
    stepMeta.push({ sessionId: chunk.session_id, timestampMs: chunk.timestamp_ms });
  }

  if (steps.length < cfg.minSequenceLength) return results;

  // Extract all valid subsequences
  for (let len = cfg.minSequenceLength; len <= Math.min(steps.length, cfg.maxSequenceLength); len++) {
    for (let start = 0; start <= steps.length - len; start++) {
      const seq = steps.slice(start, start + len);
      const meta = stepMeta[start];

      // Filter: must have ≥ minToolKinds distinct tool kinds
      const uniqueTools = new Set(seq.map((s) => s.toolName));
      if (uniqueTools.size < cfg.minToolKinds) continue;

      // Filter: not path-specific (>maxPathSpecificity of steps share same arg)
      const argCounts = new Map<string, number>();
      for (const s of seq) {
        if (s.primaryArg) {
          argCounts.set(s.primaryArg, (argCounts.get(s.primaryArg) ?? 0) + 1);
        }
      }
      const maxArgCount = Math.max(...argCounts.values(), 0);
      if (maxArgCount / seq.length > cfg.maxPathSpecificity) continue;

      // Hash the normalized sequence
      const hashInput = seq.map((s) => `${s.toolName}::${s.primaryArg}`).join('|');
      const signatureHash = createHash('sha256').update(hashInput).digest('hex');

      results.push({
        steps: seq,
        signatureHash,
        toolKinds: uniqueTools.size,
        sessionId: meta.sessionId,
        identityName,
        timestampMs: meta.timestampMs,
      });
    }
  }

  return results;
}

// ── Hashing with Levenshtein-1 tolerance ───────────────────────────────

/**
 * Compute the signature hash for a normalized step sequence.
 */
export function hashSequence(steps: NormalizedStep[]): string {
  const hashInput = steps.map((s) => `${s.toolName}::${s.primaryArg}`).join('|');
  return createHash('sha256').update(hashInput).digest('hex');
}

/**
 * Generate all Levenshtein-1 variants of a sequence hash.
 *
 * Levenshtein-1 means: one insertion OR one deletion OR one substitution
 * relative to the original sequence. We generate hash variants for:
 * 1. The original sequence (exact match)
 * 2. Sequences with one step deleted (skip each position)
 *
 * We do NOT generate all possible insertions (too many) or substitutions
 * (requires knowing all possible tool names). Instead, the matching
 * algorithm checks insertion by comparing both directions.
 */
export function levenshteinSkipHashes(steps: NormalizedStep[]): string[] {
  const hashes: string[] = [];

  // Exact match
  hashes.push(hashSequence(steps));

  // One deletion: skip each position
  for (let i = 0; i < steps.length; i++) {
    const shorter = [...steps.slice(0, i), ...steps.slice(i + 1)];
    if (shorter.length >= 2) {  // Don't go below 2 steps
      hashes.push(hashSequence(shorter));
    }
  }

  return hashes;
}
