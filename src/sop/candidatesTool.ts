/**
 * brain_sop_candidates — List auto-discovered SOP candidates for an identity.
 *
 * Returns candidates ordered by frequency (occurrences DESC) then recency.
 * Each candidate shows the normalized sequence, occurrence count, and
 * example sessions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HomeDb } from '../home/db.js';

// ── Types ──────────────────────────────────────────────────────────────

interface SopCandidateRow {
  id: number;
  identity_name: string;
  sequence: string;           // JSON array of [tool_name, primary_arg]
  tool_kinds: number;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  example_session_ids: string; // JSON array
  promoted_sop_id: number | null;
}

// ── Tool registration ──────────────────────────────────────────────────

export interface CandidatesToolDeps {
  db: HomeDb['db'];
  getCurrentIdentity(): string | undefined;
}

export function registerSopCandidatesTool(server: McpServer, deps: CandidatesToolDeps): void {
  server.tool(
    'brain_sop_candidates',
    {
      name: z
        .string()
        .optional()
        .describe("Identity to inspect. Defaults to current identity."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max candidates to return. Default 20.'),
      include_promoted: z
        .boolean()
        .optional()
        .describe('Include already-promoted candidates. Default false.'),
    },
    async (rawArgs) => {
      const args = rawArgs as { name?: string; limit?: number; include_promoted?: boolean };

      const targetName = args.name ?? deps.getCurrentIdentity();
      if (!targetName) {
        return {
          content: [{ type: 'text', text: 'No identity specified and no current identity found.' }],
          isError: true,
        };
      }

      const limit = args.limit ?? 20;
      const includePromoted = args.include_promoted ?? false;

      const stmt = deps.db.prepare(`
        SELECT id, sequence, tool_kinds, occurrences, first_seen_at, last_seen_at,
               example_session_ids, promoted_sop_id
        FROM sop_candidates
        WHERE identity_name = ? ${includePromoted ? '' : 'AND promoted_sop_id IS NULL'}
        ORDER BY occurrences DESC, last_seen_at DESC
        LIMIT ?
      `);

      const rows = stmt.all(targetName, limit) as SopCandidateRow[];

      if (rows.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No SOP candidates found for "${targetName}".\n\nCandidates appear automatically as repeated tool-call patterns are observed across sessions.`,
            },
          ],
        };
      }

      const lines: string[] = [
        `# SOP Candidates — ${targetName} (${rows.length} found)`,
        '',
      ];

      for (const row of rows) {
        let steps: [string, string][] = [];
        try {
          steps = JSON.parse(row.sequence);
        } catch { /* ignore */ }

        const promoted = row.promoted_sop_id ? ` [promoted → SOP #${row.promoted_sop_id}]` : '';
        const lastSeen = new Date(row.last_seen_at).toISOString().slice(0, 10);
        const stepNames = steps.map((s) => s[0]).join(' → ');

        lines.push(`## Candidate #${row.id}${promoted}`);
        lines.push(`  Sequence: ${stepNames}`);
        lines.push(`  Occurrences: ${row.occurrences} across distinct sessions`);
        lines.push(`  Tool diversity: ${row.tool_kinds} distinct tools`);
        lines.push(`  Last seen: ${lastSeen}`);

        // Show the full sequence with args
        for (const [tool, arg] of steps) {
          lines.push(`    → ${tool}${arg ? ` (${arg})` : ''}`);
        }
        lines.push('');
      }

      lines.push(
        '_Promote a candidate with `identity_sop_promote { candidate_id: ..., title: "..." }`._',
      );

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
