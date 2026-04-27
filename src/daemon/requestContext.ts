import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallerContext } from './protocol.js';

const callerContextStorage = new AsyncLocalStorage<CallerContext>();

export function withCallerContext<T>(context: CallerContext, fn: () => T): T {
  return callerContextStorage.run(context, fn);
}

export function getCallerContext(): CallerContext | undefined {
  return callerContextStorage.getStore();
}
