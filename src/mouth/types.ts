import type { createMouth } from './index.ts';

export type MouthStatus =
  | 'idle'
  | 'starting'
  | 'login-required'
  | 'authenticated'
  | 'ready'
  | 'failed'
  | 'stopping'
  | 'stopped';

export interface MouthStatusEvent {
  status: MouthStatus;
  message: string;
}

export interface MouthEvents {
  status: (event: MouthStatusEvent) => void;
  error: (error: Error) => void;
}

export type Mouth = ReturnType<typeof createMouth>;
