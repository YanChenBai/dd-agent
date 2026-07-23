import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { createDefaultConfig } from '../../config/index.ts';

const {
  browserCloses,
  extractionBatches,
  holdBrowserClose,
  launch,
  pageEvaluations,
  releaseBrowserClose,
} = vi.hoisted(() => {
  const extractionBatches: Array<Array<{ href: string; imageAlt: string; text: string }>> = [];
  const browserCloses: Array<ReturnType<typeof vi.fn>> = [];
  const pageEvaluations: string[] = [];
  let browserCloseGate: Promise<void> | undefined;
  let releaseBrowserClose: (() => void) | undefined;
  const launch = vi.fn(async () => {
    const page = {
      bringToFront: vi.fn(async () => undefined),
      evaluate: vi.fn(async (callback: () => unknown) => {
        const source = String(callback);
        pageEvaluations.push(source);
        if (source.includes('querySelectorAll')) {
          return extractionBatches.shift() ?? [];
        }
        return undefined;
      }),
      goto: vi.fn(async () => undefined),
      isClosed: vi.fn(() => false),
      setUserAgent: vi.fn(async () => undefined),
    };
    const close = vi.fn(async () => {
      await browserCloseGate;
    });
    browserCloses.push(close);
    return {
      close,
      newPage: vi.fn(async () => page),
      pages: vi.fn(async () => [page]),
    };
  });
  return {
    browserCloses,
    extractionBatches,
    holdBrowserClose: () => {
      browserCloseGate = new Promise(resolve => {
        releaseBrowserClose = resolve;
      });
    },
    launch,
    pageEvaluations,
    releaseBrowserClose: () => {
      releaseBrowserClose?.();
      releaseBrowserClose = undefined;
      browserCloseGate = undefined;
    },
  };
});

vi.mock('puppeteer', () => ({
  default: { launch },
}));

import { createLiveAreaSource } from './area-source.ts';

describe('createLiveAreaSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    extractionBatches.push(
      [room(1)],
      [room(1), room(2)],
      [room(1), room(2)],
      [room(1), room(2), room(3)],
      [room(1), room(2), room(3), room(4)],
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    browserCloses.length = 0;
    extractionBatches.length = 0;
    pageEvaluations.length = 0;
  });

  it('waits for the same browser close operation across concurrent callers', async () => {
    holdBrowserClose();
    const source = createLiveAreaSource(
      'https://live.bilibili.com/p/eden/area-tags?parentAreaId=9',
      createDefaultConfig(),
    );

    const refreshPromise = source.refresh(1);
    await vi.runAllTimersAsync();
    await vi.waitFor(() => {
      expect(browserCloses[0]).toHaveBeenCalledOnce();
    });

    let concurrentCloseResolved = false;
    const concurrentClose = source.close().then(() => {
      concurrentCloseResolved = true;
    });
    await Promise.resolve();
    expect(concurrentCloseResolved).toBe(false);

    releaseBrowserClose();
    await Promise.all([refreshPromise, concurrentClose]);

    expect(browserCloses[0]).toHaveBeenCalledOnce();
    expect(concurrentCloseResolved).toBe(true);
  });

  it('scrolls to the page bottom for unseen rooms and closes the browser after every batch', async () => {
    const source = createLiveAreaSource(
      'https://live.bilibili.com/p/eden/area-tags?parentAreaId=9&page=3',
      createDefaultConfig(),
    );

    const firstPromise = source.refresh(2);
    await vi.runAllTimersAsync();
    const first = await firstPromise;

    const secondPromise = source.loadMore(2);
    await vi.runAllTimersAsync();
    const second = await secondPromise;

    expect(first).toMatchObject({ batch: 1 });
    expect(first.candidates.map(candidate => candidate.roomId)).toEqual([1, 2]);
    expect(second).toMatchObject({ batch: 2 });
    expect(second.candidates.map(candidate => candidate.roomId)).toEqual([3, 4]);
    expect(
      pageEvaluations.some(
        source => source.includes('window.scrollTo') && source.includes('scrollHeight'),
      ),
    ).toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(browserCloses).toHaveLength(2);
    for (const close of browserCloses) {
      expect(close).toHaveBeenCalledOnce();
    }
  });
});

function room(roomId: number) {
  return {
    href: `https://live.bilibili.com/${roomId}`,
    imageAlt: `主播 ${roomId}`,
    text: `直播间 ${roomId}`,
  };
}
