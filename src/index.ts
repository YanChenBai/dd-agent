import { fetchRoomUserInfo } from './bili-api/index.ts';
import { createBlive } from './blive-stream/index.ts';
import { createBrain } from './brain/index.ts';
import { sendDanmaku, stopDanmakuSender } from './danmaku/index.ts';
import { env } from './env.ts';
import { startHearing } from './hearing/index.ts';
import { createMemory } from './memory/index.ts';
import { createDashboard } from './tui/controller.ts';
import { startVision } from './vision/index.ts';

const stopAfterMs = env.AGENT_STOP_AFTER_MS;
const roomId = env.LIVE_ROOM_ID;
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
const dashboard = createDashboard(roomInfo);
let stopping = false;

dashboard.mount();

hearing.onFinal(event => {
  dashboard.addHearing(event);
  memory.addHearing(event);
});

blive.onError(error => {
  dashboard.addError('room', error);
});

blive.onStderr(message => {
  const value = message.trim();
  if (value && !value.includes('deprecated pixel format used')) {
    dashboard.addError('room', `FFmpeg: ${value}`);
  }
});

vision.onImage(event => {
  dashboard.addVision(event);
  memory.addVision(event);
  brain.queueDanmaku({
    startTimeMs: event.startTimeMs,
    endTimeMs: event.endTimeMs,
  });
});

vision.onError(error => {
  dashboard.addError('vision', error);
});

brain.onDanmaku(event => {
  dashboard.addDanmaku(event);
  if (env.SEND_DANMAKU === 1) {
    void sendDanmaku(event.messages).catch(error => {
      dashboard.addError('brain', error);
    });
  }
});

brain.onError(error => {
  dashboard.addError('brain', error);
});

blive.onClose((code, signal) => {
  if (!stopping) {
    dashboard.addError('room', `FFmpeg 意外关闭（code=${String(code)}, signal=${String(signal)}）`);
  }
});

process.once('SIGINT', stop);

if (stopAfterMs > 0) {
  setTimeout(stop, stopAfterMs);
}

await blive.start();

async function stop() {
  if (stopping) {
    return;
  }

  stopping = true;
  stopDanmakuSender();
  dashboard.unmount();
  await vision.stop();
  await hearing.stop();
  blive.stop();
  await brain.idle();
}
