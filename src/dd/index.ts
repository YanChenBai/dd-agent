import {
  fetchRoomUserInfo,
  isRoomLive,
  RoomNotLiveError,
  type BiliApiRequestOptions,
} from '@/bili-api/index.ts';
import { createBlive } from '@/blive/index.ts';
import { createBrain } from '@/brain/index.ts';
import { loadDDConfig } from '@/config/index.ts';
import { createHand } from '@/hand/index.ts';
import { startHearing } from '@/hearing/index.ts';
import { formatDurationMs } from '@/logger/format.ts';
import { createLogger } from '@/logger/index.ts';
import { createMemory } from '@/memory/index.ts';
import { runCleanup } from '@/observability/cleanup.ts';
import {
  createRoomContext,
  createRunContext,
  withComponent,
  type RunContext,
} from '@/observability/context.ts';
import { formatTokenUsageReport } from '@/observability/token-usage.ts';
import type { DDMode } from '@/types/index.ts';
import { startVision } from '@/vision/index.ts';

import {
  DDComponentError,
  type DDComponent,
  type DDComponentErrorSeverity,
  type DDStatus,
  type DDStopReason,
  type DDStopResult,
} from './types.ts';

export * from './types.ts';

export interface DDOptions {
  mode?: DDMode;
  sendDanmakuEnabled?: boolean;
  stopAfterMs?: number;
  signal?: AbortSignal;
  runContext?: RunContext;
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

  const startedAt = Date.now();
  const mode = options.mode ?? 'single';
  const runContext = options.runContext ?? createRunContext(mode);
  const roomContext = createRoomContext(runContext, roomId);
  const logger = createLogger({
    prefix: 'dd',
    prefixColor: 'blue',
    context: withComponent(roomContext, 'dd'),
  });
  let emptyDanmakuResults = 0;
  let generatedDanmakus = 0;
  let previewedDanmakus = 0;
  let requestedDanmakus = 0;
  let failedDanmakuBatches = 0;
  const config = await loadDDConfig();
  const stopAfterMs = options.stopAfterMs ?? config.agent.stopAfterMs;
  const sendDanmakuEnabled = options.sendDanmakuEnabled ?? config.live.sendDanmaku;
  const apiRequestOptions = {
    timeoutMs: config.live.apiRequestTimeoutMs,
    retryLimit: config.live.apiRetryLimit,
    retryBackoffMs: config.live.apiRetryBackoffMs,
  } satisfies BiliApiRequestOptions;
  const roomInfo = await fetchRoomUserInfo(roomId, {
    ...apiRequestOptions,
    signal: options.signal,
  });

  if (roomInfo.room.live_status !== 1) {
    throw new RoomNotLiveError(roomInfo.room.room_id);
  }

  const memory = createMemory(config.memory.retentionMs, config.memory.visionDir);
  const hand = createHand(roomId, config, roomContext);
  const brain = createBrain(
    memory,
    {
      roomInfo,
      streamerAliases: config.live.streamerAliases,
    },
    config,
    mode,
    roomContext,
  );
  const liveStatusController = new AbortController();
  const blive = createBlive(
    roomId,
    { ...apiRequestOptions, signal: liveStatusController.signal },
    config.live.ffmpegStopTimeoutMs,
    roomContext,
  );
  const hearing = startHearing(blive, config, roomContext);
  const vision = startVision(blive, { context: roomContext });
  let status: DDStatus = 'starting';
  let stopPromise: Promise<DDStopResult> | undefined;
  let stopReason: DDStopReason | undefined;
  let stopError: Error | undefined;
  let stopTimer: NodeJS.Timeout | undefined;
  let liveStatusTimer: NodeJS.Timeout | undefined;
  let liveStatusCheckPromise: Promise<void> | undefined;
  let unexpectedBliveClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let recoveringBlive = false;
  let ffmpegRestartAttempts = 0;
  let resolveStopped: ((result: DDStopResult) => void) | undefined;
  const stopped = new Promise<DDStopResult>(resolve => {
    resolveStopped = resolve;
  });

  const reportComponentError = (
    source: DDComponent,
    severity: DDComponentErrorSeverity,
    error: unknown,
  ) => {
    const cause = toError(error, `${source} failed`);
    const value =
      cause instanceof DDComponentError ? cause : new DDComponentError(source, severity, cause);
    const message = `${source} 组件错误：severity=${severity}`;
    if (severity === 'fatal') {
      logger.error(message, value);
    } else {
      logger.warn(message, value);
    }
    return value;
  };

  const fail = (source: DDComponent, error: unknown) => {
    const value = reportComponentError(source, 'fatal', error);
    void stop('component-failure', value);
  };

