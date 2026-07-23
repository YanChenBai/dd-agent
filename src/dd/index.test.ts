import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => {
  const callbacks: {
    bliveClose?: (code: number | null, signal: NodeJS.Signals | null) => void;
    bliveError?: (error: Error) => void;
    hearingError?: (error: Error) => void;
  } = {};
  const config = {
    agent: {
      name: 'DD',
      stopAfterMs: 0,
      danmakuIntervalMs: 30_000,
      danmakuHistoryTurns: 12,
    },
    live: {
      roomId: 1,
      sendDanmaku: false,
      streamerAliases: [],
      browserUserDataDir: '.browser-user-data',
      loginTimeoutMs: 1_000,
    },
    ai: {
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      supportsStructuredOutputs: true,
      requestTimeoutMs: 1_000,
    },
    memory: {
      retentionMs: 60_000,
      visionDir: '.dd-memory/vision',
      brainContextWindowMs: 30_000,
      brainContextImages: 1,
    },
    asr: {
      sampleRate: 16_000,
      maxPendingSeconds: 30,
      provider: 'cpu',
      numThreads: 1,
      vadNumThreads: 1,
      debug: false,
      senseVoiceModel: 'model.onnx',
      tokens: 'tokens.txt',
      featureDim: 80,
      useItn: true,
      vad: {
        kind: 'silero' as const,
        model: 'vad.onnx',
        threshold: 0.5,
        minSpeechSeconds: 0.25,
        minSilenceSeconds: 0.5,
        windowSize: 512,
      },
    },
    explore: {
      areaUrl: 'https://example.test/area',
      maxRunMs: 60_000,
      observeRoomMs: 60_000,
      candidateLimit: 1,
    },
  };
  return {
    callbacks,
    config,
    bliveStart: vi.fn(async () => undefined),
    bliveStop: vi.fn(async () => true),
    brainIdle: vi.fn(async () => undefined),
    brainStart: vi.fn(),
    brainStop: vi.fn(),
    hearingStop: vi.fn(async () => undefined),
    memoryClear: vi.fn(),
    handStart: vi.fn(async () => undefined),
    handStop: vi.fn(async () => undefined),
    visionStop: vi.fn(async () => undefined),
  };
});

vi.mock('../bili-api/index.ts', () => ({
  fetchRoomUserInfo: vi.fn(async () => ({
    room: { room_id: 1, live_status: 1 },
    user: {},
  })),
}));

vi.mock('../config/index.ts', () => ({
  loadDDConfig: vi.fn(async () => mocks.config),
}));

vi.mock('../blive/index.ts', () => ({
  createBlive: () => ({
    start: mocks.bliveStart,
    stop: mocks.bliveStop,
    onAudio: () => vi.fn(),
    onImage: () => vi.fn(),
    onError: (callback: (error: Error) => void) => {
      mocks.callbacks.bliveError = callback;
      return vi.fn();
    },
    onClose: (callback: (code: number | null, signal: NodeJS.Signals | null) => void) => {
      mocks.callbacks.bliveClose = callback;
      return vi.fn();
    },
  }),
}));

vi.mock('../hearing/index.ts', () => ({
  startHearing: () => ({
    onFinal: () => vi.fn(),
    onError: (callback: (error: Error) => void) => {
      mocks.callbacks.hearingError = callback;
      return vi.fn();
    },
    stop: mocks.hearingStop,
  }),
}));

vi.mock('../vision/index.ts', () => ({
  startVision: () => ({
    onImage: () => vi.fn(),
    stop: mocks.visionStop,
  }),
}));

vi.mock('../memory/index.ts', () => ({
  createMemory: () => ({
    addHearing: vi.fn(),
    addVision: vi.fn(),
    clear: mocks.memoryClear,
  }),
}));

vi.mock('../hand/index.ts', () => ({
  createHand: () => ({
    getStatus: () => 'ready',
    start: mocks.handStart,
    stop: mocks.handStop,
    sendDanmaku: vi.fn(async () => undefined),
  }),
}));

vi.mock('../brain/index.ts', () => ({
  createBrain: () => ({
    onDanmaku: () => vi.fn(),
    start: mocks.brainStart,
    stop: mocks.brainStop,
    idle: mocks.brainIdle,
  }),
}));

vi.mock('../logger/index.ts', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    start: vi.fn(),
  }),
}));

import { createDD } from './index.ts';

describe('createDD lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callbacks.bliveClose = undefined;
    mocks.callbacks.bliveError = undefined;
    mocks.callbacks.hearingError = undefined;
  });

  it('gracefully stops all resources when aborted', async () => {
    const controller = new AbortController();
    const dd = await createDD(1, { signal: controller.signal });

    controller.abort();
    await expect(dd.waitForStop()).resolves.toBeUndefined();

    expect(mocks.brainStop).toHaveBeenCalledOnce();
    expect(mocks.bliveStop).toHaveBeenCalledOnce();
    expect(mocks.hearingStop).toHaveBeenCalledOnce();
    expect(mocks.visionStop).toHaveBeenCalledOnce();
    expect(mocks.handStop).toHaveBeenCalledOnce();
    expect(mocks.memoryClear).toHaveBeenCalledOnce();
  });

  it('surfaces an unexpected FFmpeg close after cleanup', async () => {
    const dd = await createDD(1);

    mocks.callbacks.bliveClose?.(1, null);

    await expect(dd.waitForStop()).rejects.toThrow(/unexpected close/);
    expect(mocks.bliveStop).toHaveBeenCalledOnce();
    expect(mocks.memoryClear).toHaveBeenCalledOnce();
  });
});
