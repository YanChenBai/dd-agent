import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import nodeProcess from 'node:process';
import { fileURLToPath } from 'node:url';

import { createEnv } from '@t3-oss/env-core';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = resolve(appDir, 'models');
const senseVoiceDir = resolve(modelsDir, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09');

const positiveInteger = z.coerce.number().int().positive();
const binaryNumber = z.enum(['0', '1']).transform(value => Number(value) as 0 | 1);
const stringList = z.string().transform(value =>
  value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean),
);
const existingFile = z.string().superRefine((path, context) => {
  if (!existsSync(path)) {
    context.addIssue({
      code: 'custom',
      message: `File does not exist: ${path}`,
    });
  }
});

export const env = createEnv({
  server: {
    // Runtime
    AGENT_NAME: z.string().trim().min(1).max(20).default('DD'),
    AGENT_STOP_AFTER_MS: z.coerce.number().nonnegative().default(0),
    LIVE_ROOM_ID: positiveInteger.default(82_568),
    SEND_DANMAKU: binaryNumber.default(0),

    // OpenAI-compatible AI provider
    AI_MODEL: z.string(),
    AI_API_KEY: z.string(),
    AI_BASE_URL: z.url(),
    MEMORY_RETENTION_MS: positiveInteger.default(10 * 60 * 1_000),
    BRAIN_CONTEXT_WINDOW_MS: positiveInteger.default(2 * 60 * 1_000),

    // Live context
    LIVE_STREAMER_ALIASES: stringList.default([]),

    // Local ASR / VAD
    SAMPLE_RATE: positiveInteger.default(16_000),
    MAX_PENDING_SECONDS: z.coerce.number().positive().default(30),
    PROVIDER: z.string().default('cpu'),
    NUM_THREADS: positiveInteger.default(2),
    VAD_NUM_THREADS: positiveInteger.default(1),
    DEBUG: binaryNumber.default(0),
    SENSEVOICE_MODEL: existingFile.default(resolve(senseVoiceDir, 'model.int8.onnx')),
    TOKENS: existingFile.default(resolve(senseVoiceDir, 'tokens.txt')),
    FEATURE_DIM: positiveInteger.default(80),
    USE_ITN: binaryNumber.default(1),
    VAD_KIND: z.enum(['silero', 'ten']).default('silero'),
    VAD_MODEL: existingFile.default(
      resolve(modelsDir, process.env.VAD_KIND === 'ten' ? 'ten-vad.onnx' : 'silero_vad.onnx'),
    ),
    VAD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
    VAD_MIN_SPEECH: z.coerce.number().nonnegative().default(0.25),
    VAD_MIN_SILENCE: z.coerce.number().nonnegative().default(0.5),
    VAD_WINDOW_SIZE: positiveInteger.default(process.env.VAD_KIND === 'ten' ? 256 : 512),

    // Bilibili login synchronization
    LOGIN_SYNC_URL: z.string(),
    LOGIN_SYNC_PASSWORD: z.string(),
  },
  runtimeEnv: nodeProcess.env,
  emptyStringAsUndefined: true,
});
