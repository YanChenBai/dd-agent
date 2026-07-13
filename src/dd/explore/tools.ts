import { tool } from 'ai';
import type { ConsolaInstance } from 'consola';
import { z } from 'zod';

import { fetchRoomUserInfo } from '../../bili-api/index.ts';
import { MIN_ROOM_OBSERVE_MS } from './duration.ts';
import type { createRoomCatalog } from './room-catalog.ts';
import type { WatchedRoomSummary } from './types.ts';
import type { createWatchManager } from './watch-manager.ts';

type RoomCatalog = ReturnType<typeof createRoomCatalog>;
type WatchManager = ReturnType<typeof createWatchManager>;

export interface ExploreRunState {
  finished: boolean;
  finishReason: string;
  watched: WatchedRoomSummary[];
}

export interface ExploreToolsOptions {
  catalog: RoomCatalog;
  logger: ConsolaInstance;
  observeRoomMs: number;
  state: ExploreRunState;
  watchManager: WatchManager;
}

export function createExploreTools(options: ExploreToolsOptions) {
  const { catalog, logger, observeRoomMs, state, watchManager } = options;

  return {
    refreshAreaPage: tool({
      description: '刷新 Bilibili 直播分区页，并返回当前直播间列表。',
      inputSchema: z.object({}),
      execute: () => catalog.refresh(),
    }),
    loadMoreRooms: tool({
      description:
        '继续向下滚动 Bilibili 直播分区页，通过无限加载获取下一批新直播间。需要查看更多直播间时使用。',
      inputSchema: z.object({}),
      execute: () => catalog.loadMore(),
    }),
    inspectRoom: tool({
      description: '查看直播间元信息，不进入观看。',
      inputSchema: z.object({
        roomId: z.number().int().positive(),
      }),
      execute: ({ roomId }) => {
        logger.info(`查看直播间 ${roomId} 元信息`);
        return fetchRoomUserInfo(roomId);
      },
    }),
    seeRoom: tool({
      description:
        '进入直播间观看一个检查段。必须根据主播名和直播标题判断初始 durationMinutes，并用 reason 说明依据；最少 1 分钟。Brain 可以中途调整时长，不喜欢时会直接退出。',
      inputSchema: z.object({
        roomId: z.number().int().positive(),
        durationMinutes: z
          .number()
          .int()
          .min(MIN_ROOM_OBSERVE_MS / 60_000)
          .max(observeRoomMs / 60_000),
        reason: z.string().trim().min(1).max(200),
      }),
      execute: async ({ roomId, durationMinutes, reason }) => {
        logger.info(`选择直播间 ${roomId}，初始观看 ${durationMinutes} 分钟：${reason}`);
        catalog.markWatched(roomId);
        const summary = await watchManager.watchRoom(roomId, durationMinutes);
        state.watched.push(summary);
        return summary;
      },
    }),
    finish: tool({
      description: '结束这轮到处 D。',
      inputSchema: z.object({
        reason: z.string().min(1).max(200),
      }),
      execute: async ({ reason }) => {
        state.finished = true;
        state.finishReason = reason;
        await watchManager.close();
        logger.success(`这轮到处 D 结束：${reason}；已看 ${state.watched.length} 个直播间`);
        return {
          reason,
          watchedRooms: state.watched.length,
        };
      },
    }),
  };
}

export type ExploreTools = ReturnType<typeof createExploreTools>;
