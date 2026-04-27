export interface WorkerHandle {
  name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  status(): Record<string, unknown>;
}

class IntervalWorker implements WorkerHandle {
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;

  constructor(
    public readonly name: string,
    private readonly intervalMs: number,
    private readonly fn: () => void | Promise<void>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  status(): Record<string, unknown> {
    return {
      name: this.name,
      intervalMs: this.intervalMs,
      running: this.timer !== null,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
    };
  }

  private async runOnce(): Promise<void> {
    try {
      await this.fn();
      this.lastRunAt = Date.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }
}

export class WorkerManager {
  private readonly workers = new Map<string, WorkerHandle>();

  register(worker: WorkerHandle): void {
    this.workers.set(worker.name, worker);
  }

  registerInterval(name: string, intervalMs: number, fn: () => void | Promise<void>): void {
    this.register(new IntervalWorker(name, intervalMs, fn));
  }

  async startAll(): Promise<void> {
    for (const worker of this.workers.values()) {
      await worker.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const worker of this.workers.values()) {
      await worker.stop();
    }
  }

  snapshot(): Record<string, unknown>[] {
    return [...this.workers.values()].map((worker) => worker.status());
  }
}
