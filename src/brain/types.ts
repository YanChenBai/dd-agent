import type { RoomUserInfo } from '../bili-api/types.ts';
import type { TimeRange } from '../memory/types.ts';

export interface DanmakuEvent extends TimeRange {
  messages: string[];
}

export interface SingleModeOutput {
  danmakus: string[];
}

export interface ExploreModeOutput extends SingleModeOutput {
  shouldContinue: boolean;
  watchDeltaMs: number;
  reason: string;
}

export type BrainOutput = SingleModeOutput | ExploreModeOutput;

export interface BrainDecision extends TimeRange {
  watchDeltaMs: number;
  shouldContinue: boolean;
  reason: string;
}

export interface ContinueWatchingEvent extends TimeRange {
  watchDeltaMs: number;
  reason: string;
}

export interface SwitchRoomEvent extends TimeRange {
  reason: string;
}

export type BrainResultEvent = TimeRange & BrainOutput;

export interface BrainEvents {
  danmaku: (event: DanmakuEvent) => void;
  decision: (event: BrainDecision) => void;
  continueWatching: (event: ContinueWatchingEvent) => void;
  switchRoom: (event: SwitchRoomEvent) => void;
  result: (event: BrainResultEvent) => void;
  error: (error: Error) => void;
}

export interface BrainContext {
  roomInfo: RoomUserInfo;
  streamerAliases: readonly string[];
}
