import { loadDDConfig } from '../../config/index.ts';
import { createLogger } from '../../logger/index.ts';
import { createExploreAgent } from './agent.ts';
import { createLiveAreaSource } from './area-source.ts';
import { MAX_ROOM_OBSERVE_MS } from './duration.ts';
import { createExplorePrompt } from './prompt.ts';
import { createRoomCatalog } from './room-catalog.ts';
import { createExploreTools, type ExploreRunState } from './tools.ts';
import type { ExploreOptions } from './types.ts';
import { createWatchManager } from './watch-manager.ts';

export async function startExplore(options: ExploreOptions = {}) {
  const logger = createLogger({ prefix: 'explore', prefixColor: 'blue' });
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
  const watchManager = createWatchManager({
    exploreStartedAt,
    logger,
    maxRunMs,
    observeRoomMs,
    sendDanmakuEnabled: options.sendDanmakuEnabled ?? config.live.sendDanmaku,
    signal,
  });
  const state: ExploreRunState = {
    finished: false,
    finishReason: '',
    watched: [],
  };
  const tools = createExploreTools({ catalog, logger, observeRoomMs, state, watchManager });
  const agent = createExploreAgent(config, tools, logger);
  const handleAbort = () => {
    void Promise.all([watchManager.close(), source.close()]);
  };
  signal.addEventListener('abort', handleAbort, { once: true });

  logger.start(`开始到处 D：${areaUrl}`);

  try {
    if (signal.aborted) {
      return {
        finished: state.finished,
        finishReason: state.finishReason,
        watched: state.watched,
      };
    }
    await catalog.refresh();
    await agent.generate({
      abortSignal: signal,
      timeout: { stepMs: config.ai.requestTimeoutMs },
      prompt: createExplorePrompt({
        areaUrl,
        maxRunMs,
        observeRoomMs,
        candidates: catalog.getAll(),
        watched: state.watched,
      }),
    });
  } catch (error) {
    if (signal.aborted) {
      if (deadlineController.signal.aborted && !options.signal?.aborted) {
        state.finished = true;
        state.finishReason = '达到最长运行时间';
        logger.info('探索流程达到最长运行时间');
      } else {
        logger.info('探索流程已取消');
      }
      return {
        finished: state.finished,
        finishReason: state.finishReason,
        watched: state.watched,
      };
    }
    logger.error('探索流程失败', error);
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    signal.removeEventListener('abort', handleAbort);
    await watchManager.close();
    await source.close();
  }

  return {
    finished: state.finished,
    finishReason: state.finishReason,
    watched: state.watched,
  };
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
