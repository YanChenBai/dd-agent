import type { RoomUserInfo } from '../../bili-api/types.ts';
import type { BrainDecision } from '../../brain/types.ts';

export interface LiveRoomCandidate {
  roomId: number;
  title: string;
  anchor: string;
  area?: string;
  watched?: number;
}

export interface LiveAreaBatch {
  batch: number;
  candidates: LiveRoomCandidate[];
}

export interface WatchedRoomSummary {
  roomInfo: RoomUserInfo;
  watchedMs: number;
  startedAt: number;
  endedAt: number;
  canContinue?: boolean;
  context?: RoomContext;
  decision?: BrainDecision;
}

export interface RoomContext {
  hearing: string[];
  visionFrames: number;
}

export interface ExploreOptions {
  areaUrl?: string;
  maxRunMs?: number;
  observeRoomMs?: number;
  candidateLimit?: number;
  sendDanmakuEnabled?: boolean;
}
