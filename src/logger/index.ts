import { styleText } from 'node:util';

import type { RoomUserInfo } from '../bili-api/types.ts';
import type { DanmakuEvent } from '../brain/types.ts';
import type { HearingFinalEvent } from '../hearing/types.ts';
import type { VisionImageEvent } from '../vision/types.ts';
import { formatBytes, formatTimeRange } from './format.ts';

export type LoggerModule = 'brain' | 'ffmpeg' | 'hearing' | 'room' | 'vision';
export type DanmakuDelivery = 'preview' | 'pending' | 'sent' | 'failed';
type TextStyle = Parameters<typeof styleText>[0];

export interface LoggerOptions {
  sendDanmakuEnabled?: boolean;
}

export interface LoggerDanmakuEntry {
  id: number;
  message: string;
}

const MODULE_COLORS = {
  brain: 'green',
  ffmpeg: 'yellow',
  hearing: 'cyan',
  room: 'blue',
  vision: 'magenta',
} as const satisfies Record<LoggerModule, TextStyle>;

const DELIVERY_TEXT = {
  failed: styleText('red', '发送失败'),
  pending: styleText('yellow', '等待发送'),
  preview: styleText('dim', '仅预览'),
  sent: styleText('green', '已发送'),
} as const satisfies Record<DanmakuDelivery, string>;

let nextId = 0;

export function createLogger(roomInfo: RoomUserInfo, options: LoggerOptions = {}) {
  const state = {
    sendDanmakuEnabled: options.sendDanmakuEnabled ?? false,
  };

  return {
    state,
    mount() {
      log(
        'room',
        `直播间 ${roomInfo.room.room_id} 已连接，弹幕发送：${state.sendDanmakuEnabled ? '开启' : '关闭'}`,
      );
    },
    unmount() {
      log('room', '正在关闭');
    },
    danmaku(event: DanmakuEvent, willSend: boolean) {
      const entries: LoggerDanmakuEntry[] = [];
      for (const message of event.messages) {
        const entry = { id: nextId++, message };
        entries.push(entry);
        log(
          'brain',
          `${formatRange(event.startTimeMs, event.endTimeMs)} ${DELIVERY_TEXT[willSend ? 'pending' : 'preview']} ${message}`,
        );
      }
      return entries;
    },
    danmakuDelivery(entries: readonly LoggerDanmakuEntry[], delivery: DanmakuDelivery) {
      for (const entry of entries) {
        log('brain', `${DELIVERY_TEXT[delivery]} ${entry.message}`);
      }
    },
    hearing(event: HearingFinalEvent) {
      log(
        'hearing',
        `#${event.index} ${formatRange(event.startTimeMs, event.endTimeMs)} ${event.text}`,
      );
    },
    vision(event: VisionImageEvent) {
      log(
        'vision',
        `${formatRange(event.startTimeMs, event.endTimeMs)} ${event.frames.length} 帧，${formatBytes(event.buffer.byteLength)}`,
      );
    },
    ffmpeg(message: string) {
      log('ffmpeg', message);
    },
    error(module: LoggerModule, error: unknown) {
      log(module, toErrorMessage(error), 'red');
    },
  };
}

function log(module: LoggerModule, message: string, color: TextStyle = MODULE_COLORS[module]) {
  console.log(`${styleText(color, `[${module}]`)} ${message}`);
}

function formatRange(startTimeMs: number, endTimeMs: number) {
  return styleText('dim', formatTimeRange(startTimeMs, endTimeMs));
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type Logger = ReturnType<typeof createLogger>;
