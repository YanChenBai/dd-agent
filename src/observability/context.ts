import type { DDMode } from '@/types/index.ts';

export interface RunContext {
  mode: DDMode;
}

export interface RoomContext extends RunContext {
  roomId: number;
}

export interface ObservabilityContext extends RunContext {
  component: string;
  roomId?: number;
}

export function createRunContext(mode: DDMode): RunContext {
  return { mode };
}

export function createRoomContext(run: RunContext, roomId: number): RoomContext {
  return { ...run, roomId };
}

export function withComponent(
  context: RunContext | RoomContext,
  component: string,
): ObservabilityContext {
  return { ...context, component };
}
