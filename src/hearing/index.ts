import { performance } from 'node:perf_hooks';

import { createNanoEvents } from 'nanoevents';

import type { Blive } from '@/blive/types.ts';
import type { DDConfig } from '@/config/index.ts';
import { createLogger } from '@/logger/index.ts';
import { withComponent, type RoomContext } from '@/observability/context.ts';

import {
  createCircularBuffer,
  createLinearResampler,
  createOfflineRecognizer,
  createVoiceActivityDetector,
  type LinearResampler,
  type SenseVoiceRecognizerConfig,
  type VadConfig,
} from './sherpa-onnx.ts';
import type { HearingEvents, HearingFinalEvent, HearingStats } from './types.ts';

export * from './types.ts';

const BLIVE_SAMPLE_RATE = 16_000;
interface PendingSegment {
  index: number;
  start: number;
  samples: Float32Array;
}

export function startHearing(
  blive: Pick<Blive, 'onAudio'>,
  config: DDConfig,
  context?: RoomContext,
) {
  const logger = createLogger({
    prefix: 'hearing',
    prefixColor: 'cyan',
    context: context ? withComponent(context, 'hearing') : undefined,
  });
  const emitter = createNanoEvents<HearingEvents>();
  const recognizer = createOfflineRecognizer(createRecognizerConfig(config));
  const vad = createVoiceActivityDetector(createVadConfig(config), config.asr.maxPendingSeconds);
  const vadWindowSize = Number(
    vad.config.tenVad?.windowSize ?? vad.config.sileroVad?.windowSize ?? 256,
  );
  const vadBuffer = createCircularBuffer(config.asr.maxPendingSeconds * config.asr.sampleRate);
  const maxQueuedSamples = config.asr.maxPendingSeconds * config.asr.sampleRate;
  const pendingSegments: PendingSegment[] = [];

  let resampler: LinearResampler | undefined;
  let currentInputSampleRate = 0;
  let segmentIndex = 0;
  let mediaEpochMs: number | undefined;
  let recognitionWorker: Promise<void> | undefined;
  let queuedSamples = 0;
  let activeSamples = 0;
  let decodedSegments = 0;
  let emptySegments = 0;
  let droppedSegments = 0;
  let failedSegments = 0;
  let lastDecodeMs: number | undefined;
  let lastRealTimeFactor: number | undefined;
  let stopped = false;

  const unsubscribeAudio = blive.onAudio((buffer, timing) => {
    if (stopped) {
      return;
    }

    mediaEpochMs ??= timing.receivedAtMs - timing.mediaEndMs;

    try {
      const mono = pcmS16leToFloat32(buffer);
      const samples = resampleIfNeeded(mono, BLIVE_SAMPLE_RATE);

      vadBuffer.push(samples);

      while (vadBuffer.size() >= vadWindowSize) {
        const window = vadBuffer.get(vadBuffer.head(), vadWindowSize);
        vadBuffer.pop(vadWindowSize);
        vad.acceptWaveform(window);
      }

      drainVadSegments();
    } catch (error) {
      reportError(error);
    }
  });

  function onFinal(callback: HearingEvents['final']) {
    return emitter.on('final', callback);
  }

  function onError(callback: HearingEvents['error']) {
    return emitter.on('error', callback);
  }

  function getStats(): HearingStats {
    return {
      queuedSegments: pendingSegments.length,
      queuedAudioSeconds: queuedSamples / config.asr.sampleRate,
      activeAudioSeconds: activeSamples / config.asr.sampleRate,
      decodedSegments,
      emptySegments,
      droppedSegments,
      failedSegments,
      lastDecodeMs,
      lastRealTimeFactor,
    };
  }

  async function stop(): Promise<void> {
    if (stopped) {
      return;
    }

    stopped = true;
    unsubscribeAudio();
    vad.flush();
    drainVadSegments();
    await recognitionWorker;
  }

  return {
    getStats,
    onFinal,
    onError,
    stop,
  };

  function drainVadSegments() {
    while (!vad.isEmpty()) {
      const segment = vad.front();
      vad.pop();
      const index = segmentIndex;
      segmentIndex += 1;
      enqueueRecognition({
        index,
        start: segment.start,
        samples: Float32Array.from(segment.samples),
      });
    }
  }

  function enqueueRecognition(segment: PendingSegment) {
    while (
      queuedSamples + segment.samples.length > maxQueuedSamples &&
      pendingSegments.length > 0
    ) {
      const dropped = pendingSegments.shift()!;
      queuedSamples -= dropped.samples.length;
      droppedSegments += 1;
      logger.warn(`ASR 积压过高，丢弃最旧语音段 #${dropped.index}`);
    }

    if (
      segment.samples.length > maxQueuedSamples ||
      queuedSamples + segment.samples.length > maxQueuedSamples
    ) {
      droppedSegments += 1;
      logger.warn(`ASR 语音段 #${segment.index} 超过积压上限，已丢弃`);
      return;
    }

    pendingSegments.push(segment);
    queuedSamples += segment.samples.length;
    startRecognitionWorker();
  }

  function startRecognitionWorker() {
    if (recognitionWorker) {
      return;
    }

    const worker = drainRecognitionQueue().finally(() => {
      if (recognitionWorker === worker) {
        recognitionWorker = undefined;
      }
    });
    recognitionWorker = worker;
  }

  async function drainRecognitionQueue() {
    while (pendingSegments.length > 0) {
      const segment = pendingSegments.shift()!;
      queuedSamples -= segment.samples.length;
      activeSamples = segment.samples.length;
      const audioDurationMs = (segment.samples.length / config.asr.sampleRate) * 1_000;
      const decodeStartedAt = performance.now();

      try {
        const hasText = await recognize(segment);
        decodedSegments += 1;
        if (!hasText) {
          emptySegments += 1;
        }
      } catch (error) {
        failedSegments += 1;
        reportError(error);
      } finally {
        lastDecodeMs = performance.now() - decodeStartedAt;
        lastRealTimeFactor = audioDurationMs > 0 ? lastDecodeMs / audioDurationMs : undefined;
        activeSamples = 0;
      }
    }
  }

  async function recognize(segment: PendingSegment) {
    if (segment.samples.length === 0) {
      return false;
    }

    const stream = recognizer.createStream();
    stream.acceptWaveform({
      samples: segment.samples,
      sampleRate: config.asr.sampleRate,
    });

    const result = await recognizer.decodeAsync(stream);
    const text = result.text?.trim();

    if (!text) {
      return false;
    }

    const mediaStartMs = (segment.start / config.asr.sampleRate) * 1_000;
    const mediaEndMs = mediaStartMs + (segment.samples.length / config.asr.sampleRate) * 1_000;
    const epochMs = mediaEpochMs ?? Date.now() - mediaEndMs;

    emitter.emit('final', {
      index: segment.index,
      text,
      startTimeMs: epochMs + mediaStartMs,
      endTimeMs: epochMs + mediaEndMs,
      mediaStartMs,
      mediaEndMs,
    } satisfies HearingFinalEvent);
    logger.info(`#${segment.index} ${text}`);
    return true;
  }

  function reportError(error: unknown) {
    const value = error instanceof Error ? error : new Error(String(error));
    if (stopped) {
      logger.warn(value);
    } else {
      logger.error(value);
      emitter.emit('error', value);
    }
  }

  function resampleIfNeeded(samples: Float32Array, inputSampleRate: number) {
    if (inputSampleRate === config.asr.sampleRate) {
      return samples;
    }

    if (!resampler || currentInputSampleRate !== inputSampleRate) {
      resampler = createLinearResampler(inputSampleRate, config.asr.sampleRate);
      currentInputSampleRate = inputSampleRate;
    }

    return resampler.resample(samples);
  }
}

