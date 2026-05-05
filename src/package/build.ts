import type { ReducedTranscript } from '../trace/types.js';
import {
  collectFileContext,
  collectFileReferences,
  searchFootprint,
  DEFAULT_FILE_CONTEXT,
  type FileContextOptions,
} from './fileContext.js';
import {
  DEFAULT_GRADIENT,
  DEFAULT_TOOL_RESULT_BUDGET,
  type GradientConfig,
  type ToolResultBudget,
} from './gradient.js';
import {
  renderActivityLog,
  renderCurrentThread,
  renderEditDelta,
  renderFileContext,
  renderFileReferences,
  renderHeader,
  renderIdentitySnapshot,
  renderLastMessages,
  renderNextStep,
} from './sections.js';
import { renderTodos } from './todos.js';
import { findRepoRoot, renderGitStatus } from './gitStatus.js';
import { renderRebirthHistory } from './history.js';

export interface BuildOptions {
  gradient?: Partial<GradientConfig>;
  toolResultBudget?: Partial<ToolResultBudget>;
  fileContext?: Partial<FileContextOptions>;
  threadTurns?: number;
  capturedAt?: Date;
  includeSearchFootprint?: boolean;
  /** Override cwd for git status capture. Defaults to reduced.cwd. */
  gitCwd?: string;
  /** Set false to skip the git subprocess entirely. */
  includeGitStatus?: boolean;
  /** Set false to skip the TodoWrite snapshot. */
  includeTodos?: boolean;
  /** Set false to skip reading the per-project rebirth history file. */
  includeRebirthHistory?: boolean;
  /**
   * Session ID used as the anchor for chain-based rebirth-history clustering.
   * Defaults to reduced.sessionId, but chain-aware callers (rebirth.ts walks
   * the breadcrumb chain and prepends ancestor rows before reducing, which
   * makes reduced.sessionId the OLDEST ancestor, not the resolved session)
   * should pass the *resolved* session id here so walkChainBack anchors on
   * the newest session and produces the correct ancestor set.
   */
  currentSessionId?: string;
  /**
   * Identity name to surface in the handoff header. Passed from rebirth.ts
   * after resolveOrMintIdentity runs. If omitted, the identity blurb is
   * skipped — fine for standalone / test-harness callers that don't care
   * about identity continuity.
   */
  identityName?: string;
  identitySnapshot?: {
    blurb?: string;
    specialtyTags?: string;
    handoffNote?: string | null;
    activeSops?: Array<{ title: string; body?: string }>;
    recentFiles?: Array<{ workspace?: string; filePath: string; edgeCount?: number; lastTouchedAt?: number }>;
  };
}

export interface BuiltHandoff {
  markdown: string;
  bytes: number;
  stats: {
    sessionId: string;
    events: number;
    toolCalls: number;
    humanTurns: number;
    filesInContext: number;
  };
}

/**
 * Assemble a handoff package markdown document from a reduced transcript.
 * Section order is load-bearing: Last User+AI → Current Thread → Active Edit
 * Delta → Files in Context → Activity Log. That order walks the successor
 * from "what the human just asked" down into "how we got here" so the
 * successor starts replying with the freshest signal.
 */
