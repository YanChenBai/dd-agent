import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { createDefaultConfig } from '../../config/index.ts';
import { DDComponentError } from '../types.ts';
import type { LiveRoomCandidate, WatchedRoomSummary } from './types.ts';

const {
  candidates,
  catalogLoadMore,
  catalogMarkUnavailable,
  catalogMarkWatched,
  catalogRefresh,
  generate,
  loadDDConfig,
  sourceClose,
  watchManagerClose,
  watchManagerGetTokenUsage,
  watchRoom,
} = vi.hoisted(() => ({
  candidates: [] as LiveRoomCandidate[],
  catalogLoadMore: vi.fn(async () => undefined),
  catalogMarkUnavailable: vi.fn(),
  catalogMarkWatched: vi.fn(),
  catalogRefresh: vi.fn(async () => undefined),
  generate: vi.fn(),
  loadDDConfig: vi.fn(),
  sourceClose: vi.fn(async () => undefined),
  watchManagerClose: vi.fn(async () => undefined),
  watchManagerGetTokenUsage: vi.fn(() => ({
    requests: 2,
    failedRequests: 0,
    inputTokens: 20,
    outputTokens: 4,
    totalTokens: 24,
  })),
  watchRoom: vi.fn(),
}));

vi.mock('../../config/index.ts', async importOriginal => ({
  ...(await importOriginal()),
  loadDDConfig,
}));

vi.mock('./agent.ts', () => ({
  createExploreAgent: () => ({ generate }),
}));

vi.mock('./area-source.ts', () => ({
  createLiveAreaSource: () => ({ close: sourceClose }),
}));

vi.mock('./room-catalog.ts', () => ({
  createRoomCatalog: () => ({
    getAll: () => candidates,
    loadMore: catalogLoadMore,
    markUnavailable: catalogMarkUnavailable,
    markWatched: catalogMarkWatched,
    refresh: catalogRefresh,
  }),
}));

vi.mock('./watch-manager.ts', () => ({
  createWatchManager: () => ({
    close: watchManagerClose,
    getTokenUsage: watchManagerGetTokenUsage,
    watchRoom,
  }),
}));

import { startExplore } from './index.ts';

describe('startExplore', () => {
  beforeEach(() => {
    const config = createDefaultConfig();
    loadDDConfig.mockResolvedValue({
      ...config,
      ai: {
        ...config.ai,
        apiKey: 'test',
        requestTimeoutMs: 60_000,
      },
    });
    candidates.push(room(1));
  });

  afterEach(() => {
    vi.clearAllMocks();
    candidates.length = 0;
  });

  it('uses a per-request timeout for the structured decision output', async () => {
    generate.mockResolvedValue({
      output: { continue: false, roomId: null, reason: '候选已浏览充分' },
    });

    const result = await startExplore();

    expect(result).toMatchObject({
      finished: true,
      finishReason: '候选已浏览充分',
      tokenUsage: {
        selection: { requests: 1 },
        rooms: { requests: 2 },
        total: { requests: 3, inputTokens: 20, outputTokens: 4, totalTokens: 24 },
      },
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      timeout: { stepMs: 60_000 },
    });
    expect(watchManagerClose).toHaveBeenCalledOnce();
    expect(sourceClose).toHaveBeenCalledOnce();
  });

  it('marks a room unavailable when its live stream ends', async () => {
    generate
      .mockResolvedValueOnce({
        output: { continue: false, roomId: 1, reason: '先观察当前候选' },
      })
      .mockResolvedValueOnce({
        output: { continue: false, roomId: null, reason: '本轮探索完成' },
      });
    watchRoom.mockResolvedValue({
      ...watchedRoom(1),
      endReason: 'live-ended',
    });

    await startExplore();

    expect(catalogMarkUnavailable).toHaveBeenCalledWith(1);
  });

  it('loads more when continue is true, then watches the selected room', async () => {
    catalogLoadMore.mockImplementationOnce(async () => {
      candidates.push(room(2));
    });
    generate
      .mockResolvedValueOnce({
        output: { continue: true, roomId: null, reason: '首批还没有足够合适的房间' },
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      })
      .mockResolvedValueOnce({
        output: { continue: false, roomId: 2, reason: '新加载的标题更适合互动' },
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      })
      .mockResolvedValueOnce({
        output: { continue: false, roomId: null, reason: '本轮探索完成' },
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      });
    const summary = watchedRoom(2);
    watchRoom.mockResolvedValue(summary);

    const result = await startExplore();

    expect(catalogLoadMore).toHaveBeenCalledOnce();
    expect(catalogMarkWatched).toHaveBeenCalledWith(2);
    expect(watchRoom).toHaveBeenCalledWith(2, 1);
    expect(result.watched).toEqual([summary]);
    expect(result).toMatchObject({
      finished: true,
      finishReason: '本轮探索完成',
      tokenUsage: {
        selection: {
          requests: 3,
          inputTokens: 30,
          outputTokens: 6,
          totalTokens: 36,
        },
        rooms: {
          requests: 2,
          inputTokens: 20,
          outputTokens: 4,
          totalTokens: 24,
        },
        total: {
          requests: 5,
          inputTokens: 50,
          outputTokens: 10,
          totalTokens: 60,
        },
      },
    });
  });

  it('marks a room unavailable and continues after a room-scoped component failure', async () => {
    generate
      .mockResolvedValueOnce({
        output: { continue: false, roomId: 1, reason: '观察候选房间' },
      })
      .mockResolvedValueOnce({
        output: { continue: false, roomId: null, reason: '跳过故障房间后结束' },
      });
    watchRoom.mockRejectedValueOnce(
      new DDComponentError('FFmpeg', 'fatal', new Error('stream disconnected')),
    );

    const result = await startExplore();

    expect(catalogMarkUnavailable).toHaveBeenCalledWith(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      finished: true,
      finishReason: '跳过故障房间后结束',
    });
  });
});

function room(roomId: number): LiveRoomCandidate {
  return {
    roomId,
    title: `直播间 ${roomId}`,
    anchor: `主播 ${roomId}`,
  };
}

function watchedRoom(roomId: number): WatchedRoomSummary {
  return {
    roomInfo: {
      room: {
        room_id: roomId,
        title: `直播间 ${roomId}`,
      },
      user: {
        uname: `主播 ${roomId}`,
      },
    } as WatchedRoomSummary['roomInfo'],
    watchedMs: 60_000,
    startedAt: 0,
    endedAt: 60_000,
    endReason: 'checkpoint',
  };
}
