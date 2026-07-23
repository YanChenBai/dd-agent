export interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface TokenUsageReport {
  requests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function createTokenUsageReport(): TokenUsageReport {
  return {
    requests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

export function addTokenUsage(report: TokenUsageReport, usage?: TokenUsageLike): TokenUsageReport {
  report.requests += 1;
  if (!usage) {
    return report;
  }

  const inputTokens = normalizeTokens(usage.inputTokens);
  const outputTokens = normalizeTokens(usage.outputTokens);
  report.inputTokens += inputTokens;
  report.outputTokens += outputTokens;
  report.totalTokens += normalizeTokens(usage.totalTokens ?? inputTokens + outputTokens);
  return report;
}

export function addFailedTokenRequest(report: TokenUsageReport): TokenUsageReport {
  report.failedRequests += 1;
  return report;
}

export function mergeTokenUsage(
  report: TokenUsageReport,
  source?: TokenUsageReport,
): TokenUsageReport {
  if (!source) {
    return report;
  }

  report.requests += source.requests;
  report.failedRequests += source.failedRequests;
  report.inputTokens += source.inputTokens;
  report.outputTokens += source.outputTokens;
  report.totalTokens += source.totalTokens;
  return report;
}

export function snapshotTokenUsage(report: TokenUsageReport): TokenUsageReport {
  return { ...report };
}

export function formatTokenUsageReport(report: TokenUsageReport): string {
  return `请求 ${report.requests} 次，失败 ${report.failedRequests} 次，input ${report.inputTokens}，output ${report.outputTokens}，total ${report.totalTokens} tokens`;
}

function normalizeTokens(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
