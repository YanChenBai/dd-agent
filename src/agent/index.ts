import { fetchRoomUserInfo } from '../bili-api/index.ts';
import { createBlive } from '../blive/index.ts';
import { createBrain } from '../brain/index.ts';
import { env } from '../env.ts';
import { startHearing } from '../hearing/index.ts';
import { createLogger } from '../logger/index.ts';
import { createMemory } from '../memory/index.ts';
import { startVision } from '../vision/index.ts';

export interface AgentOptions {
  sendDanmakuEnabled?: boolean;
  stopAfterMs?: number;
}

export async function startAgent(roomId: number, options: AgentOptions = {}) {
  const stopAfterMs = options.stopAfterMs ?? env.AGENT_STOP_AFTER_MS;
  const roomInfo = await fetchRoomUserInfo(roomId);

  if (roomInfo.room.live_status !== 1) {
    throw new Error(`直播间 ${roomInfo.room.room_id} 当前未开播`);
  }

  const blive = createBlive(roomId);
  const hearing = startHearing(blive);
  const vision = startVision(blive);
  const memory = createMemory(env.MEMORY_RETENTION_MS);
  const brain = createBrain(memory, {
    roomInfo,
    streamerAliases: env.LIVE_STREAMER_ALIASES,
  });
  const logger = createLogger(roomInfo, {
    sendDanmakuEnabled: options.sendDanmakuEnabled ?? env.SEND_DANMAKU === 1,
  });
  let stopping = false;
  let stopTimer: NodeJS.Timeout | undefined;

  logger.mount();

  hearing.onFinal(event => {
    logger.hearing(event);
    memory.addHearing(event);
  });

  blive.onError(error => {
    logger.error('room', error);
  });

  blive.onStderr(message => {
    const value = message.trim();
    if (value && !value.includes('deprecated pixel format used')) {
      logger.ffmpeg(value);
    }
  });

  vision.onImage(event => {
    logger.vision(event);
    memory.addVision(event);
    brain.queueDanmaku({
      startTimeMs: event.startTimeMs,
      endTimeMs: event.endTimeMs,
    });
  });

  vision.onError(error => {
    logger.error('vision', error);
  });

  brain.onDanmaku(event => {
    const willSend = logger.state.sendDanmakuEnabled;
    const entries = logger.danmaku(event, willSend);
    if (willSend) {
      void blive
        .sendDanmaku(event.messages)
        .then(() => {
          logger.danmakuDelivery(entries, 'sent');
        })
        .catch(error => {
          logger.danmakuDelivery(entries, 'failed');
          logger.error('brain', error);
        });
    }
  });

  brain.onError(error => {
    logger.error('brain', error);
  });

  blive.onClose((code, signal) => {
    if (!stopping) {
      logger.error('ffmpeg', `意外关闭（code=${String(code)}, signal=${String(signal)}）`);
    }
  });

  if (stopAfterMs > 0) {
    stopTimer = setTimeout(() => {
      void stop();
    }, stopAfterMs);
  }

  await blive.start();

  async function stop() {
    if (stopping) {
      return;
    }

    stopping = true;
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = undefined;
    }
    logger.unmount();
    await vision.stop();
    await hearing.stop();
    await blive.stop();
    await brain.idle();
  }

  return {
    brain,
    hearing,
    idle: () => brain.idle(),
    logger,
    memory,
    roomInfo,
    stop,
    vision,
  };
}

export type Agent = Awaited<ReturnType<typeof startAgent>>;
