import type { RoomUserInfo } from '../../bili-api/types.ts';
import type { BrainDecision } from '../../brain/types.ts';
import type { RunContext } from '../../observability/context.ts';
import type { DDStopReason } from '../types.ts';

export interface LiveRoomCandidate {
  roomId: number;
  title: string;
  anchor: string;
  area?: string;
  watched?: number;
  unavailable?: boolean;
}

export interface LiveAreaBatch {
  batch: number;
  candidates: LiveRoomCandidate[];
}

export interface ExploreDecision {
  continue: boolean;
  roomId: number | null;
  reason: string;
}

export type WatchedRoomEndReason = DDStopReason | 'checkpoint' | 'brain-switch';

export interface WatchedRoomSummary {
  roomInfo: RoomUserInfo;
  watchedMs: number;
  startedAt: number;
  endedAt: number;
  endReason: WatchedRoomEndReason;
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
  signal?: AbortSignal;
  runContext?: RunContext;
}
