export interface PhaseProgressReporter {
  begin(phaseKey: string, filePath?: string): void;
  complete(phaseKey: string, filePath?: string): void;
  fail(phaseKey: string, filePath: string, message: string): void;
  setActivePhase?(phaseKey: string): void;
  finish(summary: string): void;
}

export interface PhaseProgressSpec {
  key: string;
  label: string;
  total: number;
}

export interface PhaseProgressOptions {
  singlePhase?: boolean;
}

interface PhaseProgressState extends PhaseProgressSpec {
  completed: number;
  startedAt: number | null;
  currentFile: string;
  failedFiles: string[];
  done: boolean;
}

const BAR_WIDTH = 18;

function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60).toString().padStart(2, '0');
  return `${minutes}m ${remainder}s`;
}

function formatFailedFiles(files: string[]): string {
  if (files.length === 0) {
    return '';
  }
  const preview = files.slice(0, 2).join(', ');
  return files.length > 2 ? `${preview}, ...` : preview;
}

function buildBar(completed: number, total: number): string {
  if (total <= 0) {
    return '█'.repeat(BAR_WIDTH);
  }

  const normalized = Math.min(Math.max(completed / total, 0), 1);
  const filled = Math.min(BAR_WIDTH, Math.round(normalized * BAR_WIDTH));
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(BAR_WIDTH - filled, 0))}`;
}

function formatPhaseLine(state: PhaseProgressState, labelWidth: number): string {
  const elapsed = state.startedAt ? Date.now() - state.startedAt : 0;
  const completed = Math.min(state.completed, state.total);
  const started = state.startedAt !== null;
  const finished = state.done || completed >= state.total;
  const failedCount = state.failedFiles.length;
  const bar = buildBar(completed, state.total);
  const count = `${completed}/${state.total}`;
  const label = state.label.padEnd(labelWidth);
  const filePart = state.currentFile ? ` ${state.currentFile}` : '';

  let suffix: string;
  if (!started && completed === 0) {
    suffix = 'waiting...';
  } else if (finished) {
    suffix = failedCount > 0
      ? `✗ ${failedCount} failed (${formatFailedFiles(state.failedFiles)})`
      : `✓ ${formatDuration(elapsed)}`;
  } else if (completed > 0) {
    const rateMs = elapsed / completed;
    const remaining = Math.max(state.total - completed, 0);
    const eta = formatDuration(rateMs * remaining);
    suffix = failedCount > 0
      ? `${eta} • ${failedCount} failed`
      : `~${eta} left`;
  } else {
    suffix = 'starting...';
  }

  return `[${state.key}] ${label} ${bar} ${count}${filePart ? ` ${filePart}` : ''}  ${suffix}`;
}

export function createPhaseProgressReporter(
  specs: PhaseProgressSpec[],
  options: PhaseProgressOptions = {},
): PhaseProgressReporter {
  const states = specs.map((spec) => ({
    ...spec,
    completed: 0,
    startedAt: null as number | null,
    currentFile: '',
    failedFiles: [] as string[],
    done: false,
  }));
  const interactive = process.stdout.isTTY;
  const labelWidth = Math.max(...states.map((state) => state.label.length), 0);
  const singlePhase = options.singlePhase ?? false;
  let activePhaseKey: string | null = states[0]?.key ?? null;
  let renderedLines = 0;
  let renderedOnce = false;

  const getState = (phaseKey: string): PhaseProgressState => {
    const state = states.find((entry) => entry.key === phaseKey);
    if (!state) {
      throw new Error(`Unknown progress phase: ${phaseKey}`);
    }
    return state;
  };

  const touch = (phaseKey: string): PhaseProgressState => {
    const state = getState(phaseKey);
    if (state.startedAt === null) {
      state.startedAt = Date.now();
    }
    return state;
  };

  const visibleStates = (): PhaseProgressState[] => {
    if (!singlePhase) {
      return states;
    }
    const active = states.find((state) => state.key === activePhaseKey);
    return active ? [active] : [];
  };

  const render = (): void => {
    const lines = visibleStates().map((state) => formatPhaseLine(state, labelWidth));
    if (interactive) {
      if (renderedOnce) {
        process.stdout.write(`\u001b[${renderedLines}F`);
      }
      for (let i = 0; i < lines.length; i += 1) {
        process.stdout.write(`\u001b[2K${lines[i]}`);
        if (i < lines.length - 1) {
          process.stdout.write('\n');
        }
      }
      if (renderedOnce && renderedLines > lines.length) {
        for (let i = lines.length; i < renderedLines; i += 1) {
          process.stdout.write('\u001b[2K');
          if (i < renderedLines - 1) {
            process.stdout.write('\n');
          }
        }
      }
      renderedLines = lines.length;
      renderedOnce = true;
      return;
    }

    for (const line of lines) {
      console.log(line);
    }
  };

  return {
    begin(phaseKey: string, filePath?: string): void {
      activePhaseKey = phaseKey;
      const state = touch(phaseKey);
      if (filePath) {
        state.currentFile = filePath;
      }
      render();
    },
    complete(phaseKey: string, filePath?: string): void {
      activePhaseKey = phaseKey;
      const state = touch(phaseKey);
      state.completed += 1;
      if (state.completed > state.total) {
        state.completed = state.total;
      }
      if (filePath) {
        state.currentFile = filePath;
      }
      if (state.completed >= state.total) {
        state.done = true;
      }
      render();
    },
    fail(phaseKey: string, filePath: string, _message: string): void {
      activePhaseKey = phaseKey;
      const state = touch(phaseKey);
      state.completed += 1;
      if (state.completed > state.total) {
        state.completed = state.total;
      }
      state.currentFile = filePath;
      state.failedFiles.push(filePath);
      render();
    },
    setActivePhase(phaseKey: string): void {
      activePhaseKey = phaseKey;
      touch(phaseKey);
      render();
    },
    finish(summary: string): void {
      for (const state of states) {
        state.done = true;
      }
      render();
      if (interactive && renderedOnce) {
        process.stdout.write('\n');
      }
      console.log(`[atlas-init] ${summary}`);
    },
  };
}
