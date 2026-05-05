import type { BrainDaemonRuntime } from '../daemon/runtime.js';
import type { ToolRegistry } from '../daemon/toolRegistry.js';
import type { BrainToolResult, CallerContext } from '../daemon/protocol.js';
import { isRecord, safeJsonStringify } from '../daemon/protocol.js';
import { scheduleRespawnKill, writeRespawnSentinel, type RespawnChannel } from '../io/respawn.js';
import { buildRichHandoff } from './brain_handoff.js';

export const BRAIN_REBIRTH_ADAPTER_ACTION = 'brain_rebirth_adapter_action';

interface BrainRebirthAdapterAction {
  kind: 'self-spawn';
  handoffMarkdown: string;
  cwd: string;
  claudeBin?: string;
  extraArgv: string[];
  killDelayMs: number;
  requireClaudeParent: boolean;
}

type RespawnMethod = 'auto' | 'wrapper' | 'self-spawn';

interface WrapperTarget {
  wrapperPid: number;
  projectDir: string;
  channel: RespawnChannel;
}

export function registerBrainRebirthTool(registry: ToolRegistry, runtime: BrainDaemonRuntime): void {
  registry.register(
    {
      name: 'brain_rebirth',
      description:
        'Respawn Claude with a structured Brain handoff. Uses the brain-claude wrapper when available, ' +
        'or asks the stdio adapter to perform a guarded self-spawn.',
    },
    async (args, caller) => handleBrainRebirth(runtime, args, caller),
  );
}

async function handleBrainRebirth(
  runtime: BrainDaemonRuntime,
  args: Record<string, unknown>,
  caller: CallerContext,
): Promise<BrainToolResult> {
  const method = readMethod(args.method);
  const killDelayMs = readPositiveInt(args.kill_delay_ms) ?? 200;
  const wrapperTarget = resolveWrapperTarget(args, caller);
  const identityName = resolveIdentity(runtime, caller, args);

  // If the caller asked for a specific identity (different from what's
  // currently bound to this wrapper), update the wrapper_identity binding
  // BEFORE building the handoff. This ensures (a) the rich handoff builder
  // walks the requested identity's lineage, and (b) the new claude session
  // wakes up bound to the requested identity instead of falling through to
  // the prior auto-minted name.
  const explicitIdentity = readString(args.identity);
  if (
    explicitIdentity &&
    explicitIdentity !== 'unknown' &&
    wrapperTarget?.wrapperPid
  ) {
    try {
      runtime.identityStore.setWrapperBinding(wrapperTarget.wrapperPid, explicitIdentity, {
        cwd: caller.cwd,
        source: 'respawn-explicit',
      });
    } catch {
      // Binding update is best-effort; the meta sidecar still propagates
      // the requested identity to the wrapper for export.
    }
  }

  const handoffMarkdown = readString(args.handoff_markdown) ?? readString(args.handoff) ??
    await buildRebirthHandoffMarkdown(runtime, caller, args);

  if (method !== 'self-spawn' && wrapperTarget) {
    const write = writeRespawnSentinel({
      wrapperPid: wrapperTarget.wrapperPid,
      projectDir: wrapperTarget.projectDir,
      handoffMarkdown,
      channel: wrapperTarget.channel,
      metadata: {
        effort: readString(args.effort),
        model: readString(args.model),
        identity: explicitIdentity,
      },
    });

    scheduleRespawnKill(wrapperTarget.wrapperPid, killDelayMs);
    recordRebirthEvent(runtime, caller, identityName, {
      method: 'wrapper',
      channel: wrapperTarget.channel,
      wrapperPid: wrapperTarget.wrapperPid,
      handoffPath: write.handoffPath,
      sentinelPath: write.sentinelPath,
      bytes: write.bytes,
    });

    const structuredContent = {
      ok: true,
      method: 'wrapper',
      channel: wrapperTarget.channel,
      wrapper_pid: wrapperTarget.wrapperPid,
      project_dir: wrapperTarget.projectDir,
      handoff_path: write.handoffPath,
      sentinel_path: write.sentinelPath,
      meta_path: write.metaPath,
      bytes: write.bytes,
      kill_delay_ms: killDelayMs,
    };

    return {
      content: [{
        type: 'text',
        text: [
          'brain_rebirth scheduled via wrapper.',
          `channel: ${wrapperTarget.channel}`,
          `wrapper_pid: ${wrapperTarget.wrapperPid}`,
          `sentinel: ${write.sentinelPath}`,
          `handoff_bytes: ${write.bytes}`,
        ].join('\n'),
      }],
      structuredContent,
    };
  }

  if (method === 'wrapper') {
    return {
      content: [{
        type: 'text',
        text:
          'brain_rebirth requires brain-claude wrapper env for method=wrapper. ' +
          'Launch Claude through brain-claude or install the shell shim.',
      }],
      isError: true,
    };
  }

  const action: BrainRebirthAdapterAction = {
    kind: 'self-spawn',
    handoffMarkdown,
    cwd: readString(args.cwd) ?? caller.cwd,
    claudeBin: readString(args.claude_bin),
    extraArgv: readStringArray(args.extra_argv),
    killDelayMs,
    requireClaudeParent: readBoolean(args.require_claude_parent) ?? true,
  };

  recordRebirthEvent(runtime, caller, identityName, {
    method: 'self-spawn',
    cwd: action.cwd,
    bytes: Buffer.byteLength(handoffMarkdown, 'utf8'),
  });

  const structuredContent = {
    ok: true,
    method: 'self-spawn',
    adapter_action: 'queued',
    cwd: action.cwd,
    handoff_bytes: Buffer.byteLength(handoffMarkdown, 'utf8'),
    kill_delay_ms: killDelayMs,
  };

  return {
    content: [{
      type: 'text',
      text:
        'brain_rebirth prepared a self-spawn handoff. The stdio adapter will perform the guarded terminal takeover.',
    }],
    structuredContent,
    _meta: {
      [BRAIN_REBIRTH_ADAPTER_ACTION]: action,
    },
  };
}

