import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => {
  const callbacks: {
    bliveClose?: (code: number | null, signal: NodeJS.Signals | null) => void;
    bliveError?: (error: Error) => void;
    brainError?: (error: Error) => void;
    handError?: (error: Error) => void;
    hearingError?: (error: Error) => void;
    visionError?: (error: Error) => void;
  } = {};
  const config = {
    agent: {
      name: 'DD',
      stopAfterMs: 0,
      danmakuIntervalMs: 30_000,
      danmakuHistoryTurns: 12,
      shutdownTimeoutMs: 15_000,
    },
    live: {
      roomId: 1,
      sendDanmaku: false,
      streamerAliases: [],
      browserUserDataDir: '.browser-user-data',
      loginTimeoutMs: 1_000,
      statusPollIntervalMs: 30_000,
      mediaStallTimeoutMs: 45_000,
      apiRequestTimeoutMs: 10_000,
      apiRetryLimit: 2,
      apiRetryBackoffMs: 300,
      ffmpegMaxRestarts: 2,
      ffmpegRestartBackoffMs: 100,
      ffmpegStopTimeoutMs: 5_000,
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
    isRoomLive: vi.fn(),
    fetchRoomUserInfo: vi.fn(),
    getBliveHealth: vi.fn(),
    bliveIsRunning: vi.fn(),
    getHearingStats: vi.fn(),
    getHandStats: vi.fn(),
    bliveStart: vi.fn(async () => undefined),
    bliveStop: vi.fn(async () => true),
    brainIdle: vi.fn(async () => undefined),
    brainStart: vi.fn(),
    brainStop: vi.fn(),
    brainTokenUsage: {
      requests: 2,
      failedRequests: 1,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    },
    hearingStop: vi.fn(async () => undefined),
    memoryClear: vi.fn(),
    loggerInfo: vi.fn(),
    loggerSuccess: vi.fn(),
    loggerWarn: vi.fn(),
    handStart: vi.fn(async () => undefined),
    handStop: vi.fn(async () => undefined),
    visionStop: vi.fn(async () => undefined),
  };
});

vi.mock('../bili-api/index.ts', async importOriginal => ({
  ...(await importOriginal()),
  fetchRoomUserInfo: mocks.fetchRoomUserInfo,
  isRoomLive: mocks.isRoomLive,
}));

vi.mock('../config/index.ts', () => ({
  loadDDConfig: vi.fn(async () => mocks.config),
}));

vi.mock('../blive/index.ts', () => ({
  createBlive: () => ({
    getHealth: mocks.getBliveHealth,
    isRunning: mocks.bliveIsRunning,
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
    getStats: mocks.getHearingStats,
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
    onError: (callback: (error: Error) => void) => {
      mocks.callbacks.visionError = callback;
      return vi.fn();
    },
    stop: mocks.visionStop,
  }),
}));

vi.mock('../memory/index.ts', () => ({
  createMemory: () => ({
    addHearing: vi.fn(),
    addVision: vi.fn(),
    clear: mocks.memoryClear,
    getSize: () => 0,
  }),
}));

vi.mock('../hand/index.ts', () => ({
  createHand: () => ({
    getStatus: () => 'ready',
    getStats: mocks.getHandStats,
    start: mocks.handStart,
    stop: mocks.handStop,
    sendDanmaku: vi.fn(async () => undefined),
    onError: (callback: (error: Error) => void) => {
      mocks.callbacks.handError = callback;
      return vi.fn();
    },
  }),
}));

vi.mock('../brain/index.ts', () => ({
  createBrain: () => ({
    onDanmaku: () => vi.fn(),
    onError: (callback: (error: Error) => void) => {
      mocks.callbacks.brainError = callback;
      return vi.fn();
    },
    start: mocks.brainStart,
    stop: mocks.brainStop,
    idle: mocks.brainIdle,
    getTokenUsage: () => ({ ...mocks.brainTokenUsage }),
  }),
}));

vi.mock('../logger/index.ts', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: mocks.loggerInfo,
    success: mocks.loggerSuccess,
    start: vi.fn(),
    warn: mocks.loggerWarn,
  }),
}));

import { createDD } from './index.ts';