  const unbindHearingFinal = hearing.onFinal(event => {
    memory.addHearing(event);
  });
  const unbindVisionImage = vision.onImage(event => {
    memory.addVision(event);
  });
  const unbindBliveError = blive.onError(error => {
    fail('FFmpeg', error);
  });
  const unbindBliveClose = blive.onClose((code, signal) => {
    if (stopPromise || recoveringBlive) {
      return;
    }
    unexpectedBliveClose = { code, signal };
    void checkLiveStatus();
  });
  const unbindHearingError = hearing.onError(error => {
    fail('Hearing', error);
  });
  const unbindVisionError = vision.onError(error => {
    reportComponentError('Vision', 'recoverable', error);
  });
  const unbindBrainError = brain.onError(error => {
    reportComponentError('Brain', 'recoverable', error);
  });
  const unbindHandError = hand.onError(error => {
    if (sendDanmakuEnabled) {
      fail('Hand', error);
    } else {
      reportComponentError('Hand', 'degraded', error);
    }
  });
  const unbindDanmaku = brain.onDanmaku(event => {
    if (event.messages.length === 0) {
      emptyDanmakuResults += 1;
      return;
    }

    generatedDanmakus += event.messages.length;

    const willSend = sendDanmakuEnabled && hand.getStatus() === 'ready';
    if (willSend) {
      requestedDanmakus += event.messages.length;
      void hand.sendDanmaku(event.messages).catch(error => {
        failedDanmakuBatches += 1;
        logger.warn('弹幕发送失败', error);
      });
    } else {
      previewedDanmakus += event.messages.length;
      logger.info(`仅预览弹幕：${event.messages.join('｜')}`);
    }
  });

  options.signal?.addEventListener('abort', handleAbort, { once: true });

  try {
    await blive.start();
    if (options.signal?.aborted || stopPromise) {
      await stop('signal');
      return createResult();
    }
    await hand.start();
    if (options.signal?.aborted || stopPromise) {
      await stop('signal');
      return createResult();
    }
    brain.start();
    status = 'running';
  } catch (error) {
    if (stopPromise) {
      const result = await stopPromise;
      if (result.reason !== 'component-failure') {
        return createResult();
      }
      throw result.error ?? toError(error, 'DD component failed during startup');
    }
    if (options.signal?.aborted) {
      await stop('signal');
      return createResult();
    }
    const value = new DDComponentError(
      'Startup',
      'fatal',
      toError(error, `直播间 ${roomInfo.room.room_id} 启动失败`),
    );
    logger.error(`直播间 ${roomInfo.room.room_id} 启动失败`, value);
    await stop('component-failure', value);
    throw value;
  }

  logger.start(
    `直播间 ${roomInfo.room.room_id} 已连接，弹幕发送：${sendDanmakuEnabled ? '开启' : '关闭'}`,
  );

  liveStatusTimer = setInterval(() => {
    void checkLiveStatus();
  }, config.live.statusPollIntervalMs);

  if (stopAfterMs > 0) {
    stopTimer = setTimeout(() => {
      void stop('timeout');
    }, stopAfterMs);
  }

  function getStatus(): DDStatus {
    return status;
  }

  function stop(reason: DDStopReason = 'manual-stop', error?: Error): Promise<DDStopResult> {
    if (stopPromise) {
      return stopPromise;
    }

    stopReason = reason;
    if (reason === 'component-failure') {
      stopError = error ?? new Error('DD component failed');
    }
    status = 'stopping';
    stopPromise = stopDD();
    return stopPromise;
  }

  async function stopDD(): Promise<DDStopResult> {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = undefined;
    }
    if (liveStatusTimer) {
      clearInterval(liveStatusTimer);
      liveStatusTimer = undefined;
    }
    liveStatusController.abort(new Error('DD stopped'));
    logger.info(`正在关闭：${stopReason ?? 'manual-stop'}`);
    brain.stop();

    const cleanupStartedAt = performance.now();
    const cleanup = await Promise.all([
      runCleanup('FFmpeg', () => blive.stop(), config.agent.shutdownTimeoutMs),
      runCleanup('Hand/Browser', () => hand.stop(), config.agent.shutdownTimeoutMs),
      runCleanup('Vision', () => vision.stop(), config.agent.shutdownTimeoutMs),
      runCleanup('Hearing', () => hearing.stop(), config.agent.shutdownTimeoutMs),
      runCleanup('Brain', () => brain.idle(), config.agent.shutdownTimeoutMs),
    ]);

    const finalHealth = blive.getHealth();
    const finalHearingStats = hearing.getStats();
    const finalMemorySize = memory.getSize();
    const tokenUsage = brain.getTokenUsage();
    const finalHandStats = hand.getStats();