export function buildHandoff(reduced: ReducedTranscript, opts: BuildOptions = {}): BuiltHandoff {
  const gradient: GradientConfig = { ...DEFAULT_GRADIENT, ...opts.gradient };
  const toolResultBudget: ToolResultBudget = {
    ...DEFAULT_TOOL_RESULT_BUDGET,
    ...opts.toolResultBudget,
  };
  const fileContextOpts: FileContextOptions = { ...DEFAULT_FILE_CONTEXT, ...opts.fileContext };
  const fileContext = collectFileContext(reduced, fileContextOpts);
  const capturedAt = opts.capturedAt ?? new Date();
  const threadTurns = opts.threadTurns ?? 8;

  const sections: string[] = [
    renderHeader(reduced, capturedAt, opts.currentSessionId, opts.identityName),
  ];

  // Identity snapshot fires between Header and Freshest Turn so the
  // successor reads "who you are + what your lineage does + how to switch"
  // before they read the conversation. Auto-skips when no identityName was
  // supplied (CLI / test harnesses that don't go through the resolver).
  sections.push(renderIdentitySnapshot({ identityName: opts.identityName, ...opts.identitySnapshot }));

  sections.push(renderLastMessages(reduced));

  // "Your Next Step" surfaces the successor's ask as an explicit section
  // instead of making them infer it from Last Messages. Cheap: it reuses
  // the same last-user-message extraction as Last Messages but frames it
  // as the open question. Placed right after Last Messages so the READ
  // FIRST block flows straight into "and here's what you're doing now".
  sections.push(renderNextStep(reduced));

  // Rebirth history rides near the top so the successor immediately knows
  // "is this my first rebirth here, or my tenth." Cadence frames everything
  // that follows: a dense rebirth tail often means the session is stuck.
  // Chain clustering uses opts.currentSessionId when provided (the resolved
  // session, anchored by the chain-walker caller) and falls back to
  // reduced.sessionId otherwise — see BuildOptions comment on why this
  // distinction matters for chain-walked row concatenation.
  if (opts.includeRebirthHistory !== false) {
    const anchorSid = opts.currentSessionId ?? reduced.sessionId;
    sections.push(renderRebirthHistory(reduced.cwd, anchorSid));
  }

  // Todos sit between Last Messages and Current Thread: highest-signal
  // "what am I doing right now" snapshot after the freshest human turn.
  // Skipped automatically when no TodoWrite was ever called this session.
  if (opts.includeTodos !== false) {
    sections.push(renderTodos(reduced));
  }

  sections.push(renderCurrentThread(reduced, threadTurns));

  // Git status is the one section the .jsonl can't reconstruct — captured
  // synchronously at build time. Runs after Current Thread so the
  // subprocess shelling doesn't block the fast sections above if git
  // hangs (the 2s timeout in gitStatus.ts still applies as a hard cap).
  //
  // Multi-repo: if the session edited files outside the primary cwd's repo
  // (for example, a local integration session that touched a sibling repo),
  // capture a snapshot for every unique repo root we can resolve from the
  // file-context paths. Dedup by resolved repo root so cwd and its
  // subdirs collapse to one entry.
  if (opts.includeGitStatus !== false) {
    const primaryCwd = opts.gitCwd ?? reduced.cwd;
    const primaryRoot = findRepoRoot(primaryCwd) ?? primaryCwd;
    const seenRoots = new Set<string>();
    const roots: Array<{ root: string; isPrimary: boolean }> = [];
    if (primaryRoot) {
      seenRoots.add(primaryRoot);
      roots.push({ root: primaryRoot, isPrimary: true });
    }
    for (const entry of fileContext) {
      const root = findRepoRoot(entry.path);
      if (root && !seenRoots.has(root)) {
        seenRoots.add(root);
        roots.push({ root, isPrimary: false });
      }
    }
    if (roots.length <= 1) {
      sections.push(renderGitStatus(primaryCwd ?? primaryRoot));
    } else {
      for (const { root, isPrimary } of roots) {
        sections.push(
          renderGitStatus(root, {
            heading: isPrimary
              ? 'Git Working Tree — primary (captured at handoff time)'
              : 'Git Working Tree — cross-repo edits (captured at handoff time)',
            subtitle: isPrimary
              ? undefined
              : 'Files in this session were edited here in addition to the primary repo.',
          }),
        );
      }
    }
  }

  sections.push(renderEditDelta(fileContext));
  sections.push(renderFileContext(fileContext));

  // Paths mined from tool_result bodies (atlas/MCP/etc) that aren't already
  // in the primary file-context list. Excludes anything we read/edited so
  // the section is purely "here are other paths the session referenced".
  const editedPaths = new Set(fileContext.map((e) => e.path));
  sections.push(renderFileReferences(collectFileReferences(reduced, editedPaths)));

  if (opts.includeSearchFootprint !== false) {
    const footprint = searchFootprint(reduced);
    if (footprint.length > 0) {
      sections.push(
        ['── Search Footprint ──', '', ...footprint.map((l) => `  ${l}`), ''].join('\n'),
      );
    }
  }

  sections.push(renderActivityLog(reduced, gradient, toolResultBudget));

  const markdown = sections.filter((s) => s && s.trim().length > 0).join('\n');
  return {
    markdown,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    stats: {
      sessionId: reduced.sessionId,
      events: reduced.events.length,
      toolCalls: reduced.toolCalls.length,
      humanTurns: reduced.userMessages.length,
      filesInContext: fileContext.length,
    },
  };
}
