import { BiliApiError, BiliApiRequestError, RoomNotLiveError } from '../../bili-api/index.ts';
import { loadDDConfig } from '../../config/index.ts';
import { formatDurationMs } from '../../logger/format.ts';
import { createLogger } from '../../logger/index.ts';
import { runCleanup, type CleanupResult } from '../../observability/cleanup.ts';
import { createRunContext, withComponent } from '../../observability/context.ts';
import {
  addFailedTokenRequest,
  addTokenUsage,
  createTokenUsageReport,
  formatTokenUsageReport,
  mergeTokenUsage,
} from '../../observability/token-usage.ts';
import { DDComponentError } from '../types.ts';
import { createExploreAgent } from './agent.ts';
import { createLiveAreaSource } from './area-source.ts';
import { MAX_ROOM_OBSERVE_MS, MIN_ROOM_OBSERVE_MS } from './duration.ts';
import { createExplorePrompt } from './prompt.ts';
import { createRoomCatalog } from './room-catalog.ts';
import type { ExploreDecision, ExploreOptions, WatchedRoomSummary } from './types.ts';
import { createWatchManager } from './watch-manager.ts';

interface ExploreRunState {
  finished: boolean;
  finishReason: string;
  watched: WatchedRoomSummary[];
}

export async function startExplore(options: ExploreOptions = {}) {
  const runContext = options.runContext ?? createRunContext('explore');
  const logger = createLogger({
    prefix: 'explore',
    prefixColor: 'blue',
    context: withComponent(runContext, 'explore'),
  });
  const config = await loadDDConfig();
  const areaUrl = options.areaUrl ?? config.explore.areaUrl;
  const maxRunMs = options.maxRunMs ?? config.explore.maxRunMs;
  const observeRoomMs = Math.min(
    options.observeRoomMs ?? config.explore.observeRoomMs,
    MAX_ROOM_OBSERVE_MS,
  );
  const candidateLimit = options.candidateLimit ?? config.explore.candidateLimit;
  validateExploreOptions({ areaUrl, candidateLimit, maxRunMs, observeRoomMs });
  const exploreStartedAt = Date.now();
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => {
    deadlineController.abort(new Error(`Explore reached maxRunMs (${maxRunMs})`));
  }, maxRunMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadlineController.signal])
    : deadlineController.signal;
  const source = createLiveAreaSource(areaUrl, config);
  const catalog = createRoomCatalog(source, candidateLimit, logger);
  const selectionTokenUsage = createTokenUsageReport();
  const tokenUsage = {
    selection: selectionTokenUsage,
    rooms: createTokenUsageReport(),
    total: createTokenUsageReport(),
  };
  const cleanup: CleanupResult[] = [];
  const watchManager = createWatchManager({
    exploreStartedAt,
    logger,
    maxRunMs,
    observeRoomMs,
    sendDanmakuEnabled: options.sendDanmakuEnabled ?? config.live.sendDanmaku,
    signal,
    runContext,
  });
  const state: ExploreRunState = {
    finished: false,
    finishReason: '',
    watched: [],
  };
  const agent = createExploreAgent(config);
  const handleAbort = () => {
    void Promise.allSettled([watchManager.close(), source.close()]);
  };
  signal.addEventListener('abort', handleAbort, { once: true });

  logger.start(`开始到处 D：${areaUrl}`);

  try {
    if (signal.aborted) {
      return createResult();
    }
    await catalog.refresh();
    while (!signal.aborted && !state.finished) {
      const requestStartedAt = performance.now();
      const result = await agent
        .generate({
          abortSignal: signal,
          timeout: { stepMs: config.ai.requestTimeoutMs },
          prompt: createExplorePrompt({
            areaUrl,
            maxRunMs,
            observeRoomMs,
            candidates: catalog.getAll(),
            watched: state.watched,
          }),
        })
        .then(
          result => {
            addTokenUsage(selectionTokenUsage, result.usage);
            return result;
          },
          error => {
            addFailedTokenRequest(selectionTokenUsage);
            throw error;
          },
        );
      if (result.usage) {
        logger.info(
          `选房 AI 请求完成：${formatDurationMs(performance.now() - requestStartedAt)}，tokens ${result.usage.inputTokens ?? '?'}+${result.usage.outputTokens ?? '?'}=${result.usage.totalTokens ?? '?'}，finish=${result.finishReason}`,
        );
      }
      const decision = result.output as ExploreDecision;
      logger.info(`探索决策：${JSON.stringify(decision)}`);

      if (decision.continue) {
        const previousCandidateCount = catalog.getAll().length;
        await catalog.loadMore();
        if (catalog.getAll().length === previousCandidateCount) {
          state.finished = true;
          state.finishReason = `分区页已滚动到底：${decision.reason}`;
          logger.info(state.finishReason);
        }
        continue;
      }

      if (decision.roomId === null) {
        state.finished = true;
        state.finishReason = decision.reason;
        logger.success(`这轮到处 D 结束：${decision.reason}`);
        continue;
      }

      const candidate = catalog.getAll().find(item => item.roomId === decision.roomId);
      if (!candidate || candidate.unavailable) {
        throw new RangeError(`模型选择了不可用的直播间：${decision.roomId}`);
      }

      logger.info(`选择直播间 ${decision.roomId}：${decision.reason}`);
      catalog.markWatched(decision.roomId);
      let summary: WatchedRoomSummary;
      try {
        summary = await watchManager.watchRoom(decision.roomId, MIN_ROOM_OBSERVE_MS / 60_000);
      } catch (error) {
        if (!isRoomScopedFailure(error)) {
          throw error;
        }
        catalog.markUnavailable(decision.roomId);
        logger.warn(`直播间 ${decision.roomId} 发生房间级故障，跳过并继续探索`, error);
        continue;
      }
      state.watched.push(summary);
      if (summary.endReason === 'live-ended') {
        catalog.markUnavailable(decision.roomId);
      }
    }
  } catch (error) {
    if (signal.aborted) {
      if (deadlineController.signal.aborted && !options.signal?.aborted) {
        state.finished = true;
        state.finishReason = '达到最长运行时间';
        logger.info('探索流程达到最长运行时间');
      } else {
        logger.info('探索流程已取消');
      }
      return createResult();
    }
    logger.error('探索流程失败', error);
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    signal.removeEventListener('abort', handleAbort);
    cleanup.push(
      ...(await Promise.all([
        runCleanup('WatchManager', () => watchManager.close(), config.agent.shutdownTimeoutMs),
        runCleanup('ExploreBrowser', () => source.close(), config.agent.shutdownTimeoutMs),
      ])),
    );
    for (const item of cleanup) {
      const message = `组件关闭：${item.component}，结果 ${item.status}，耗时 ${formatDurationMs(item.durationMs)}`;
      if (item.error) {
        logger.error(message, item.error);
      } else {
        logger.info(message);
      }
    }

    Object.assign(tokenUsage.rooms, watchManager.getTokenUsage());
    const total = createTokenUsageReport();
    mergeTokenUsage(total, tokenUsage.selection);
    mergeTokenUsage(total, tokenUsage.rooms);
    Object.assign(tokenUsage.total, total);
    logger.info(
      `Token 消耗报告（探索完全结束）：总计 ${formatTokenUsageReport(tokenUsage.total)}；选房 ${formatTokenUsageReport(tokenUsage.selection)}；直播间 Brain ${formatTokenUsageReport(tokenUsage.rooms)}`,
    );

    const cleanupErrors = cleanup.flatMap(item => (item.error ? [item.error] : []));
    if (cleanupErrors.length > 0) {
      logger.error(
        'Explore 关闭时发生错误',
        new AggregateError(cleanupErrors, 'Explore cleanup failed'),
      );
    }
  }

  return createResult();

  function createResult() {
    return {
      finished: state.finished,
      finishReason: state.finishReason,
      watched: state.watched,
      tokenUsage,
      cleanup,
      context: runContext,
    };
  }
}

function isRoomScopedFailure(error: unknown): boolean {
  return (
    error instanceof DDComponentError ||
    error instanceof RoomNotLiveError ||
    error instanceof BiliApiRequestError ||
    error instanceof BiliApiError
  );
}

export type Explore = Awaited<ReturnType<typeof startExplore>>;
export type { ExploreOptions } from './types.ts';

function validateExploreOptions(options: {
  areaUrl: string;
  candidateLimit: number;
  maxRunMs: number;
  observeRoomMs: number;
}) {
  try {
    new URL(options.areaUrl);
  } catch {
    throw new TypeError('areaUrl must be a valid URL');
  }

  for (const [name, value] of Object.entries({
    candidateLimit: options.candidateLimit,
    maxRunMs: options.maxRunMs,
    observeRoomMs: options.observeRoomMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}
