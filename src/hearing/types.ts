export interface HearingFinalEvent {
  index: number;
  text: string;
  startTimeMs: number;
  endTimeMs: number;
  mediaStartMs: number;
  mediaEndMs: number;
}

export interface HearingEvents {
  final: (event: HearingFinalEvent) => void;
  error: (error: Error) => void;
}
