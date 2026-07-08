import type { MediaTiming } from '../blive/types.ts';

export interface VisionEvents {
  image: (event: VisionImageEvent) => void;
  error: (error: Error) => void;
}

export interface VisionFrame extends MediaTiming {
  buffer: Buffer;
}

export interface VisionImageEvent {
  buffer: Buffer;
  frames: readonly VisionFrame[];
  startTimeMs: number;
  endTimeMs: number;
  mediaStartMs: number;
  mediaEndMs: number;
}

export interface VisionOptions {
  intervalMs?: number;
}