function pcmS16leToFloat32(buffer: Buffer) {
  const samples = new Float32Array(Math.floor(buffer.byteLength / 2));

  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readInt16LE(index * 2) / 32768;
  }

  return samples;
}

function createRecognizerConfig(config: DDConfig): SenseVoiceRecognizerConfig {
  return {
    featConfig: {
      sampleRate: config.asr.sampleRate,
      featureDim: config.asr.featureDim,
    },
    modelConfig: {
      senseVoice: {
        model: config.asr.senseVoiceModel,
        useInverseTextNormalization: Number(config.asr.useItn),
      },
      tokens: config.asr.tokens,
      numThreads: config.asr.numThreads,
      provider: config.asr.provider,
      debug: Number(config.asr.debug),
    },
  };
}

function createVadConfig(config: DDConfig): VadConfig {
  const common = {
    sampleRate: config.asr.sampleRate,
    numThreads: config.asr.vadNumThreads,
    provider: config.asr.provider,
    debug: Number(config.asr.debug),
  };

  if (config.asr.vad.kind === 'silero') {
    return {
      sileroVad: {
        model: config.asr.vad.model,
        threshold: config.asr.vad.threshold,
        minSpeechDuration: config.asr.vad.minSpeechSeconds,
        minSilenceDuration: config.asr.vad.minSilenceSeconds,
        windowSize: config.asr.vad.windowSize,
      },
      ...common,
    };
  }

  return {
    tenVad: {
      model: config.asr.vad.model,
      threshold: config.asr.vad.threshold,
      minSpeechDuration: config.asr.vad.minSpeechSeconds,
      minSilenceDuration: config.asr.vad.minSilenceSeconds,
      windowSize: config.asr.vad.windowSize,
    },
    ...common,
  };
}
