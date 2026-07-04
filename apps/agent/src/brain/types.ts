import type { RoomUserInfo } from '../bili-api/types.ts';
import type { TimeRange } from '../memory/types.ts';

export interface DanmakuEvent extends TimeRange {
  messages: string[];
}

export interface BrainEvents {
  danmaku: (event: DanmakuEvent) => void;
  error: (error: Error) => void;
}

export interface BrainContext {
  roomInfo: RoomUserInfo;
  streamerAliases: readonly string[];
}