/**
 * Build the markdown the wrapper will inject as the next session's first user
 * message. Always uses the rich `brain_handoff` generator (transcript reduce +
 * identity snapshot + atlas inlay + lifetime changelog arc).
 *
 * If the caller passed an explicit `note` / `handoff_note`, that note is
 * prepended as a "## Active Task Note" block above the rich content.
 *
 * Throws when the rich handoff cannot be built — typically because no
 * transcript exists for this cwd. respawn surfaces the failure to the caller
 * rather than ferrying a degraded handoff into the next session.
 */
async function buildRebirthHandoffMarkdown(
  runtime: BrainDaemonRuntime,
  caller: CallerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const explicitNote = readString(args.note) ?? readString(args.handoff_note);
  const identityFromArgs = readString(args.identity);
  const cwdFromArgs = readString(args.cwd);
  const sessionFromArgs = readString(args.session_id);

  const rich = await buildRichHandoff(
    {
      identity: identityFromArgs,
      cwd: cwdFromArgs,
      session_id: sessionFromArgs,
      include_atlas_context: true,
    },
    caller,
    {
      homeDb: runtime.homeDb,
      identityStore: runtime.identityStore,
      atlasTools: runtime.atlasTools,
      getCurrentIdentity: () => runtime.getCurrentIdentity(),
      getCurrentSessionId: () => runtime.getCurrentSessionId(),
    },
  );

  if (!rich.ok) {
    throw new Error(`brain_rebirth: rich handoff unavailable — ${rich.reason}`);
  }

  return prependActiveTaskNote(rich.markdown, explicitNote);
}

function prependActiveTaskNote(markdown: string, note: string | undefined): string {
  if (!note) return markdown;
  return `## Active Task Note\n\n${note}\n\n${markdown}`;
}

function resolveWrapperTarget(args: Record<string, unknown>, caller: CallerContext): WrapperTarget | null {
  const explicitWrapperPid = readPositiveInt(args.wrapper_pid);
  const brainWrapperPid = readPositiveInt(caller.env.BRAIN_WRAPPER_PID);
  const rebirthWrapperPid = readPositiveInt(caller.env.REBIRTH_WRAPPER_PID);
  const contextWrapperPid = caller.wrapperPid && caller.wrapperPid > 1 ? caller.wrapperPid : undefined;
  const wrapperPid = explicitWrapperPid ?? brainWrapperPid ?? rebirthWrapperPid ?? contextWrapperPid;
  if (!wrapperPid) return null;

  const explicitChannel = readChannel(args.channel);
  const channel = explicitChannel ?? (brainWrapperPid || explicitWrapperPid ? 'brain' : 'rebirth');
  const projectDir =
    readString(args.project_dir) ??
    caller.env.BRAIN_WRAPPER_PROJECT_DIR ??
    caller.projectDir ??
    caller.env.REBIRTH_WRAPPER_PROJECT_DIR ??
    caller.env.CLAUDE_PROJECT_DIR ??
    caller.cwd;

  return { wrapperPid, projectDir, channel };
}

function resolveIdentity(
  runtime: BrainDaemonRuntime,
  caller: CallerContext,
  args: Record<string, unknown>,
): string {
  return readString(args.identity) ??
    runtime.getCurrentIdentity() ??
    caller.identity ??
    caller.env.CLAUDE_IDENTITY ??
    'unknown';
}

function recordRebirthEvent(
  runtime: BrainDaemonRuntime,
  caller: CallerContext,
  identityName: string,
  meta: Record<string, unknown>,
): void {
  if (!identityName || identityName === 'unknown') return;
  try {
    runtime.identityStore.appendChainEvent({
      identityName,
      eventKind: 'respawn_requested',
      sessionId: caller.sessionId,
      cwd: caller.cwd,
      wrapperPid: caller.wrapperPid,
      metaJson: safeJsonStringify(meta),
    });
  } catch {
    // Respawn should not fail because historical annotation failed.
  }
}

function readMethod(value: unknown): RespawnMethod {
  if (value === 'wrapper' || value === 'self-spawn' || value === 'auto') return value;
  return 'auto';
}

function readChannel(value: unknown): RespawnChannel | undefined {
  return value === 'brain' || value === 'rebirth' ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number.parseInt(value, 10)
      : Number.NaN;
  return Number.isInteger(parsed) && parsed > 1 ? parsed : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function isBrainRebirthAdapterAction(value: unknown): value is BrainRebirthAdapterAction {
  return isRecord(value) &&
    value.kind === 'self-spawn' &&
    typeof value.handoffMarkdown === 'string' &&
    typeof value.cwd === 'string' &&
    Array.isArray(value.extraArgv) &&
    typeof value.killDelayMs === 'number' &&
    typeof value.requireClaudeParent === 'boolean';
}
