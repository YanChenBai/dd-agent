import { createListener } from '@viyuni/bevent-relay';
import PQueue from 'p-queue';

import { env } from '../env.ts';

const listener = createListener({
  roomId: env.LIVE_ROOM_ID,
  cookieSync: {
    url: env.LOGIN_SYNC_URL,
    password: env.LOGIN_SYNC_PASSWORD,
  },
});
const SEND_INTERVAL_MS = 5_000;
const sendQueue = new PQueue({
  concurrency: 1,
  interval: SEND_INTERVAL_MS,
  intervalCap: 1,
});

export function sendDanmaku(messages: readonly string[]) {
  return Promise.all(messages.map(message => sendQueue.add(() => listener.sendDanmu(message))));
}

export function stopDanmakuSender() {
  sendQueue.pause();
  sendQueue.clear();
  listener.stop();
}
