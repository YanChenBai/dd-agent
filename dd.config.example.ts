import { defineConfig } from './src/config/index.ts';

export default defineConfig({
  agent: {
    shutdownTimeoutMs: 15_000,
  },
  ai: {
    model: 'google/gemma-4-26b-a4b-it:free',
    apiKey: 'replace-with-your-api-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    supportsStructuredOutputs: true,
  },
  live: {
    roomId: 82_568,
    sendDanmaku: false,
    apiRequestTimeoutMs: 10_000,
    apiRetryLimit: 2,
    apiRetryBackoffMs: 300,
    ffmpegMaxRestarts: 2,
    ffmpegRestartBackoffMs: 1_000,
    ffmpegStopTimeoutMs: 5_000,
  },
});
