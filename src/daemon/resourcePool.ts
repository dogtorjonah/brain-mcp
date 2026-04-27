export interface CloseableResource {
  close(): void | Promise<void>;
}

interface PoolEntry<T extends CloseableResource> {
  value: T;
  lastUsed: number;
}

export class CloseableLruPool<T extends CloseableResource> {
  private readonly entries = new Map<string, PoolEntry<T>>();

  constructor(private readonly maxEntries: number) {}

  async get(key: string, create: () => T | Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.value;
    }

    const value = await create();
    this.entries.set(key, { value, lastUsed: Date.now() });
    await this.evictIfNeeded();
    return value;
  }

  snapshot(): Array<{ key: string; lastUsed: number }> {
    return [...this.entries.entries()]
      .map(([key, entry]) => ({ key, lastUsed: entry.lastUsed }))
      .sort((left, right) => right.lastUsed - left.lastUsed);
  }

  async close(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await entry.value.close();
  }

  async closeAll(): Promise<void> {
    const keys = [...this.entries.keys()];
    for (const key of keys) {
      await this.close(key);
    }
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
      if (!oldest) return;
      await this.close(oldest[0]);
    }
  }
}
