import type { ConsolaInstance } from 'consola';

import type { BrainDecision } from '../../brain/types.ts';
import { createLogger } from '../../logger/index.ts';
import { createDD, type DD } from '../index.ts';
import {
  assertCanContinue,
  formatDuration,
  MIN_ROOM_OBSERVE_MS,
  remainingMs,
  WATCH_CHECKPOINT_MS,
} from './duration.ts';
import type { WatchedRoomSummary } from './types.ts';

const brainLogger = createLogger({ prefix: 'brain', prefixColor: 'green' });

interface ActiveWatch {
  roomId: number;
  dd: DD;
  startedAt: number;
  plannedEndAt: number;
  maxEndAt: number;
  minEndAt: number;
  shouldSwitch: boolean;
  decision?: BrainDecision;
  finishWaiting?: () => void;
  finishTimer?: NodeJS.Timeout;
  unbindContinue?: () => void;
  unbindSwitch?: () => void;
}

export interface WatchManagerOptions {
  exploreStartedAt: number;
  logger: ConsolaInstance;
  maxRunMs: number;
  observeRoomMs: number;
  sendDanmakuEnabled: boolean;
}

export function createWatchManager(options: WatchManagerOptions) {
  const { exploreStartedAt, logger, maxRunMs, observeRoomMs, sendDanmakuEnabled } = options;
  let activeWatch: ActiveWatch | undefined;

  async function watchRoom(roomId: number, durationMinutes: number) {
    const durationMs = durationMinutes * 60_000;
    assertCanContinue(exploreStartedAt, maxRunMs);

    const watchedStartedAt = Date.now();
    const reused = activeWatch?.roomId === roomId;

    try {
      const watch = await getActiveWatch(roomId);
      const { dd } = watch;
      watch.plannedEndAt = Math.min(
        watch.maxEndAt,
        Math.max(watch.plannedEndAt, Date.now()) + durationMs,
      );
      dd.brain.setPlannedWatchEndAt(watch.plannedEndAt);

      const roomObserveMs = Math.min(
        Math.max(WATCH_CHECKPOINT_MS, watch.minEndAt - Date.now()),
        Math.max(0, watch.plannedEndAt - Date.now()),
        remainingMs(exploreStartedAt, maxRunMs),
      );
      logger.info(
        `${reused ? '继续观看' : '准备进入'}直播间 ${roomId}，本次增加 ${formatDuration(durationMs)}，本次检查 ${formatDuration(roomObserveMs)}`,
      );

      await waitForWatchCheckpoint(watch, roomObserveMs, remaining => {
        logger.debug(`直播间 ${roomId} 观察中，剩余约 ${remaining}ms`);
      });
      await dd.idle();

      const watchedEndedAt = Date.now();
      const context = readRoomContext(dd, watchedStartedAt, watchedEndedAt);
      const summary = {
        roomInfo: dd.roomInfo,
        watchedMs: watchedEndedAt - watchedStartedAt,
        startedAt: watchedStartedAt,
        endedAt: watchedEndedAt,
        canContinue: !watch.shouldSwitch && watch.plannedEndAt > watchedEndedAt,
        context,
        decision: watch.decision,
      } satisfies WatchedRoomSummary;

      logger.info(
        `直播间 ${roomId} 本段上下文：${context.hearing.length} 条语音，${context.visionFrames} 帧画面`,
      );
      logger.info(`直播间 ${roomId} 本次检查结束，累计本段 ${summary.watchedMs}ms`);

      if (watch.shouldSwitch) {
        await close();
      }
      return summary;
    } catch (error) {
      logger.error(`观看直播间 ${roomId} 失败`, error);
      await close();
      throw error;
    }
  }

  async function close() {
    const watch = activeWatch;
    activeWatch = undefined;
    watch?.unbindContinue?.();
    watch?.unbindSwitch?.();
    if (watch?.finishTimer) {
      clearTimeout(watch.finishTimer);
      watch.finishTimer = undefined;
    }
    watch?.finishWaiting?.();
    watch?.dd.brain.setPlannedWatchEndAt(undefined);
    await watch?.dd.stop();
  }

  return {
    close,
    watchRoom,
  };

  async function getActiveWatch(roomId: number) {
    if (activeWatch?.roomId === roomId) {
      return activeWatch;
    }

    await close();
    const dd = await createDD(roomId, {
      mode: 'explore',
      sendDanmakuEnabled,
      stopAfterMs: 0,
    });
    const now = Date.now();
    const watch: ActiveWatch = {
      roomId,
      dd,
      startedAt: now,
      plannedEndAt: now,
      maxEndAt: Math.min(now + observeRoomMs, exploreStartedAt + maxRunMs),
      minEndAt: Math.min(now + MIN_ROOM_OBSERVE_MS, exploreStartedAt + maxRunMs),
      shouldSwitch: false,
    };

    watch.unbindContinue = dd.brain.onContinueWatching(event => {
      watch.decision = { ...event, shouldContinue: true };
      watch.plannedEndAt = Math.max(
        watch.minEndAt,
        Math.min(watch.maxEndAt, Math.max(watch.plannedEndAt, Date.now()) + event.watchDeltaMs),
      );
      dd.brain.setPlannedWatchEndAt(watch.plannedEndAt);
      brainLogger.info(
        `调整观看时长 ${formatSignedDuration(event.watchDeltaMs)}，计划剩余 ${formatDuration(Math.max(0, watch.plannedEndAt - Date.now()))}（${event.reason}）`,
      );
      if (Date.now() >= watch.minEndAt && watch.plannedEndAt <= Date.now()) {
        watch.finishWaiting?.();
      }
    });
    watch.unbindSwitch = dd.brain.onSwitchRoom(event => {
      watch.decision = { ...event, shouldContinue: false, watchDeltaMs: 0 };
      watch.shouldSwitch = true;
      brainLogger.info(`请求切换直播间（${event.reason}）`);

      if (watch.finishTimer) {
        clearTimeout(watch.finishTimer);
      }
      const remainingMinObserveMs = Math.max(0, watch.minEndAt - Date.now());
      if (remainingMinObserveMs === 0) {
        watch.finishWaiting?.();
      } else {
        watch.finishTimer = setTimeout(() => {
          watch.finishTimer = undefined;
          watch.finishWaiting?.();
        }, remainingMinObserveMs);
      }
    });
    activeWatch = watch;
    return watch;
  }
}

