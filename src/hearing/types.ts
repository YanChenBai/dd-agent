export interface HearingFinalEvent {
  index: number;
  text: string;
  startTimeMs: number;
  endTimeMs: number;
  mediaStartMs: number;
  mediaEndMs: number;
}

export interface HearingStats {
  queuedSegments: number;
  queuedAudioSeconds: number;
  activeAudioSeconds: number;
  decodedSegments: number;
  emptySegments: number;
  droppedSegments: number;
  failedSegments: number;
  lastDecodeMs?: number;
  lastRealTimeFactor?: number;
}

export interface HearingEvents {
  final: (event: HearingFinalEvent) => void;
  error: (error: Error) => void;
}
