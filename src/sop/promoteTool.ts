/**
 * identity_sop_promote — Promote an auto-discovered SOP candidate into
 * a real SOP in the identity_sops table.
 *
 * This bridges the auto-discovery system with the manually-curated SOP
 * system. Once promoted, the SOP appears in handoffs and identity
 * descriptions like any hand-written SOP.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HomeDb } from '../home/db.js';

// ── Tool registration ──────────────────────────────────────────────────

export interface PromoteToolDeps {
  db: HomeDb['db'];
  getCurrentIdentity(): string | undefined;
  getCurrentSession(): string | null;
}

export function registerSopPromoteTool(server: McpServer, deps: PromoteToolDeps): void {
  server.tool(
    'identity_sop_promote',
    {
      candidate_id: z
        .number()
        .int()
        .positive()
        .describe('The sop_candidates.id to promote.'),
      title: z
        .string()
        .min(1)
        .describe('Short headline for the promoted SOP (one line, ~80 chars).'),
      body: z
        .string()
        .optional()
        .describe('Optional context: when this pattern applies, why it matters.'),
    },
    async (rawArgs) => {
      const args = rawArgs as { candidate_id: number; title: string; body?: string };

      const { db } = deps;
      const session = deps.getCurrentSession();

      // Look up the candidate
      const candidate = db.prepare(
        'SELECT id, identity_name, sequence, occurrences FROM sop_candidates WHERE id = ?',
      ).get(args.candidate_id) as
        | { id: number; identity_name: string; sequence: string; occurrences: number }
        | undefined;

      if (!candidate) {
        return {
          content: [{ type: 'text', text: `SOP candidate #${args.candidate_id} not found.` }],
          isError: true,
        };
      }

      // Check if already promoted
      const alreadyPromoted = db.prepare(
        'SELECT promoted_sop_id FROM sop_candidates WHERE id = ? AND promoted_sop_id IS NOT NULL',
      ).get(args.candidate_id) as { promoted_sop_id: number } | undefined;

      if (alreadyPromoted) {
        return {
          content: [
            {
              type: 'text',
              text: `Candidate #${args.candidate_id} is already promoted (SOP #${alreadyPromoted.promoted_sop_id}).`,
            },
          ],
        };
      }

      // Build the SOP body from the candidate sequence + optional user body
      let steps: [string, string][] = [];
      try {
        steps = JSON.parse(candidate.sequence);
      } catch { /* ignore */ }

      const autoBody = [
        `Auto-discovered from ${candidate.occurrences} observations across sessions.`,
        '',
        'Pattern:',
        ...steps.map(([tool, arg]) => `  → ${tool}${arg ? ` (${arg})` : ''}`),
      ].join('\n');

      const fullBody = args.body ? `${args.body}\n\n${autoBody}` : autoBody;

      // Insert into identity_sops
      const now = Date.now();
      const insertResult = db.prepare(
        `INSERT INTO identity_sops (identity_name, title, body, created_ms, updated_ms, created_by_session)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(candidate.identity_name, args.title.trim(), fullBody, now, now, session);

      const sopId = Number(insertResult.lastInsertRowid);

      // Link the candidate to the promoted SOP
      db.prepare('UPDATE sop_candidates SET promoted_sop_id = ? WHERE id = ?').run(sopId, args.candidate_id);

      const lines = [
        `Promoted candidate #${args.candidate_id} → SOP #${sopId} for "${candidate.identity_name}".`,
        '',
        `Title: ${args.title}`,
        `Observed: ${candidate.occurrences} times before promotion.`,
        '',
        'The SOP will appear in future handoffs and identity descriptions.',
        'Edit with `identity_sop_update` or retract with `identity_sop_remove`.',
      ].join('\n');

      return { content: [{ type: 'text', text: lines }] };
    },
  );
}