function formatSignedDuration(ms: number) {
  if (ms === 0) {
    return '不变';
  }
  return `${ms > 0 ? '+' : '-'}${formatDuration(Math.abs(ms))}`;
}

function readRoomContext(dd: DD, startTimeMs: number, endTimeMs: number) {
  const records = dd.memory.query({ startTimeMs, endTimeMs });
  return {
    hearing: records
      .filter(
        (record): record is Extract<(typeof records)[number], { type: 'hearing' }> =>
          record.type === 'hearing',
      )
      .map(record => record.text)
      .filter(Boolean),
    visionFrames: records.filter(record => record.type === 'vision').length,
  };
}

async function waitForWatchCheckpoint(
  watch: ActiveWatch,
  ms: number,
  onProgress: (remainingMs: number) => void,
) {
  const endAt = Date.now() + ms;
  onProgress(ms);

  await new Promise<void>(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeout);
      clearInterval(progress);
      if (watch.finishWaiting === finish) {
        watch.finishWaiting = undefined;
      }
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    const progress = setInterval(() => {
      onProgress(Math.max(0, endAt - Date.now()));
    }, 30_000);
    watch.finishWaiting = finish;

    if (watch.shouldSwitch && Date.now() >= watch.minEndAt) {
      finish();
    }
  });
}
