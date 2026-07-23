import type { createHand } from './index.ts';

export type HandStatus =
  | 'idle'
  | 'starting'
  | 'login-required'
  | 'authenticated'
  | 'ready'
  | 'failed'
  | 'stopping'
  | 'stopped';

export interface HandStatusEvent {
  status: HandStatus;
  message: string;
}

export interface HandEvents {
  status: (event: HandStatusEvent) => void;
  error: (error: Error) => void;
}

export type Hand = ReturnType<typeof createHand>;