describe('createDD lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mocks.callbacks) as Array<keyof typeof mocks.callbacks>) {
      delete mocks.callbacks[key];
    }
    mocks.isRoomLive.mockResolvedValue(true);
    mocks.bliveIsRunning.mockReturnValue(true);
    mocks.getHearingStats.mockReturnValue({
      queuedSegments: 0,
      queuedAudioSeconds: 0,
      activeAudioSeconds: 0,
      decodedSegments: 0,
      emptySegments: 0,
      droppedSegments: 0,
      failedSegments: 0,
    });
    mocks.getHandStats.mockReturnValue({
      queuedMessages: 0,
      activeMessages: 0,
      attemptedMessages: 0,
      sentMessages: 0,
      failedMessages: 0,
    });
    mocks.getBliveHealth.mockReturnValue({
      startedAtMs: Date.now(),
      lastMediaAtMs: Date.now(),
      audioBytes: 0,
      audioChunks: 0,
      imageFrames: 0,
    });
    mocks.fetchRoomUserInfo.mockResolvedValue({
      room: { room_id: 1, live_status: 1 },
      user: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gracefully stops all resources when aborted', async () => {
    const controller = new AbortController();
    const dd = await createDD(1, { signal: controller.signal });

    controller.abort();
    await expect(dd.waitForStop()).resolves.toMatchObject({
      reason: 'signal',
      roomId: 1,
    });

    expect(dd.getStatus()).toBe('stopped');
    expect(mocks.brainStop).toHaveBeenCalledOnce();
    expect(mocks.bliveStop).toHaveBeenCalledOnce();
    expect(mocks.hearingStop).toHaveBeenCalledOnce();
    expect(mocks.visionStop).toHaveBeenCalledOnce();
    expect(mocks.handStop).toHaveBeenCalledOnce();
    expect(mocks.memoryClear).toHaveBeenCalledOnce();
  });

  it('distinguishes a room that is not live from API failures', async () => {
    mocks.fetchRoomUserInfo.mockResolvedValueOnce({
      room: { room_id: 1, live_status: 0 },
      user: {},
    });

    await expect(createDD(1)).rejects.toMatchObject({
      name: 'RoomNotLiveError',
      roomId: 1,
    });
  });

  it('classifies recoverable and degraded component errors without stopping', async () => {
    const dd = await createDD(1);

    mocks.callbacks.visionError?.(new Error('compose failed'));
    mocks.callbacks.brainError?.(new Error('model unavailable'));
    mocks.callbacks.handError?.(new Error('browser unavailable'));

    expect(dd.getStatus()).toBe('running');
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Vision 组件错误：severity=recoverable',
      expect.objectContaining({ component: 'Vision', severity: 'recoverable' }),
    );
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Brain 组件错误：severity=recoverable',
      expect.objectContaining({ component: 'Brain', severity: 'recoverable' }),
    );
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Hand 组件错误：severity=degraded',
      expect.objectContaining({ component: 'Hand', severity: 'degraded' }),
    );
    await dd.stop();
  });

  it('classifies a Hearing failure as fatal', async () => {
    const dd = await createDD(1);

    mocks.callbacks.hearingError?.(new Error('decoder crashed'));

    await expect(dd.waitForStop()).rejects.toMatchObject({
      name: 'DDComponentError',
      component: 'Hearing',
      severity: 'fatal',
    });
  });

  it('preserves the first stop reason across repeated stop calls', async () => {
    const dd = await createDD(1);

    const firstStop = dd.stop('timeout');
    const secondStop = dd.stop('manual-stop');

    expect(secondStop).toBe(firstStop);
    await expect(firstStop).resolves.toMatchObject({
      reason: 'timeout',
      roomId: 1,
    });
    expect(mocks.bliveStop).toHaveBeenCalledOnce();
    expect(mocks.handStop).toHaveBeenCalledOnce();
  });

  it('only closes once when abort, live-ended detection, and manual stop race', async () => {
    const controller = new AbortController();
    let resolveLiveStatus: ((live: boolean) => void) | undefined;
    mocks.isRoomLive.mockImplementationOnce(
      () =>
        new Promise<boolean>(resolve => {
          resolveLiveStatus = resolve;
        }),
    );
    const dd = await createDD(1, { signal: controller.signal });

    mocks.callbacks.bliveClose?.(0, null);
    await vi.waitFor(() => {
      expect(mocks.isRoomLive).toHaveBeenCalledOnce();
    });
    controller.abort();
    const repeatedStop = dd.stop('manual-stop');
    resolveLiveStatus?.(false);

    await expect(repeatedStop).resolves.toMatchObject({ reason: 'signal' });
    expect(mocks.bliveStop).toHaveBeenCalledOnce();
    expect(mocks.hearingStop).toHaveBeenCalledOnce();
    expect(mocks.visionStop).toHaveBeenCalledOnce();
    expect(mocks.handStop).toHaveBeenCalledOnce();
    expect(mocks.memoryClear).toHaveBeenCalledOnce();
  });

  it('returns the final token report after every component has stopped', async () => {
    const dd = await createDD(1);

    const result = await dd.stop();

    expect(result.tokenUsage).toEqual(mocks.brainTokenUsage);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('Token 消耗报告（直播间 1）'),
    );
    const tokenLogIndex = mocks.loggerInfo.mock.calls.findIndex(call =>
      String(call[0]).includes('Token 消耗报告'),
    );
    const tokenLogOrder = mocks.loggerInfo.mock.invocationCallOrder[tokenLogIndex];
    expect(tokenLogOrder).toBeGreaterThan(mocks.brainIdle.mock.invocationCallOrder[0] ?? 0);
    expect(tokenLogOrder).toBeGreaterThan(mocks.bliveStop.mock.invocationCallOrder[0] ?? 0);
    expect(tokenLogOrder).toBeGreaterThan(mocks.handStop.mock.invocationCallOrder[0] ?? 0);
    expect(tokenLogOrder).toBeGreaterThan(mocks.hearingStop.mock.invocationCallOrder[0] ?? 0);
    expect(tokenLogOrder).toBeGreaterThan(mocks.visionStop.mock.invocationCallOrder[0] ?? 0);
  });

  it('stops when status polling detects that a live stream ended', async () => {
    vi.useFakeTimers();
    const dd = await createDD(1);
    mocks.isRoomLive.mockResolvedValue(false);

    await vi.advanceTimersByTimeAsync(mocks.config.live.statusPollIntervalMs);

    await expect(dd.waitForStop()).resolves.toMatchObject({
      reason: 'live-ended',
      roomId: 1,
    });
  });

  it('keeps live-ended as a normal result when the room ends during startup', async () => {
    let rejectHandStart: ((error: Error) => void) | undefined;
    mocks.handStart.mockImplementationOnce(
      () =>
        new Promise<undefined>((_resolve, reject) => {
          rejectHandStart = reject;
        }),
    );
    mocks.isRoomLive.mockResolvedValue(false);

    const createPromise = createDD(1);
    await vi.waitFor(() => {
      expect(mocks.handStart).toHaveBeenCalledOnce();
    });

    mocks.callbacks.bliveClose?.(0, null);
    rejectHandStart?.(new Error('Hand stopped during startup'));

    const dd = await createPromise;
    await expect(dd.waitForStop()).resolves.toMatchObject({
      reason: 'live-ended',
      roomId: 1,
    });
  });

  it('restarts FFmpeg when the room is live but media stops updating', async () => {
    vi.useFakeTimers();
    const dd = await createDD(1);
    mocks.getBliveHealth.mockReturnValue({
      startedAtMs: Date.now() - mocks.config.live.mediaStallTimeoutMs,
      audioBytes: 0,
      audioChunks: 0,
      imageFrames: 0,
    });

    await vi.advanceTimersByTimeAsync(
      mocks.config.live.statusPollIntervalMs + mocks.config.live.ffmpegRestartBackoffMs,
    );

    expect(mocks.bliveStart).toHaveBeenCalledTimes(2);
    expect(dd.getStatus()).toBe('running');
    expect(mocks.loggerSuccess).toHaveBeenCalledWith(expect.stringContaining('FFmpeg 已在第 1 次'));
    await dd.stop();
  });

  it('does not treat a periodic live-status network failure as the room ending', async () => {
    vi.useFakeTimers();
    const dd = await createDD(1);
    mocks.isRoomLive.mockRejectedValueOnce(new Error('temporary network failure'));

    await vi.advanceTimersByTimeAsync(mocks.config.live.statusPollIntervalMs);

    expect(dd.getStatus()).toBe('running');
    await dd.stop();
  });

  it('treats an FFmpeg close as a normal stop when the room ended', async () => {
    mocks.isRoomLive.mockResolvedValue(false);
    const dd = await createDD(1);

    mocks.callbacks.bliveClose?.(0, null);

    await expect(dd.waitForStop()).resolves.toMatchObject({
      reason: 'live-ended',
      roomId: 1,
    });
    expect(mocks.isRoomLive).toHaveBeenCalledWith(1, {
      timeoutMs: 10_000,
      retryLimit: 2,
      retryBackoffMs: 300,
      signal: expect.any(AbortSignal),
    });
    expect(mocks.memoryClear).toHaveBeenCalledOnce();
  });

  it('restarts after an unexpected FFmpeg close when the room is still live', async () => {
    vi.useFakeTimers();
    const dd = await createDD(1);
    mocks.bliveIsRunning.mockReturnValue(false);

    mocks.callbacks.bliveClose?.(1, null);
    await vi.advanceTimersByTimeAsync(mocks.config.live.ffmpegRestartBackoffMs);

    expect(mocks.bliveStart).toHaveBeenCalledTimes(2);
    expect(dd.getStatus()).toBe('running');
    await dd.stop();
    expect(mocks.bliveStop).toHaveBeenCalledOnce();
    expect(mocks.memoryClear).toHaveBeenCalledOnce();
  });

  it('fails after the configured FFmpeg restart budget is exhausted', async () => {
    vi.useFakeTimers();
    const dd = await createDD(1);
    mocks.bliveIsRunning.mockReturnValue(false);
    mocks.bliveStart
      .mockRejectedValueOnce(new Error('restart 1 failed'))
      .mockRejectedValueOnce(new Error('restart 2 failed'));

    mocks.callbacks.bliveClose?.(1, null);
    await vi.advanceTimersByTimeAsync(
      mocks.config.live.ffmpegRestartBackoffMs + mocks.config.live.ffmpegRestartBackoffMs * 2,
    );

    await expect(dd.waitForStop()).rejects.toThrow(/recovery exhausted after 2 attempt/);
    expect(mocks.bliveStart).toHaveBeenCalledTimes(3);
    expect(mocks.memoryClear).toHaveBeenCalledOnce();
  });

  it('attempts every cleanup operation when one component fails to stop', async () => {
    mocks.hearingStop.mockRejectedValueOnce(new Error('hearing cleanup failed'));
    const dd = await createDD(1);

    const result = await dd.stop();

    expect(result).toMatchObject({
      reason: 'manual-stop',
      error: expect.any(AggregateError),
    });
    expect(mocks.bliveStop).toHaveBeenCalledOnce();
    expect(mocks.hearingStop).toHaveBeenCalledOnce();
    expect(mocks.visionStop).toHaveBeenCalledOnce();
    expect(mocks.handStop).toHaveBeenCalledOnce();
    expect(mocks.brainIdle).toHaveBeenCalledOnce();
    expect(mocks.memoryClear).toHaveBeenCalledOnce();
  });

  it('times out a stuck component without blocking the remaining cleanup', async () => {
    vi.useFakeTimers();
    mocks.hearingStop.mockImplementationOnce(() => new Promise(() => {}));
    const dd = await createDD(1);

    const stopPromise = dd.stop();
    await vi.advanceTimersByTimeAsync(mocks.config.agent.shutdownTimeoutMs);
    const result = await stopPromise;

    expect(result.cleanup).toContainEqual(
      expect.objectContaining({ component: 'Hearing', status: 'timeout' }),
    );
    expect(result.error).toBeInstanceOf(AggregateError);
    expect(mocks.bliveStop).toHaveBeenCalledOnce();
    expect(mocks.visionStop).toHaveBeenCalledOnce();
    expect(mocks.handStop).toHaveBeenCalledOnce();
    expect(mocks.memoryClear).toHaveBeenCalledOnce();
  });
});
