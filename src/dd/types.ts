import type { CleanupResult } from '@/observability/cleanup.ts';
import type { TokenUsageReport } from '@/observability/token-usage.ts';

export type DDStatus = 'starting' | 'running' | 'stopping' | 'stopped';

export type DDComponent = 'FFmpeg' | 'Hearing' | 'Vision' | 'Brain' | 'Hand' | 'Startup';
export type DDComponentErrorSeverity = 'fatal' | 'degraded' | 'recoverable';

export class DDComponentError extends Error {
  readonly component: DDComponent;
  readonly severity: DDComponentErrorSeverity;

  constructor(component: DDComponent, severity: DDComponentErrorSeverity, cause: Error) {
    super(`${component} ${severity}: ${cause.message}`, { cause });
    this.name = 'DDComponentError';
    this.component = component;
    this.severity = severity;
  }
}

export type DDStopReason =
  | 'live-ended'
  | 'manual-stop'
  | 'signal'
  | 'timeout'
  | 'component-failure';

export interface DDStopResult {
  reason: DDStopReason;
  roomId: number;
  startedAt: number;
  endedAt: number;
  tokenUsage: TokenUsageReport;
  cleanup: CleanupResult[];

  error?: Error;
}
