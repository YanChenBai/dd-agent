import type { RoomUserInfo } from '../bili-api/types.ts';

export type DashboardModule = 'brain' | 'hearing' | 'vision' | 'room';

export interface TimedDashboardEntry {
  id: number;
  startTimeMs: number;
  endTimeMs: number;
}

export interface BrainDashboardEntry extends TimedDashboardEntry {
  delivery: DanmakuDelivery;
  message: string;
}

export type DanmakuDelivery = 'preview' | 'pending' | 'sent' | 'failed';

export interface HearingDashboardEntry extends TimedDashboardEntry {
  index: number;
  text: string;
}

export interface VisionDashboardEntry extends TimedDashboardEntry {
  bufferSize: number;
  frameCount: number;
}

export interface DashboardError {
  id: number;
  module: DashboardModule;
  message: string;
  timeMs: number;
}

export interface DashboardState {
  roomInfo: RoomUserInfo;
  startedAtMs: number;
  brain: BrainDashboardEntry[];
  hearing: HearingDashboardEntry[];
  vision: VisionDashboardEntry[];
  errors: DashboardError[];
}
