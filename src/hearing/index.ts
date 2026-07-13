import { createNanoEvents } from 'nanoevents';

import type { Blive } from '@/blive/types.ts';
import type { DDConfig } from '@/config/index.ts';
import { createLogger } from '@/logger/index.ts';

import {
  createCircularBuffer,
  createLinearResampler,
  createOfflineRecognizer,
  createVoiceActivityDetector,
  type LinearResampler,
  type SenseVoiceRecognizerConfig,
  type VadConfig,
} from './sherpa-onnx.ts';
import type { HearingEvents, HearingFinalEvent } from './types.ts';

export * from './types.ts';

const BLIVE_SAMPLE_RATE = 16_000;
const logger = createLogger({ prefix: 'hearing', prefixColor: 'cyan' });

export function startHearing(blive: Pick<Blive, 'onAudio'>, config: DDConfig) {
  const emitter = createNanoEvents<HearingEvents>();
  const recognizer = createOfflineRecognizer(createRecognizerConfig(config));
  const vad = createVoiceActivityDetector(createVadConfig(config), config.asr.maxPendingSeconds);
  const vadWindowSize = Number(
    vad.config.tenVad?.windowSize ?? vad.config.sileroVad?.windowSize ?? 256,
  );
  const vadBuffer = createCircularBuffer(config.asr.maxPendingSeconds * config.asr.sampleRate);

  let resampler: LinearResampler | undefined;
  let currentInputSampleRate = 0;
  let segmentIndex = 0;
  let mediaEpochMs: number | undefined;
  let stopped = false;

  const unsubscribeAudio = blive.onAudio((buffer, timing) => {
    if (stopped) {
      return;
    }

    mediaEpochMs ??= timing.receivedAtMs - timing.mediaEndMs;

    const mono = pcmS16leToFloat32(buffer);
    const samples = resampleIfNeeded(mono, BLIVE_SAMPLE_RATE);

    vadBuffer.push(samples);

    while (vadBuffer.size() >= vadWindowSize) {
      const window = vadBuffer.get(vadBuffer.head(), vadWindowSize);
      vadBuffer.pop(vadWindowSize);
      vad.acceptWaveform(window);
    }

    while (!vad.isEmpty()) {
      const segment = vad.front();
      vad.pop();
      printFinal(segment.start, segment.samples);
      segmentIndex += 1;
    }
  });

  function onFinal(callback: HearingEvents['final']) {
    return emitter.on('final', callback);
  }

  async function stop(): Promise<void> {
    if (stopped) {
      return;
    }

    stopped = true;
    unsubscribeAudio();
    vad.flush();
  }

  return {
    onFinal,
    stop,
  };

  function printFinal(start: number, samples: Float32Array) {
    if (samples.length === 0) {
      return;
    }

    const stream = recognizer.createStream();
    stream.acceptWaveform({
      samples,
      sampleRate: config.asr.sampleRate,
    });

    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    const text = result.text?.trim();

    if (text) {
      const mediaStartMs = (start / config.asr.sampleRate) * 1_000;
      const mediaEndMs = mediaStartMs + (samples.length / config.asr.sampleRate) * 1_000;
      const epochMs = mediaEpochMs ?? Date.now() - mediaEndMs;

      emitter.emit('final', {
        index: segmentIndex,
        text,
        startTimeMs: epochMs + mediaStartMs,
        endTimeMs: epochMs + mediaEndMs,
        mediaStartMs,
        mediaEndMs,
      } satisfies HearingFinalEvent);
      logger.info(`#${segmentIndex} ${text}`);
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
