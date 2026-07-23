import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import type { DDStopResult } from '../types.ts';

const mocks = vi.hoisted(() => {
  let resolveStop: ((result: DDStopResult) => void) | undefined;
  let stopPromise: Promise<DDStopResult>;
  let stopResult: DDStopResult | undefined;

  const resetStop = () => {
    stopResult = undefined;
    stopPromise = new Promise(resolve => {
      resolveStop = result => {
        stopResult = result;
        resolve(result);
      };
    });
  };
  resetStop();

  return {
    createDD: vi.fn(),
    ddStop: vi.fn(async () => {
      return (
        stopResult ?? {
          reason: 'manual-stop',
          roomId: 1,
          startedAt: 0,
          endedAt: Date.now(),
          tokenUsage: {
            requests: 0,
            failedRequests: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
          cleanup: [],
        }
      );
    }),
    resetStop,
    resolveStop: (result: DDStopResult) => resolveStop?.(result),
    waitForStop: () => stopPromise,
  };
});

vi.mock('../index.ts', () => ({
  createDD: mocks.createDD,
}));

vi.mock('../../logger/index.ts', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { createWatchManager } from './watch-manager.ts';

describe('createWatchManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetStop();
    mocks.createDD.mockResolvedValue({
      brain: {
        onContinueWatching: () => vi.fn(),
        onSwitchRoom: () => vi.fn(),
        setPlannedWatchEndAt: vi.fn(),
      },
      context: {
        mode: 'explore',
        roomId: 1,
      },
      idle: vi.fn(async () => undefined),
      memory: {
        query: () => [],
      },
      roomInfo: {
        room: {
          room_id: 1,
          title: '测试直播间',
        },
        user: {
          uname: '测试主播',
        },
      },
      stop: mocks.ddStop,
      waitForStop: mocks.waitForStop,
    });
  });

  it('finishes the checkpoint immediately when the live stream ends', async () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    const manager = createWatchManager({
      exploreStartedAt: Date.now(),
      logger: logger as never,
      maxRunMs: 60 * 60 * 1_000,
      observeRoomMs: 60 * 60 * 1_000,
      sendDanmakuEnabled: false,
      runContext: { mode: 'explore' },
    });

    const summaryPromise = manager.watchRoom(1, 1);
    await vi.waitFor(() => {
      expect(mocks.createDD).toHaveBeenCalledOnce();
    });

    mocks.resolveStop({
      reason: 'live-ended',
      roomId: 1,
      startedAt: Date.now() - 1_000,
      endedAt: Date.now(),
      tokenUsage: {
        requests: 2,
        failedRequests: 1,
        inputTokens: 15,
        outputTokens: 3,
        totalTokens: 18,
      },
      cleanup: [],
    });

    await expect(summaryPromise).resolves.toMatchObject({
      endReason: 'live-ended',
      canContinue: false,
    });
    expect(mocks.ddStop).toHaveBeenCalledOnce();
    expect(manager.getTokenUsage()).toEqual({
      requests: 2,
      failedRequests: 1,
      inputTokens: 15,
      outputTokens: 3,
      totalTokens: 18,
    });
  });
});
