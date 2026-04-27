import type { BrainDaemonRuntime } from '../daemon/runtime.js';
import type { ToolRegistry } from '../daemon/toolRegistry.js';
import type { BrainToolResult, CallerContext } from '../daemon/protocol.js';
import { isRecord, safeJsonStringify } from '../daemon/protocol.js';
import { scheduleRespawnKill, writeRespawnSentinel, type RespawnChannel } from '../io/respawn.js';

export const BRAIN_RESPAWN_ADAPTER_ACTION = 'brain_respawn_adapter_action';

interface BrainRespawnAdapterAction {
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

export function registerBrainRespawnTool(registry: ToolRegistry, runtime: BrainDaemonRuntime): void {
  registry.register(
    {
      name: 'brain_respawn',
      description:
        'Respawn Claude with a structured Brain handoff. Uses the brain-claude wrapper when available, ' +
        'or asks the stdio adapter to perform a guarded self-spawn.',
    },
    async (args, caller) => handleBrainRespawn(runtime, args, caller),
  );
}

async function handleBrainRespawn(
  runtime: BrainDaemonRuntime,
  args: Record<string, unknown>,
  caller: CallerContext,
): Promise<BrainToolResult> {
  const method = readMethod(args.method);
  const handoffMarkdown = readString(args.handoff_markdown) ?? readString(args.handoff) ??
    buildStructuredHandoff(runtime, caller, args);
  const killDelayMs = readPositiveInt(args.kill_delay_ms) ?? 200;
  const wrapperTarget = resolveWrapperTarget(args, caller);
  const identityName = resolveIdentity(runtime, caller, args);

  if (method !== 'self-spawn' && wrapperTarget) {
    const write = writeRespawnSentinel({
      wrapperPid: wrapperTarget.wrapperPid,
      projectDir: wrapperTarget.projectDir,
      handoffMarkdown,
      channel: wrapperTarget.channel,
      metadata: {
        effort: readString(args.effort),
        model: readString(args.model),
      },
    });

    scheduleRespawnKill(wrapperTarget.wrapperPid, killDelayMs);
    recordRespawnEvent(runtime, caller, identityName, {
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
          'brain_respawn scheduled via wrapper.',
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
          'brain_respawn requires brain-claude wrapper env for method=wrapper. ' +
          'Launch Claude through brain-claude or install the shell shim.',
      }],
      isError: true,
    };
  }

  const action: BrainRespawnAdapterAction = {
    kind: 'self-spawn',
    handoffMarkdown,
    cwd: readString(args.cwd) ?? caller.cwd,
    claudeBin: readString(args.claude_bin),
    extraArgv: readStringArray(args.extra_argv),
    killDelayMs,
    requireClaudeParent: readBoolean(args.require_claude_parent) ?? true,
  };

  recordRespawnEvent(runtime, caller, identityName, {
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
        'brain_respawn prepared a self-spawn handoff. The stdio adapter will perform the guarded terminal takeover.',
    }],
    structuredContent,
    _meta: {
      [BRAIN_RESPAWN_ADAPTER_ACTION]: action,
    },
  };
}

function buildStructuredHandoff(
  runtime: BrainDaemonRuntime,
  caller: CallerContext,
  args: Record<string, unknown>,
): string {
  const identityName = resolveIdentity(runtime, caller, args);
  const profile = identityName !== 'unknown' ? runtime.identityStore.getProfile(identityName) : null;
  const handoffNote = identityName !== 'unknown' ? runtime.identityStore.getHandoffNote(identityName) : null;
  const sops = identityName !== 'unknown' ? runtime.identityStore.listSops(identityName).slice(0, 8) : [];
  const recentChain = identityName !== 'unknown' ? runtime.identityStore.getRecentChain(identityName, 12) : [];
  const openHazards = identityName !== 'unknown'
    ? runtime.edgeEmitter.getOpenHazards(identityName, { limit: 12 })
    : [];
  const recentCommits = identityName !== 'unknown'
    ? runtime.edgeEmitter.query({ identityName, kind: 'commit', limit: 12 })
    : [];
  const explicitNote = readString(args.note) ?? readString(args.handoff_note);
  const now = new Date().toISOString();

  const lines: string[] = [
    '# Brain Respawn Handoff',
    '',
    `Generated: ${now}`,
    `Identity: ${identityName}`,
    `Session: ${caller.sessionId ?? caller.env.CLAUDE_SESSION_ID ?? 'unknown'}`,
    `Working directory: ${readString(args.cwd) ?? caller.cwd}`,
    '',
    '## Identity',
    profile ? `- ${profile.name}: ${profile.blurb || '(no blurb)'}` : '- No identity profile found yet.',
  ];

  if (explicitNote) {
    lines.push('', '## Active Task Note', explicitNote);
  }

  if (handoffNote?.note) {
    lines.push('', '## Persistent Handoff Note', handoffNote.note);
  }

  lines.push('', '## Open Hazards');
  if (openHazards.length === 0) {
    lines.push('- None recorded.');
  } else {
    for (const hazard of openHazards) {
      lines.push(`- ${hazard.workspace}/${hazard.filePath}: ${hazard.hazard}`);
    }
  }

  lines.push('', '## Recent Commits');
  if (recentCommits.length === 0) {
    lines.push('- None recorded.');
  } else {
    for (const commit of recentCommits) {
      lines.push(`- ${commit.workspace}/${commit.filePath} at ${new Date(commit.ts).toISOString()}`);
    }
  }

  lines.push('', '## Active SOPs');
  if (sops.length === 0) {
    lines.push('- None recorded.');
  } else {
    for (const sop of sops) {
      lines.push(`- ${sop.title}: ${sop.body.slice(0, 240).replace(/\s+/g, ' ')}`);
    }
  }

  lines.push('', '## Recent Identity Chain');
  if (recentChain.length === 0) {
    lines.push('- None recorded.');
  } else {
    for (const event of recentChain) {
      lines.push(`- ${new Date(event.ts).toISOString()} ${event.eventKind} ${event.cwd ?? ''}`.trim());
    }
  }

  lines.push(
    '',
    '## Continue',
    'Pick up from the active task note, preserve the identity, and use brain_search/atlas tools before editing.',
  );

  return `${lines.join('\n')}\n`;
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

function recordRespawnEvent(
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

export function isBrainRespawnAdapterAction(value: unknown): value is BrainRespawnAdapterAction {
  return isRecord(value) &&
    value.kind === 'self-spawn' &&
    typeof value.handoffMarkdown === 'string' &&
    typeof value.cwd === 'string' &&
    Array.isArray(value.extraArgv) &&
    typeof value.killDelayMs === 'number' &&
    typeof value.requireClaudeParent === 'boolean';
}