    cleanup.push(
      await runCleanup(
        'Memory',
        () => memory.clear(),
        Math.max(1, config.agent.shutdownTimeoutMs - (performance.now() - cleanupStartedAt)),
      ),
    );

    for (const item of cleanup) {
      const message = `组件关闭：${item.component}，结果 ${item.status}，耗时 ${formatDurationMs(item.durationMs)}`;
      if (item.error) {
        logger.error(message, item.error);
      } else {
        logger.info(message);
      }
    }

    const cleanupErrors = cleanup.flatMap(item => (item.error ? [item.error] : []));

    if (cleanupErrors.length > 0) {
      const cleanupError = new AggregateError(cleanupErrors, 'DD cleanup failed');
      stopError ??= cleanupError;
      logger.error('DD 关闭时发生错误', cleanupError);
    }

    options.signal?.removeEventListener('abort', handleAbort);
    unbindHearingFinal();
    unbindVisionImage();
    unbindBliveError();
    unbindBliveClose();
    unbindHearingError();
    unbindVisionError();
    unbindBrainError();
    unbindHandError();
    unbindDanmaku();

    status = 'stopped';
    const result: DDStopResult = {
      reason: stopReason ?? 'manual-stop',
      roomId: roomInfo.room.room_id,
      startedAt,
      endedAt: Date.now(),
      tokenUsage,
      cleanup,

      error: stopError,
    };
    logger.info(
      `运行结束：原因 ${result.reason}，时长 ${formatDurationMs(result.endedAt - result.startedAt)}，音频 ${finalHealth.audioChunks} chunks/${finalHealth.audioBytes} bytes，画面 ${finalHealth.imageFrames} 帧，FFmpeg 启动 ${formatOptionalDuration(finalHealth.lastStartDurationMs)}、最近运行 ${formatOptionalDuration(finalHealth.lastRunDurationMs)}、退出 code=${String(finalHealth.lastExitCode)} signal=${String(finalHealth.lastExitSignal)}、FLV 刷新 ${finalHealth.flvRefreshes ?? 0} 次、重启 ${ffmpegRestartAttempts} 次、SIGTERM 超时 ${finalHealth.sigtermTimeouts ?? 0} 次、SIGKILL ${finalHealth.sigkillCount ?? 0} 次，ASR 解码 ${finalHearingStats.decodedSegments}、丢弃 ${finalHearingStats.droppedSegments}、失败 ${finalHearingStats.failedSegments}，清理前记忆 ${finalMemorySize} 条`,
    );
    logger.info(`Token 消耗报告（直播间 ${result.roomId}）：${formatTokenUsageReport(tokenUsage)}`);
    logger.info(
      `最终摘要：run ${formatDurationMs(result.endedAt - result.startedAt)} | room ${result.roomId} | media ${formatMediaAge(finalHealth.lastMediaAtMs)} | ASR queue ${finalHearingStats.queuedAudioSeconds.toFixed(1)}s | memory ${finalMemorySize} | AI ${tokenUsage.requests} calls / ${tokenUsage.totalTokens} tokens | danmaku generated ${generatedDanmakus} / preview ${previewedDanmakus} / requested ${requestedDanmakus} / sent ${finalHandStats.sentMessages} / failed ${finalHandStats.failedMessages}（批次 ${failedDanmakuBatches}）/ empty ${emptyDanmakuResults}`,
    );
    resolveStopped?.(result);
    resolveStopped = undefined;
    return result;
  }

  function idle(): Promise<void> {
    return brain.idle();
  }

  async function waitForStop(): Promise<DDStopResult> {
    const result = await stopped;
    if (result.reason === 'component-failure') {
      throw result.error ?? new Error('DD component failed');
    }
    return result;
  }

  async function checkLiveStatus(): Promise<void> {
    if (stopPromise || liveStatusCheckPromise) {
      return liveStatusCheckPromise;
    }

    const operation = (async () => {
      try {
        const live = await isRoomLive(roomId, {
          ...apiRequestOptions,
          signal: liveStatusController.signal,
        });
        if (stopPromise) {
          return;
        }
        if (!live) {
          logger.info(`检测到直播间 ${roomId} 已下播`);
          await stop('live-ended');
          return;
        }

        if (unexpectedBliveClose) {
          const { code, signal } = unexpectedBliveClose;
          await recoverBlive(`unexpected close (code=${String(code)}, signal=${String(signal)})`);
          return;
        }

        const health = blive.getHealth();
        const hearingStats = hearing.getStats();
        const handStats = hand.getStats();
        const tokenUsage = brain.getTokenUsage();
        const lastMediaAtMs = health.lastMediaAtMs ?? health.startedAtMs;
        const mediaAgeMs =
          lastMediaAtMs === undefined ? undefined : Math.max(0, Date.now() - lastMediaAtMs);
        logger.info(
          `健康状态：运行 ${formatDurationMs(Date.now() - startedAt)}，媒体 ${mediaAgeMs === undefined ? '尚未到达' : formatDurationMs(mediaAgeMs)}，音频 ${health.audioChunks} chunks/${health.audioBytes} bytes，画面 ${health.imageFrames} 帧，ASR 排队 ${hearingStats.queuedSegments} 段/${hearingStats.queuedAudioSeconds.toFixed(1)}s，丢弃 ${hearingStats.droppedSegments}，记忆 ${memory.getSize()} 条，AI ${tokenUsage.requests} calls/${tokenUsage.totalTokens} tokens，弹幕 ${handStats.sentMessages}/${handStats.attemptedMessages}、失败 ${handStats.failedMessages}`,
        );

        if (
          lastMediaAtMs !== undefined &&
          Date.now() - lastMediaAtMs >= config.live.mediaStallTimeoutMs
        ) {
          await recoverBlive(
            `media stalled for ${Date.now() - lastMediaAtMs}ms while room ${roomId} is still live`,
          );
        }
      } catch (error) {
        if (stopPromise || liveStatusController.signal.aborted) {
          return;
        }

        if (unexpectedBliveClose) {
          const { code, signal } = unexpectedBliveClose;
          fail(
            'FFmpeg',
            new Error(
              `unexpected close (code=${String(code)}, signal=${String(signal)}); live status check failed`,
              { cause: toError(error, 'Live status check failed') },
            ),
          );
        } else {
          logger.warn('检查直播状态失败，将在下一周期重试', error);
        }
      }
    })().finally(() => {
      if (liveStatusCheckPromise === operation) {
        liveStatusCheckPromise = undefined;
      }
    });

    liveStatusCheckPromise = operation;
    return operation;
  }

  function handleAbort() {
    void stop('signal');
  }

  async function recoverBlive(trigger: string): Promise<void> {
    if (recoveringBlive || stopPromise) {
      return;
    }

    recoveringBlive = true;
    unexpectedBliveClose = undefined;
    let lastError: Error = new Error(trigger);
    try {
      if (blive.isRunning()) {
        await blive.stop();
      }

      while (!stopPromise && ffmpegRestartAttempts < config.live.ffmpegMaxRestarts) {
        ffmpegRestartAttempts += 1;
        const backoffMs = config.live.ffmpegRestartBackoffMs * 2 ** (ffmpegRestartAttempts - 1);
        logger.warn(
          `FFmpeg 恢复：第 ${ffmpegRestartAttempts}/${config.live.ffmpegMaxRestarts} 次，等待 ${formatDurationMs(backoffMs)}（${trigger}）`,
        );
        await waitForAbortableDelay(backoffMs, liveStatusController.signal);
        if (stopPromise) {
          return;
        }

        try {
          await blive.start();
          logger.success(`FFmpeg 已在第 ${ffmpegRestartAttempts} 次尝试后恢复`);
          return;
        } catch (error) {
          lastError = toError(error, 'FFmpeg restart failed');
          logger.warn(`FFmpeg 第 ${ffmpegRestartAttempts} 次重启失败`, lastError);
        }
      }
    } catch (error) {
      if (stopPromise || liveStatusController.signal.aborted) {
        return;
      }
      lastError = toError(error, 'FFmpeg recovery failed');
    } finally {
      recoveringBlive = false;
    }

    if (!stopPromise) {
      fail(
        'FFmpeg',
        new Error(`${trigger}; recovery exhausted after ${ffmpegRestartAttempts} attempt(s)`, {
          cause: lastError,
        }),
      );
    }
  }

  return createResult();

  function createResult() {
    return {
      brain,
      hearing,
      idle,
      getStatus,
      logger,
      memory,
      hand,
      roomInfo,
      context: roomContext,
      stop,
      vision,
      waitForStop,
    };
  }
}

function waitForAbortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', abort, { once: true });

    function finish() {
      signal.removeEventListener('abort', abort);
      resolve();
    }

    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
  });
}

function formatOptionalDuration(ms: number | undefined): string {
  return ms === undefined ? '未知' : formatDurationMs(ms);
}

function formatMediaAge(lastMediaAtMs: number | undefined): string {
  return lastMediaAtMs === undefined
    ? '尚未到达'
    : formatDurationMs(Math.max(0, Date.now() - lastMediaAtMs));
}

function toError(error: unknown, fallbackMessage: string) {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === 'string' ? error : fallbackMessage);
}

export type DD = Awaited<ReturnType<typeof createDD>>;
