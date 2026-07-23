// @env node

import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from 'c12';

export {
  ddConfigSchema,
  defineConfig,
  parseDDConfig,
  type DDConfig,
  type DDConfigInput,
} from './define.ts';

import { parseDDConfig, type DDConfig } from './define.ts';

export function createDefaultConfig(appDir = process.cwd()): DDConfig {
  const rootDir = resolve(appDir);
  const modelsDir = resolve(rootDir, 'models');
  const senseVoiceDir = resolve(
    modelsDir,
    'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
  );

  return {
    agent: {
      name: 'DD',
      stopAfterMs: 0,
      danmakuIntervalMs: 30_000,
      danmakuHistoryTurns: 12,
    },
    live: {
      roomId: 82_568,
      sendDanmaku: false,
      streamerAliases: [],
      browserUserDataDir: resolve(rootDir, '.browser-user-data'),
      loginTimeoutMs: 5 * 60 * 1_000,
    },
    ai: {
      model: 'google/gemma-4-26b-a4b-it:free',
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api/v1',
      supportsStructuredOutputs: true,
      requestTimeoutMs: 60_000,
    },
    memory: {
      retentionMs: 30 * 60 * 1_000,
      visionDir: resolve(rootDir, '.dd-memory', 'vision'),
      brainContextWindowMs: 10 * 60 * 1_000,
      brainContextImages: 6,
    },
    asr: {
      sampleRate: 16_000,
      maxPendingSeconds: 30,
      provider: 'cpu',
      numThreads: 2,
      vadNumThreads: 1,
      debug: false,
      senseVoiceModel: resolve(senseVoiceDir, 'model.int8.onnx'),
      tokens: resolve(senseVoiceDir, 'tokens.txt'),
      featureDim: 80,
      useItn: true,
      vad: {
        kind: 'silero',
        model: resolve(modelsDir, 'silero_vad.onnx'),
        threshold: 0.5,
        minSpeechSeconds: 0.25,
        minSilenceSeconds: 0.5,
        windowSize: 512,
      },
    },
    explore: {
      areaUrl: 'https://live.bilibili.com/p/eden/area-tags?parentAreaId=9&areaId=0',
      maxRunMs: 60 * 60 * 1_000,
      observeRoomMs: 60 * 60 * 1_000,
      candidateLimit: 24,
    },
  };
}

let configPromise: Promise<DDConfig> | undefined;

export function loadDDConfig(): Promise<DDConfig> {
  const cwd = resolve(process.cwd());
  configPromise ??= loadConfig<DDConfig>({
    name: 'dd',
    cwd,
    configFile: 'dd.config',
    configFileRequired: true,
    defaults: createDefaultConfig(cwd),
    dotenv: false,
  }).then(result => validateRuntimeConfig(parseDDConfig(result.config)));

  return configPromise;
}

function validateRuntimeConfig(config: DDConfig): DDConfig {
  const requiredFiles = [config.asr.senseVoiceModel, config.asr.tokens, config.asr.vad.model];
  for (const filePath of requiredFiles) {
    try {
      if (!statSync(filePath).isFile()) {
        throw new Error('not a file');
      }
    } catch {
      throw new Error(`Required model file was not found: ${filePath}`);
    }
  }
  return config;
}
