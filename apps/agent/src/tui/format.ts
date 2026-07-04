export function formatTime(timeMs: number) {
  return new Date(timeMs).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatTimeRange(startTimeMs: number, endTimeMs: number) {
  return `${formatTime(startTimeMs)} - ${formatTime(endTimeMs)}`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) {
    return `${kibibytes.toFixed(1)} KiB`;
  }

  return `${(kibibytes / 1024).toFixed(1)} MiB`;
}
