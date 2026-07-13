export const MAX_ROOM_OBSERVE_MS = 60 * 60 * 1_000;
export const MIN_ROOM_OBSERVE_MS = 60 * 1_000;
export const WATCH_CHECKPOINT_MS = 60 * 1_000;

export function assertCanContinue(startedAt: number, maxRunMs: number) {
  if (remainingMs(startedAt, maxRunMs) <= 0) {
    throw new Error('Explore reached max run time');
  }
}

export function remainingMs(startedAt: number, maxRunMs: number) {
  return Math.max(0, startedAt + maxRunMs - Date.now());
}

export function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) {
    return `${seconds} 秒`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes} 分钟` : `${minutes} 分钟 ${remainingSeconds} 秒`;
}
