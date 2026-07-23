import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import type { MediaTiming } from '@/blive/types.ts';
import { createDefaultConfig } from '@/config/index.ts';

const mocks = vi.hoisted(() => {
  const segments: Array<{ start: number; samples: Float32Array }> = [];
  return {
    audioCallback: undefined as ((buffer: Buffer, timing: MediaTiming) => void) | undefined,
    decodeAsync: vi.fn(),
    flushSegment: true,
    segments,
  };
});

vi.mock('./sherpa-onnx.ts', () => ({
  createOfflineRecognizer: () => ({
    createStream: () => ({ acceptWaveform: vi.fn() }),
    decodeAsync: mocks.decodeAsync,
  }),
  createVoiceActivityDetector: () => ({
    config: { sileroVad: { windowSize: 512 } },
    acceptWaveform: vi.fn(),
    isEmpty: () => mocks.segments.length === 0,
    pop: () => {
      mocks.segments.shift();
    },
    front: () => mocks.segments[0],
    flush: () => {
      if (mocks.flushSegment) {
        mocks.segments.push({ start: 0, samples: new Float32Array(1_600) });
      }
    },
  }),
  createCircularBuffer: () => ({
    push: vi.fn(),
    get: vi.fn(),
    pop: vi.fn(),
    size: () => 0,
    head: () => 0,
  }),
  createLinearResampler: vi.fn(),
}));

import { startHearing } from './index.ts';

describe('startHearing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audioCallback = undefined;
    mocks.flushSegment = true;
    mocks.segments.length = 0;
    mocks.decodeAsync.mockResolvedValue({ text: '最后一句' });
  });

  it('flushes and asynchronously decodes the final VAD segment on stop', async () => {
    const config = createDefaultConfig();
    const onFinal = vi.fn();
    const hearing = startHearing(
      {
        onAudio: () => vi.fn(),
      },
      config,
    );
    hearing.onFinal(onFinal);

    await hearing.stop();

    expect(mocks.decodeAsync).toHaveBeenCalledOnce();
    expect(onFinal).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 0,
        text: '最后一句',
        mediaStartMs: 0,
        mediaEndMs: 100,
      }),
    );
    expect(hearing.getStats()).toMatchObject({
      queuedSegments: 0,
      decodedSegments: 1,
      droppedSegments: 0,
      failedSegments: 0,
    });
  });

  it('drops the oldest queued segment when pending audio exceeds the limit', async () => {
    const config = createDefaultConfig();
    config.asr.maxPendingSeconds = 0.1;
    mocks.flushSegment = false;
    let resolveFirstDecode: ((result: { text: string }) => void) | undefined;
    mocks.decodeAsync
      .mockImplementationOnce(
        () =>
          new Promise<{ text: string }>(resolve => {
            resolveFirstDecode = resolve;
          }),
      )
      .mockResolvedValue({ text: '最新语音' });
    const onFinal = vi.fn();
    const hearing = startHearing(
      {
        onAudio: callback => {
          mocks.audioCallback = callback;
          return vi.fn();
        },
      },
      config,
    );
    hearing.onFinal(onFinal);
    mocks.segments.push(
      { start: 0, samples: new Float32Array(1_600) },
      { start: 1_600, samples: new Float32Array(1_600) },
      { start: 3_200, samples: new Float32Array(1_600) },
    );

    mocks.audioCallback?.(Buffer.alloc(0), {
      receivedAtMs: 1_000,
      mediaStartMs: 0,
      mediaEndMs: 0,
    });

    expect(hearing.getStats()).toMatchObject({
      queuedSegments: 1,
      queuedAudioSeconds: 0.1,
      activeAudioSeconds: 0.1,
      droppedSegments: 1,
    });

    resolveFirstDecode?.({ text: '第一段' });
    await hearing.stop();

    expect(onFinal.mock.calls.map(([event]) => event.index)).toEqual([0, 2]);
    expect(hearing.getStats()).toMatchObject({
      queuedSegments: 0,
      queuedAudioSeconds: 0,
      activeAudioSeconds: 0,
      decodedSegments: 2,
      droppedSegments: 1,
      failedSegments: 0,
    });
  });
});
