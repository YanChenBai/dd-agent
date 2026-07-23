export type CleanupStatus = 'success' | 'failed' | 'timeout';

export interface CleanupResult {
  component: string;
  status: CleanupStatus;
  durationMs: number;
  error?: Error;
}

export class CleanupTimeoutError extends Error {
  readonly component: string;
  readonly timeoutMs: number;

  constructor(component: string, timeoutMs: number) {
    super(`${component} cleanup timed out after ${timeoutMs}ms`);
    this.name = 'CleanupTimeoutError';
    this.component = component;
    this.timeoutMs = timeoutMs;
  }
}

export async function runCleanup(
  component: string,
  operation: () => unknown,
  timeoutMs: number,
): Promise<CleanupResult> {
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CleanupTimeoutError(component, timeoutMs));
    }, timeoutMs);
  });

  try {
    await Promise.race([Promise.resolve().then(operation), timeout]);
    return {
      component,
      status: 'success',
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    return {
      component,
      status: value instanceof CleanupTimeoutError ? 'timeout' : 'failed',
      durationMs: performance.now() - startedAt,
      error: value,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
