/**
 * brain_diff_identities — Compare two identities' patterns, hazards, and
 * file ownership on shared territory.
 *
 * Useful for:
 *   - Collaboration auditing: "Alice and Bob both touch this file; where do
 *     their approaches differ?"
 *   - Skill overlap detection: "Who else knows this subsystem?"
 *   - Handoff planning: "What does identity A know that B doesn't?"
 *
 * Output is a side-by-side diff showing:
 *   - Shared files (both touch)
 *   - Unique files (only one touches)
 *   - Hazard balance (who surfaced more, who resolved more)
 *   - Pattern overlap vs divergence
 *   - Specialty tag comparison
 */

import type { ToolRegistry } from '../daemon/toolRegistry.js';
import type { BrainDaemonRuntime } from '../daemon/runtime.js';
import { safeJsonStringify } from '../daemon/protocol.js';

// ── Types ──────────────────────────────────────────────────────────────

interface DiffArgs {
  identity_a: string;
  identity_b: string;
  /** Optional workspace to scope the comparison. */
  workspace?: string;
  /** Max shared files to show. Default 20. */
  limit?: number;
}

interface FileOwnership {
  workspace: string;
  filePath: string;
  edgeCountA: number;
  edgeCountB: number;
  lastTouchA: number;
  lastTouchB: number;
}

interface HazardDiff {
  hazard: string;
  workspace: string;
  surfacedByA: number;
  surfacedByB: number;
  resolvedByA: number;
  resolvedByB: number;
}

// ── Tool registration ──────────────────────────────────────────────────

export function registerBrainDiffIdentitiesTool(registry: ToolRegistry, runtime: BrainDaemonRuntime): void {
  registry.register(
    {
      name: 'brain_diff_identities',
      description:
        'Compare two identities side by side. Shows shared files, hazard balance, ' +
        'pattern overlap/divergence, and specialty tag differences.',
    },
    async (args: Record<string, unknown>) => {
      const a = args.identity_a as string | undefined;
      const b = args.identity_b as string | undefined;

      if (!a || typeof a !== 'string' || !b || typeof b !== 'string') {
        return {
          content: [{ type: 'text', text: 'Parameters "identity_a" and "identity_b" are required.' }],
          isError: true,
        };
      }

      if (a === b) {
        return {
          content: [{ type: 'text', text: 'Cannot diff an identity against itself.' }],
          isError: true,
        };
      }

      // Verify both identities exist.
      const store = runtime.identityStore;
      const profileA = store.getProfile(a);
      const profileB = store.getProfile(b);

      if (!profileA) {
        return { content: [{ type: 'text', text: `Identity "${a}" not found.` }], isError: true };
      }
      if (!profileB) {
        return { content: [{ type: 'text', text: `Identity "${b}" not found.` }], isError: true };
      }

      const opts: DiffArgs = {
        identity_a: a,
        identity_b: b,
        workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 20,
      };

      const diff = computeDiff(runtime, opts);

      return {
        content: [{ type: 'text', text: formatDiff(diff, profileA, profileB) }],
        structuredContent: diff,
      };
    },
  );
}

// ── Diff computation ───────────────────────────────────────────────────

interface DiffResult {
  identityA: string;
  identityB: string;
  sharedFiles: FileOwnership[];
  uniqueToA: Array<{ workspace: string; filePath: string; edgeCount: number; lastTouch: number }>;
  uniqueToB: Array<{ workspace: string; filePath: string; edgeCount: number; lastTouch: number }>;
  hazardDiffs: HazardDiff[];
  patternOverlap: string[];
  patternsOnlyA: string[];
  patternsOnlyB: string[];
  specialtyA: { tags: string; hazardsSurfaced: number; hazardsResolved: number };
  specialtyB: { tags: string; hazardsSurfaced: number; hazardsResolved: number };
}

