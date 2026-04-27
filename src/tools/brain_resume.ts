/**
 * brain_resume — "Where did I leave off?"
 *
 * Returns open hazards surfaced by the identity (not yet resolved),
 * recent atlas_commit edges, files last touched, active SOPs, and a
 * synthesized next-step hint.
 *
 * Design doc: §12.2
 */

import type { HomeDb } from '../home/db.js';
import type { IdentityStore } from '../identity/store.js';
import type { EdgeEmitter } from '../edges/emitter.js';

type DatabaseType = HomeDb['db'];

export interface BrainResumeDeps {
  homeDb: HomeDb;
  identityStore: IdentityStore;
  edgeEmitter: EdgeEmitter;
  getCurrentIdentity: () => string | undefined;
  getCurrentSessionId: () => string | undefined;
}

export function registerBrainResumeTool(server: unknown, deps: BrainResumeDeps): void {
  const srv = server as {
    tool: (name: string, description: string, schema: unknown, handler: (args: unknown) => Promise<unknown>) => void;
  };

  srv.tool(
    'brain_resume',
    'Where did I leave off? Open hazards, recent commits, files last touched, active SOPs, next-step hint.',
    {
      type: 'object',
      properties: {
        identity: { type: 'string', description: 'Identity name. Default = current identity.' },
        workspace: { type: 'string', description: 'Workspace to scope to. Default = all.' },
        limit_open_hazards: { type: 'number', description: 'Max open hazards. Default 20.' },
        include_atlas_context: { type: 'boolean', description: 'Include atlas file blurbs. Default true.' },
      },
    },
    async (argsRaw: unknown) => handleBrainResume(deps, argsRaw),
  );
}

async function handleBrainResume(deps: BrainResumeDeps, argsRaw: unknown): Promise<unknown> {
  const args = argsRaw as Record<string, unknown>;
  const identityName = (args.identity as string) || deps.getCurrentIdentity() || 'unknown';
  const workspace = args.workspace as string | undefined;
  const limitHazards = (args.limit_open_hazards as number) ?? 20;
  const includeAtlasContext = (args.include_atlas_context as boolean) ?? true;

  const db: DatabaseType = deps.homeDb.db;
  const now = Date.now();

  // 1. Identity profile
  const profile = deps.identityStore.getProfile(identityName);
  const specialtySig = deps.identityStore.getSpecialtySignature(identityName);

  // 2. Open hazards (surfaced but not resolved)
  const openHazards = deps.edgeEmitter.getOpenHazards(identityName, {
    workspace,
    limit: limitHazards,
  });

  // 3. Recent commit edges
  const recentCommits = deps.edgeEmitter.query({
    identityName,
    workspace,
    kind: 'commit',
    limit: 10,
  });

  // 4. Files last touched (top files by this identity)
  const topFiles = deps.edgeEmitter.getTopFiles(identityName, 15);

  // 5. Active SOPs
  const sops = deps.identityStore.listSops(identityName);

  // 6. Chain events (recent activity)
  const recentChain = deps.identityStore.getRecentChain(identityName, 10);

  // 7. Handoff note
  const handoffNote = deps.identityStore.getHandoffNote(identityName);

  // 8. Compute age_days for open hazards
  const openHazardsWithAge = openHazards.map(h => ({
    workspace: h.workspace,
    file_path: h.filePath,
    hazard: h.hazard,
    surfaced_at: h.surfacedAt,
    surfaced_at_changelog_id: h.changelogId,
    age_days: Math.round((now - h.surfacedAt) / 86_400_000),
  }));

  // 9. Recent commits with timestamp
  const recentCommitsFormatted = recentCommits.map(c => ({
    workspace: c.workspace,
    file_path: c.filePath,
    changelog_id: c.changelogId,
    ts: c.ts,
    age_minutes: Math.round((now - c.ts) / 60_000),
  }));

  // 10. Files last touched with context
  const filesFormatted = topFiles.map(f => ({
    workspace: f.workspace,
    file_path: f.filePath,
    last_touched_at: f.lastTouchAt,
    my_edge_count: f.edgeCount,
  }));

  // 11. Next-step hint synthesis (§12.2.1)
  const hints: string[] = [];

  if (openHazardsWithAge.length > 0) {
    const oldest = openHazardsWithAge.reduce((a, b) => a.age_days > b.age_days ? a : b);
    hints.push(`Address hazard "${oldest.hazard}" on ${oldest.workspace}/${oldest.file_path} (open ${oldest.age_days} days).`);
  }

  const oneHourAgo = now - 3_600_000;
  const recentUncommitted = recentCommits.filter(c => c.ts > oneHourAgo);
  if (recentUncommitted.length > 0) {
    const latest = recentUncommitted[0];
    hints.push(`Follow up on ${latest.workspace}/${latest.filePath} — you committed ${Math.round((now - latest.ts) / 60_000)} min ago.`);
  }

  if (sops.length > 0 && filesFormatted.length > 0) {
    const sop = sops[0];
    hints.push(`Active SOP "${sop.title}" applies to ${filesFormatted.length} files you've touched.`);
  }

  if (hints.length === 0) {
    hints.push('No open hazards or recent activity. Ready for new work.');
  }

  return {
    identity: {
      name: identityName,
      blurb: profile?.blurb ?? '',
      specialty_summary: specialtySig
        ? {
            top_clusters: JSON.parse(specialtySig.topClustersJson),
            top_patterns: JSON.parse(specialtySig.topPatternsJson),
            hazards_surfaced: specialtySig.hazardsSurfaced,
            hazards_resolved: specialtySig.hazardsResolved,
          }
        : null,
    },
    open_hazards_owned: openHazardsWithAge,
    recent_commits: recentCommitsFormatted,
    files_last_touched: filesFormatted,
    active_sops: sops.map(s => ({
      id: s.id,
      title: s.title,
      body: s.body.substring(0, 200),
      updated_at: s.updatedAt,
    })),
    handoff_note: handoffNote?.note ?? null,
    recent_chain: recentChain.map(e => ({
      event_kind: e.eventKind,
      ts: e.ts,
      cwd: e.cwd,
    })),
    next_step_hint: hints.join('\n'),
  };
}
