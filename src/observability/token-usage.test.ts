import { describe, expect, it } from 'vite-plus/test';

import {
  addFailedTokenRequest,
  addTokenUsage,
  createTokenUsageReport,
  formatTokenUsageReport,
  mergeTokenUsage,
  snapshotTokenUsage,
} from './token-usage.ts';

describe('token usage reporting', () => {
  it('counts successful and failed requests and sums provider usage', () => {
    const report = createTokenUsageReport();

    addTokenUsage(report, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    addTokenUsage(report, { inputTokens: 3, outputTokens: 2 });
    addTokenUsage(report);
    addFailedTokenRequest(report);

    expect(report).toEqual({
      requests: 3,
      failedRequests: 1,
      inputTokens: 13,
      outputTokens: 6,
      totalTokens: 19,
    });
    expect(formatTokenUsageReport(report)).toContain('total 19 tokens');
  });

  it('merges reports and returns defensive snapshots', () => {
    const total = createTokenUsageReport();
    const source = createTokenUsageReport();
    addTokenUsage(source, { inputTokens: 8, outputTokens: 2, totalTokens: 10 });
    addFailedTokenRequest(source);

    mergeTokenUsage(total, source);
    const snapshot = snapshotTokenUsage(total);
    source.totalTokens = 999;

    expect(snapshot).toEqual({
      requests: 1,
      failedRequests: 1,
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
    });
  });
});
