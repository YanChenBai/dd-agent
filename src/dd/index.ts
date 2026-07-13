import { fetchRoomUserInfo } from '@/bili-api/index.ts';
import { createBlive } from '@/blive/index.ts';
import { createBrain } from '@/brain/index.ts';
import { loadDDConfig } from '@/config/index.ts';
import { startHearing } from '@/hearing/index.ts';
import { createLogger } from '@/logger/index.ts';
import { createMemory } from '@/memory/index.ts';
import { createMouth } from '@/mouth/index.ts';
import type { DDMode } from '@/types/index.ts';
import { startVision } from '@/vision/index.ts';

export interface DDOptions {
  mode?: DDMode;
  sendDanmakuEnabled?: boolean;
  stopAfterMs?: number;
}

export async function createDD(roomId: number, options: DDOptions = {}) {
  const logger = createLogger({ prefix: 'dd', prefixColor: 'blue' });
  const config = await loadDDConfig();
  const stopAfterMs = options.stopAfterMs ?? config.agent.stopAfterMs;
  const sendDanmakuEnabled = options.sendDanmakuEnabled ?? config.live.sendDanmaku;
  const roomInfo = await fetchRoomUserInfo(roomId);

  if (roomInfo.room.live_status !== 1) {
    throw new Error(`直播间 ${roomInfo.room.room_id} 当前未开播`);
  }

  const blive = createBlive(roomId);
  const hearing = startHearing(blive, config);
  const vision = startVision(blive);
  const memory = createMemory(config.memory.retentionMs, config.memory.visionDir);
  const mouth = createMouth(roomId, config);
  const brain = createBrain(
    memory,
    {
      roomInfo,
      streamerAliases: config.live.streamerAliases,
    },
    config,
    options.mode ?? 'single',
  );
  let stopping = false;
  let stopTimer: NodeJS.Timeout | undefined;

  hearing.onFinal(event => {
    memory.addHearing(event);
  });

  vision.onImage(event => {
    memory.addVision(event);
  });

  brain.onDanmaku(event => {
    if (event.messages.length === 0) {
      return;
    }

    const willSend = sendDanmakuEnabled && mouth.getStatus() === 'ready';
    if (willSend && mouth) {
      void mouth.sendDanmaku(event.messages).catch(() => undefined);
    } else {
      logger.info(`仅预览弹幕：${event.messages.join('｜')}`);
    }
  });

  try {
    await blive.start();
    await mouth?.start();
    brain.start();
  } catch (error) {
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

  async function stop() {
    if (stopping) {
      return;
    }

    stopping = true;
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = undefined;
    }
    logger.info('正在关闭');
    brain.stop();
    await vision.stop();
    await hearing.stop();
    await brain.idle();
    await mouth?.idle();
    blive.stop();
    await mouth?.stop();
  }

  function idle(): Promise<void> {
    return brain.idle();
  }

  return {
    brain,
    hearing,
    idle,
    logger,
    memory,
    mouth,
    roomInfo,
    stop,
    vision,
  };
}

export type DD = Awaited<ReturnType<typeof createDD>>;
