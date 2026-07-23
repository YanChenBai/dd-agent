import { defineConfig } from './src/config/index.ts';

export default defineConfig({
  ai: {
    model: 'google/gemma-4-26b-a4b-it:free',
    apiKey: 'replace-with-your-api-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    supportsStructuredOutputs: true,
  },
  live: {
    roomId: 82_568,
    sendDanmaku: false,
  },
});
