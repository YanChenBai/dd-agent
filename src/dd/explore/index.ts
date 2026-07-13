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
  const exploreStartedAt = Date.now();
  const source = createLiveAreaSource(areaUrl, config);
  const catalog = createRoomCatalog(source, candidateLimit, logger);
  const watchManager = createWatchManager({
    exploreStartedAt,
    logger,
    maxRunMs,
    observeRoomMs,
    sendDanmakuEnabled: options.sendDanmakuEnabled ?? config.live.sendDanmaku,
  });
  const state: ExploreRunState = {
    finished: false,
    finishReason: '',
    watched: [],
  };
  const tools = createExploreTools({ catalog, logger, observeRoomMs, state, watchManager });
  const agent = createExploreAgent(config, tools, logger);

  logger.start(`开始到处 D：${areaUrl}`);

  try {
    await catalog.refresh();
    await agent.generate({
      prompt: createExplorePrompt({
        areaUrl,
        maxRunMs,
        observeRoomMs,
        candidates: catalog.getAll(),
        watched: state.watched,
      }),
    });
  } catch (error) {
    logger.error('探索流程失败', error);
    throw error;
  } finally {
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