function computeDiff(runtime: BrainDaemonRuntime, opts: DiffArgs): DiffResult {
  const { identity_a: a, identity_b: b, workspace, limit } = opts;
  const db = runtime.homeDb.db;
  const wsFilter = workspace ? 'AND workspace = ?' : '';

  // ── File ownership ────────────────────────────────────────────────
  const filesA = getFileOwnership(db, a, workspace);
  const filesB = getFileOwnership(db, b, workspace);

  const fileMapA = new Map(filesA.map((f) => [`${f.workspace}:${f.filePath}`, f]));
  const fileMapB = new Map(filesB.map((f) => [`${f.workspace}:${f.filePath}`, f]));

  const sharedFiles: FileOwnership[] = [];
  const uniqueToA: typeof diffResult.uniqueToA = [];
  const uniqueToB: typeof diffResult.uniqueToB = [];

  for (const [key, fileA] of fileMapA) {
    const fileB = fileMapB.get(key);
    if (fileB) {
      sharedFiles.push({
        workspace: fileA.workspace,
        filePath: fileA.filePath,
        edgeCountA: fileA.edgeCount,
        edgeCountB: fileB.edgeCount,
        lastTouchA: fileA.lastTouch,
        lastTouchB: fileB.lastTouch,
      });
    } else {
      uniqueToA.push(fileA);
    }
  }
  for (const [key, fileB] of fileMapB) {
    if (!fileMapA.has(key)) {
      uniqueToB.push(fileB);
    }
  }

  sharedFiles.sort((x, y) => (y.edgeCountA + y.edgeCountB) - (x.edgeCountA + x.edgeCountB));

  // ── Hazard diff ──────────────────────────────────────────────────
  const hazardDiffs = computeHazardDiffs(db, a, b, workspace);

  // ── Pattern diff ─────────────────────────────────────────────────
  const patternsA = getPatternSet(db, a, workspace);
  const patternsB = getPatternSet(db, b, workspace);

  const patternOverlap = [...patternsA].filter((p) => patternsB.has(p));
  const patternsOnlyA = [...patternsA].filter((p) => !patternsB.has(p));
  const patternsOnlyB = [...patternsB].filter((p) => !patternsA.has(p));

  // ── Specialty signatures ─────────────────────────────────────────
  const specA = runtime.identityStore.getSpecialtySignature(a);
  const specB = runtime.identityStore.getSpecialtySignature(b);

  const profileA = runtime.identityStore.getProfile(a)!;
  const profileB = runtime.identityStore.getProfile(b)!;

  const diffResult: DiffResult = {
    identityA: a,
    identityB: b,
    sharedFiles: sharedFiles.slice(0, limit),
    uniqueToA: uniqueToA.slice(0, limit),
    uniqueToB: uniqueToB.slice(0, limit),
    hazardDiffs: hazardDiffs.slice(0, 30),
    patternOverlap,
    patternsOnlyA: patternsOnlyA.slice(0, 20),
    patternsOnlyB: patternsOnlyB.slice(0, 20),
    specialtyA: {
      tags: profileA.specialtyTags,
      hazardsSurfaced: specA?.hazardsSurfaced ?? 0,
      hazardsResolved: specA?.hazardsResolved ?? 0,
    },
    specialtyB: {
      tags: profileB.specialtyTags,
      hazardsSurfaced: specB?.hazardsSurfaced ?? 0,
      hazardsResolved: specB?.hazardsResolved ?? 0,
    },
  };

  return diffResult;
}

// ── Helper queries ─────────────────────────────────────────────────────

function getFileOwnership(
  db: any,
  identityName: string,
  workspace?: string,
): Array<{ workspace: string; filePath: string; edgeCount: number; lastTouch: number }> {
  const params = workspace ? [identityName, workspace] : [identityName];
  const rows = db.prepare(`
    SELECT workspace, file_path, COUNT(*) AS edge_count, MAX(ts) AS last_touch
    FROM atlas_identity_edges
    WHERE identity_name = ? AND kind != 'lookup'
      ${workspace ? 'AND workspace = ?' : ''}
    GROUP BY workspace, file_path
    ORDER BY edge_count DESC
    LIMIT 100
  `).all(...params) as any[];

  return rows.map((r) => ({
    workspace: r.workspace,
    filePath: r.file_path,
    edgeCount: r.edge_count,
    lastTouch: r.last_touch,
  }));
}

function computeHazardDiffs(db: any, a: string, b: string, workspace?: string): HazardDiff[] {
  // For each hazard that either identity surfaced, count surfaced/resolved.
  const wsFilter = workspace ? 'AND workspace = ?' : '';
  const params = workspace ? [a, b, workspace] : [a, b];

  const rows = db.prepare(`
    SELECT
      COALESCE(sa.detail, sb.detail) AS hazard,
      COALESCE(sa.workspace, sb.workspace) AS ws,
      COALESCE(sa.cnt, 0) AS surfaced_a,
      COALESCE(sb.cnt, 0) AS surfaced_b,
      COALESCE(ra.cnt, 0) AS resolved_a,
      COALESCE(rb.cnt, 0) AS resolved_b
    FROM (
      SELECT detail, workspace, COUNT(*) AS cnt
      FROM atlas_identity_edges WHERE identity_name = ? AND kind = 'surfaced' ${wsFilter}
      GROUP BY detail, workspace
    ) sa
    FULL JOIN (
      SELECT detail, workspace, COUNT(*) AS cnt
      FROM atlas_identity_edges WHERE identity_name = ? AND kind = 'surfaced' ${wsFilter}
      GROUP BY detail, workspace
    ) sb ON sa.detail = sb.detail AND sa.workspace = sb.workspace
    LEFT JOIN (
      SELECT detail, workspace, COUNT(*) AS cnt
      FROM atlas_identity_edges WHERE identity_name = ? AND kind = 'resolved' ${wsFilter}
      GROUP BY detail, workspace
    ) ra ON sa.detail = ra.detail AND sa.workspace = ra.workspace
    LEFT JOIN (
      SELECT detail, workspace, COUNT(*) AS cnt
      FROM atlas_identity_edges WHERE identity_name = ? AND kind = 'resolved' ${wsFilter}
      GROUP BY detail, workspace
    ) rb ON sb.detail = rb.detail AND sb.workspace = rb.workspace
    WHERE COALESCE(sa.detail, sb.detail) IS NOT NULL
    ORDER BY (COALESCE(sa.cnt, 0) + COALESCE(sb.cnt, 0)) DESC
    LIMIT 30
  `).all(...(workspace ? [a, workspace, b, workspace, a, workspace, b, workspace] : [a, b, a, b])) as any[];

  return rows.map((r) => ({
    hazard: r.hazard,
    workspace: r.ws,
    surfacedByA: r.surfaced_a ?? 0,
    surfacedByB: r.surfaced_b ?? 0,
    resolvedByA: r.resolved_a ?? 0,
    resolvedByB: r.resolved_b ?? 0,
  }));
}

