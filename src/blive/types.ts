import type { createBlive } from './index.ts';

export interface BliveEvents {
  audio: (buffer: Buffer, timing: MediaTiming) => void;
  image: (buffer: Buffer, timing: MediaTiming) => void;
  error: (error: Error) => void;
  close: (code: number | null, signal: NodeJS.Signals | null) => void;
  stderr: (message: string) => void;
}

export interface BliveHealth {
  startedAtMs?: number;
  lastAudioAtMs?: number;
  lastImageAtMs?: number;
  lastMediaAtMs?: number;
  audioBytes: number;
  audioChunks: number;
  imageFrames: number;
  flvRefreshes: number;
  processStarts: number;
  lastStartDurationMs?: number;
  lastRunDurationMs?: number;
  lastExitCode?: number | null;
  lastExitSignal?: NodeJS.Signals | null;
  sigtermTimeouts: number;
  sigkillCount: number;
}

export interface MediaTiming {
  /** Wall-clock time when this media unit became available to Node. */
  receivedAtMs: number;
  /** Start position on the media timeline, relative to this FFmpeg session. */
  mediaStartMs: number;
  /** End position on the media timeline, relative to this FFmpeg session. */
  mediaEndMs: number;
}

export type Blive = ReturnType<typeof createBlive>;
