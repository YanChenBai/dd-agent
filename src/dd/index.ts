import { fetchRoomUserInfo } from '@/bili-api/index.ts';
import { createBlive } from '@/blive/index.ts';
import { createBrain } from '@/brain/index.ts';
import { loadDDConfig } from '@/config/index.ts';
import { createHand } from '@/hand/index.ts';
import { startHearing } from '@/hearing/index.ts';
import { createLogger } from '@/logger/index.ts';
import { createMemory } from '@/memory/index.ts';
import type { DDMode } from '@/types/index.ts';
import { startVision } from '@/vision/index.ts';

export interface DDOptions {
  mode?: DDMode;
  sendDanmakuEnabled?: boolean;
  stopAfterMs?: number;
  signal?: AbortSignal;
}

export async function createDD(roomId: number, options: DDOptions = {}) {
  if (!Number.isSafeInteger(roomId) || roomId <= 0) {
    throw new RangeError('roomId must be a positive safe integer');
  }
  if (
    options.stopAfterMs !== undefined &&
    (!Number.isFinite(options.stopAfterMs) || options.stopAfterMs < 0)
  ) {
    throw new RangeError('stopAfterMs must be a non-negative finite number');
  }
  if (options.signal?.aborted) {
    throw toError(options.signal.reason, 'DD start aborted');
  }

  const logger = createLogger({ prefix: 'dd', prefixColor: 'blue' });
  const config = await loadDDConfig();
  const stopAfterMs = options.stopAfterMs ?? config.agent.stopAfterMs;
  const sendDanmakuEnabled = options.sendDanmakuEnabled ?? config.live.sendDanmaku;
  const roomInfo = await fetchRoomUserInfo(roomId);

  if (roomInfo.room.live_status !== 1) {
    throw new Error(`直播间 ${roomInfo.room.room_id} 当前未开播`);
  }

  const memory = createMemory(config.memory.retentionMs, config.memory.visionDir);
  const hand = createHand(roomId, config);
  const brain = createBrain(
    memory,
    {
      roomInfo,
      streamerAliases: config.live.streamerAliases,
    },
    config,
    options.mode ?? 'single',
  );
  const blive = createBlive(roomId);
  const hearing = startHearing(blive, config);
  const vision = startVision(blive);
  let stopPromise: Promise<void> | undefined;
  let fatalError: Error | undefined;
  let stopTimer: NodeJS.Timeout | undefined;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>(resolve => {
    resolveStopped = resolve;
  });

  const fail = (source: string, error: unknown) => {
    fatalError ??= toError(error, `${source} failed`);
    logger.error(`${source} 发生致命错误`, fatalError);
    void stop().catch(() => undefined);
  };

  hearing.onFinal(event => {
    memory.addHearing(event);
  });

  vision.onImage(event => {
    memory.addVision(event);
  });

  const unbindBliveError = blive.onError(error => {
    fail('FFmpeg', error);
  });
  const unbindBliveClose = blive.onClose((code, signal) => {
    if (!stopPromise) {
      fail(
        'FFmpeg',
        new Error(`unexpected close (code=${String(code)}, signal=${String(signal)})`),
      );
    }
  });
  const unbindHearingError = hearing.onError(error => {
    fail('Hearing', error);
  });

  brain.onDanmaku(event => {
    if (event.messages.length === 0) {
      return;
    }

    const willSend = sendDanmakuEnabled && hand.getStatus() === 'ready';
    if (willSend) {
      void hand.sendDanmaku(event.messages).catch(error => {
        logger.warn('弹幕发送失败', error);
      });
    } else {
      logger.info(`仅预览弹幕：${event.messages.join('｜')}`);
    }
  });

  try {
    await blive.start();
    options.signal?.addEventListener('abort', handleAbort, { once: true });
    if (options.signal?.aborted) {
      await stop();
      return createResult();
    }
    await hand.start();
    brain.start();
  } catch (error) {
    if (options.signal?.aborted) {
      await stop();
      return createResult();
    }
    logger.error(`直播间 ${roomInfo.room.room_id} 启动失败`, error);
    await stop();
    throw error;
  }

  logger.start(
    `直播间 ${roomInfo.room.room_id} 已连接，弹幕发送：${sendDanmakuEnabled ? '开启' : '关闭'}`,
  );

  if (stopAfterMs > 0) {
    stopTimer = setTimeout(() => {
      void stop();
    }, stopAfterMs);
  }

  function stop(): Promise<void> {
    stopPromise ??= stopDD();
    return stopPromise;
  }

  async function stopDD() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = undefined;
    }
    logger.info('正在关闭');
    brain.stop();
    const stopBlive = blive.stop();
    const stopHand = hand.stop();

    try {
      await Promise.all([vision.stop(), hearing.stop()]);
      await brain.idle();
      await Promise.all([stopBlive, stopHand]);
      memory.clear();
    } catch (error) {
      fatalError ??= toError(error, 'DD cleanup failed');
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', handleAbort);
      unbindBliveError();
      unbindBliveClose();
      unbindHearingError();
      resolveStopped?.();
      resolveStopped = undefined;
    }
  }

  function idle(): Promise<void> {
    return brain.idle();
  }

  async function waitForStop(): Promise<void> {
    await stopped;
    if (fatalError) {
      throw fatalError;
    }
  }

  function handleAbort() {
    void stop().catch(() => undefined);
  }

  return createResult();

  function createResult() {
    return {
      brain,
      hearing,
      idle,
      logger,
      memory,
      hand,
      roomInfo,
      stop,
      vision,
      waitForStop,
    };
  }
}

function toError(error: unknown, fallbackMessage: string) {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === 'string' ? error : fallbackMessage);
}

export type DD = Awaited<ReturnType<typeof createDD>>;
