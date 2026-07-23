import { describe, expect, it, vi } from 'vite-plus/test';

import { createDefaultConfig } from '@/config/index.ts';

const mocks = vi.hoisted(() => {
  const segments: Array<{ start: number; samples: Float32Array }> = [];
  const decodeAsync = vi.fn(async () => ({ text: '最后一句' }));
  return { decodeAsync, segments };
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
      mocks.segments.push({ start: 0, samples: new Float32Array(1_600) });
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
  });
});
