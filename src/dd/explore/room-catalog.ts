import type { ConsolaInstance } from 'consola';

import type { createLiveAreaSource } from './area-source.ts';
import type { LiveAreaBatch, LiveRoomCandidate } from './types.ts';

type LiveAreaSource = ReturnType<typeof createLiveAreaSource>;

export function createRoomCatalog(
  source: LiveAreaSource,
  candidateLimit: number,
  logger: ConsolaInstance,
) {
  const candidates = new Map<number, LiveRoomCandidate>();

  async function refresh() {
    logger.info(`刷新分区页，最多读取 ${candidateLimit} 个直播间`);
    const batch = await source.refresh(candidateLimit);
    merge(batch);
    logger.info(
      `第 ${batch.batch} 批发现 ${batch.candidates.length} 个主播，累计 ${candidates.size} 个直播间`,
    );
    logRooms(batch.candidates);
    return snapshot(batch.batch);
  }

  async function loadMore() {
    logger.info(`继续滚动分区页，加载第 ${source.getBatchNumber() + 1} 批直播间`);
    const batch = await source.loadMore(candidateLimit);
    merge(batch);
    logger.info(
      `第 ${batch.batch} 批发现 ${batch.candidates.length} 个主播，累计 ${candidates.size} 个直播间`,
    );
    logRooms(batch.candidates);
    return snapshot(batch.batch);
  }

  function getAll() {
    return [...candidates.values()];
  }

  function markWatched(roomId: number) {
    const candidate = candidates.get(roomId);
    if (candidate) {
      candidate.watched = (candidate.watched ?? 0) + 1;
    }
  }

  return {
    getAll,
    markWatched,
    loadMore,
    refresh,
  };

  function merge(batch: LiveAreaBatch) {
    for (const candidate of batch.candidates) {
      const existing = candidates.get(candidate.roomId);
      candidates.set(candidate.roomId, {
        ...candidate,
        watched: existing?.watched ?? 0,
      });
    }
  }

  function snapshot(batch: number) {
    return { batch, candidates: getAll() };
  }
}

function logRooms(rooms: readonly LiveRoomCandidate[]) {
  for (const room of rooms) {
    console.log(`直播间：${room.roomId}｜主播：${room.anchor}｜标题：${room.title}`);
  }
}
