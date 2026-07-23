import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { parseDDConfig } from './define.ts';
import { createDefaultConfig } from './index.ts';

describe('DD config', () => {
  it('resolves runtime paths from the explicit application root', () => {
    const root = resolve('test-project-root');
    const config = createDefaultConfig(root);

    expect(config.live.browserUserDataDir).toBe(resolve(root, '.browser-user-data'));
    expect(config.memory.visionDir).toBe(resolve(root, '.dd-memory', 'vision'));
    expect(config.asr.senseVoiceModel).toBe(
      resolve(
        root,
        'models',
        'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
        'model.int8.onnx',
      ),
    );
  });

  it('accepts a complete valid config', () => {
    const config = createDefaultConfig();
    config.ai.apiKey = 'test-key';

    expect(parseDDConfig(config)).toEqual(config);
  });

  it('rejects invalid intervals and context windows', () => {
    const invalidInterval = createDefaultConfig();
    invalidInterval.ai.apiKey = 'test-key';
    invalidInterval.agent.danmakuIntervalMs = 0;

    expect(() => parseDDConfig(invalidInterval)).toThrow();

    const invalidWindow = createDefaultConfig();
    invalidWindow.ai.apiKey = 'test-key';
    invalidWindow.memory.brainContextWindowMs = invalidWindow.memory.retentionMs + 1;

    expect(() => parseDDConfig(invalidWindow)).toThrow(/brainContextWindowMs/);
  });
});