function getPatternSet(db: any, identityName: string, workspace?: string): Set<string> {
  const params = workspace ? [identityName, workspace] : [identityName];
  const rows = db.prepare(`
    SELECT DISTINCT detail
    FROM atlas_identity_edges
    WHERE identity_name = ?
      AND kind IN ('pattern_added', 'pattern_removed')
      AND detail IS NOT NULL
      ${workspace ? 'AND workspace = ?' : ''}
  `).all(...params) as Array<{ detail: string }>;
  return new Set(rows.map((r) => r.detail));
}

// ── Formatting ─────────────────────────────────────────────────────────

function formatDiff(diff: DiffResult, profileA: any, profileB: any): string {
  const lines: string[] = [];

  lines.push(`# Identity Diff: ${diff.identityA} vs ${diff.identityB}`);
  lines.push('');

  // Specialty summary.
  lines.push('## Specialty Summary');
  lines.push(`| Metric | ${diff.identityA} | ${diff.identityB} |`);
  lines.push('|--------|-------|-------|');
  lines.push(`| Tags | ${diff.specialtyA.tags || '(none)'} | ${diff.specialtyB.tags || '(none)'} |`);
  lines.push(`| Hazards surfaced | ${diff.specialtyA.hazardsSurfaced} | ${diff.specialtyB.hazardsSurfaced} |`);
  lines.push(`| Hazards resolved | ${diff.specialtyA.hazardsResolved} | ${diff.specialtyB.hazardsResolved} |`);
  lines.push('');

  // Shared files.
  if (diff.sharedFiles.length > 0) {
    lines.push(`## Shared Files (${diff.sharedFiles.length})`);
    for (const f of diff.sharedFiles.slice(0, 20)) {
      lines.push(`  ${f.workspace}/${f.filePath}`);
      lines.push(`    ${diff.identityA}: ${f.edgeCountA} edges | ${diff.identityB}: ${f.edgeCountB} edges`);
    }
    lines.push('');
  }

  // Unique files.
  if (diff.uniqueToA.length > 0) {
    lines.push(`## Unique to ${diff.identityA} (${diff.uniqueToA.length} files)`);
    for (const f of diff.uniqueToA.slice(0, 10)) {
      lines.push(`  ${f.workspace}/${f.filePath} (${f.edgeCount} edges)`);
    }
    lines.push('');
  }
  if (diff.uniqueToB.length > 0) {
    lines.push(`## Unique to ${diff.identityB} (${diff.uniqueToB.length} files)`);
    for (const f of diff.uniqueToB.slice(0, 10)) {
      lines.push(`  ${f.workspace}/${f.filePath} (${f.edgeCount} edges)`);
    }
    lines.push('');
  }

  // Hazard diffs.
  if (diff.hazardDiffs.length > 0) {
    lines.push(`## Hazard Balance`);
    for (const h of diff.hazardDiffs.slice(0, 15)) {
      const balance = h.surfacedByA - h.surfacedByB;
      const resolveBalance = h.resolvedByA - h.resolvedByB;
      lines.push(`  "${h.hazard}" (${h.workspace})`);
      lines.push(`    Surfaced: ${diff.identityA}=${h.surfacedByA} ${diff.identityB}=${h.surfacedByB}`);
      lines.push(`    Resolved: ${diff.identityA}=${h.resolvedByA} ${diff.identityB}=${h.resolvedByB}`);
    }
    lines.push('');
  }

  // Patterns.
  if (diff.patternOverlap.length > 0) {
    lines.push(`## Shared Patterns (${diff.patternOverlap.length})`);
    for (const p of diff.patternOverlap.slice(0, 10)) {
      lines.push(`  ✓ ${p}`);
    }
    lines.push('');
  }
  if (diff.patternsOnlyA.length > 0 || diff.patternsOnlyB.length > 0) {
    lines.push('## Pattern Divergence');
    if (diff.patternsOnlyA.length > 0) {
      lines.push(`  Only ${diff.identityA}: ${diff.patternsOnlyA.slice(0, 10).join(', ')}`);
    }
    if (diff.patternsOnlyB.length > 0) {
      lines.push(`  Only ${diff.identityB}: ${diff.patternsOnlyB.slice(0, 10).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
