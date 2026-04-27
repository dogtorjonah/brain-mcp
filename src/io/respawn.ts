import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export type RespawnChannel = 'brain' | 'rebirth';

interface ChannelConfig {
  handoffPrefix: string;
  sentinelPrefix: string;
  counterFilename: string;
}

const CHANNELS: Record<RespawnChannel, ChannelConfig> = {
  brain: {
    handoffPrefix: 'brain-handoff',
    sentinelPrefix: '.brain-respawn',
    counterFilename: '.brain-counter',
  },
  rebirth: {
    handoffPrefix: 'rebirth-handoff',
    sentinelPrefix: '.rebirth-respawn',
    counterFilename: '.rebirth-counter',
  },
};

export interface RespawnWriteResult {
  sentinelPath: string;
  handoffPath: string;
  metaPath?: string;
  bytes: number;
  channel: RespawnChannel;
}

export interface WriteRespawnInput {
  wrapperPid: number;
  projectDir: string;
  handoffMarkdown: string;
  channel?: RespawnChannel;
  metadata?: {
    effort?: string;
    model?: string;
  };
}

export interface CadenceCounter {
  turns: number;
  lastRespawnAt: number;
}

let monotonic = 0;

export function writeRespawnSentinel(input: WriteRespawnInput): RespawnWriteResult {
  const channel = input.channel ?? 'brain';
  const config = CHANNELS[channel];
  const { wrapperPid, projectDir, handoffMarkdown } = input;

  const seq = ++monotonic;
  const handoffPath = join(tmpdir(), `${config.handoffPrefix}-${wrapperPid}-${Date.now()}-${seq}.md`);
  writeFileSync(handoffPath, handoffMarkdown, 'utf8');
  fsyncPath(handoffPath);

  const claudeDir = join(projectDir, '.claude');
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  const sentinelPath = join(claudeDir, `${config.sentinelPrefix}-${wrapperPid}`);
  writeFileSync(sentinelPath, `${handoffPath}\n`, 'utf8');
  fsyncPath(sentinelPath);

  const metaLines: string[] = [];
  if (input.metadata?.effort) metaLines.push(`effort=${input.metadata.effort}`);
  if (input.metadata?.model) metaLines.push(`model=${input.metadata.model}`);

  let metaPath: string | undefined;
  if (metaLines.length > 0) {
    metaPath = `${sentinelPath}.meta`;
    writeFileSync(metaPath, `${metaLines.join('\n')}\n`, 'utf8');
    fsyncPath(metaPath);
  }

  fsyncPath(claudeDir);

  return {
    sentinelPath,
    handoffPath,
    metaPath,
    bytes: Buffer.byteLength(handoffMarkdown, 'utf8'),
    channel,
  };
}

export function scheduleRespawnKill(wrapperPid: number, delayMs = 150): NodeJS.Timeout {
  const timer = setTimeout(() => {
    if (wrapperPid <= 1) return;
    try {
      process.kill(wrapperPid, 'SIGTERM');
    } catch {
      // The wrapper may have exited or the PID may have been recycled.
    }
  }, delayMs);
  timer.unref();
  return timer;
}

export function counterPath(projectDir: string, channel: RespawnChannel = 'brain'): string {
  return join(projectDir, '.claude', CHANNELS[channel].counterFilename);
}

export function readCounter(projectDir: string, channel: RespawnChannel = 'brain'): CadenceCounter {
  const path = counterPath(projectDir, channel);
  if (!existsSync(path)) return { turns: 0, lastRespawnAt: 0 };

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CadenceCounter>;
    return {
      turns: typeof parsed.turns === 'number' ? parsed.turns : 0,
      lastRespawnAt: typeof parsed.lastRespawnAt === 'number' ? parsed.lastRespawnAt : 0,
    };
  } catch {
    return { turns: 0, lastRespawnAt: 0 };
  }
}

export function writeCounter(
  projectDir: string,
  counter: CadenceCounter,
  channel: RespawnChannel = 'brain',
): void {
  const path = counterPath(projectDir, channel);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(counter), 'utf8');
  fsyncPath(path);
}

function fsyncPath(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Durability best effort. The channel still works on normal local filesystems.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
