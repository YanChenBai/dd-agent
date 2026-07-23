import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { runCleanup } from './cleanup.ts';

describe('runCleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records successful and failed cleanup operations', async () => {
    await expect(runCleanup('Vision', async () => undefined, 1_000)).resolves.toMatchObject({
      component: 'Vision',
      status: 'success',
    });

    await expect(
      runCleanup(
        'Memory',
        async () => {
          throw new Error('remove failed');
        },
        1_000,
      ),
    ).resolves.toMatchObject({
      component: 'Memory',
      status: 'failed',
      error: expect.objectContaining({ message: 'remove failed' }),
    });
  });

  it('returns a timeout result for an operation that never settles', async () => {
    vi.useFakeTimers();
    const resultPromise = runCleanup('Hearing', () => new Promise(() => {}), 1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({
      component: 'Hearing',
      status: 'timeout',
      error: expect.objectContaining({
        name: 'CleanupTimeoutError',
        timeoutMs: 1_000,
      }),
    });
  });
});
