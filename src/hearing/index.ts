import { createNanoEvents } from 'nanoevents';

import type { Blive } from '../blive/types.ts';
import { env } from '../env.ts';
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

const BLIVE_SAMPLE_RATE = 16_000;

export function startHearing(blive: Pick<Blive, 'onAudio'>) {
  const emitter = createNanoEvents<HearingEvents>();
  const recognizer = createOfflineRecognizer(createRecognizerConfig());
  const vad = createVoiceActivityDetector(createVadConfig(), env.MAX_PENDING_SECONDS);
  const vadWindowSize = Number(
    vad.config.tenVad?.windowSize ?? vad.config.sileroVad?.windowSize ?? 256,
  );
  const vadBuffer = createCircularBuffer(env.MAX_PENDING_SECONDS * env.SAMPLE_RATE);

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

  return {
    onFinal: (callback: HearingEvents['final']) => emitter.on('final', callback),
    async stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      unsubscribeAudio();
      vad.flush();
    },
  };

  function printFinal(start: number, samples: Float32Array) {
    if (samples.length === 0) {
      return;
    }

    const stream = recognizer.createStream();
    stream.acceptWaveform({
      samples,
      sampleRate: env.SAMPLE_RATE,
    });

    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    const text = result.text?.trim();

    if (text) {
      const mediaStartMs = (start / env.SAMPLE_RATE) * 1_000;
      const mediaEndMs = mediaStartMs + (samples.length / env.SAMPLE_RATE) * 1_000;
      const epochMs = mediaEpochMs ?? Date.now() - mediaEndMs;

      emitter.emit('final', {
        index: segmentIndex,
        text,
        startTimeMs: epochMs + mediaStartMs,
        endTimeMs: epochMs + mediaEndMs,
        mediaStartMs,
        mediaEndMs,
      } satisfies HearingFinalEvent);
    }
  }

  function resampleIfNeeded(samples: Float32Array, inputSampleRate: number) {
    if (inputSampleRate === env.SAMPLE_RATE) {
      return samples;
    }

    if (!resampler || currentInputSampleRate !== inputSampleRate) {
      resampler = createLinearResampler(inputSampleRate, env.SAMPLE_RATE);
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

function createRecognizerConfig(): SenseVoiceRecognizerConfig {
  return {
    featConfig: {
      sampleRate: env.SAMPLE_RATE,
      featureDim: env.FEATURE_DIM,
    },
    modelConfig: {
      senseVoice: {
        model: env.SENSEVOICE_MODEL,
        useInverseTextNormalization: env.USE_ITN,
      },
      tokens: env.TOKENS,
      numThreads: env.NUM_THREADS,
      provider: env.PROVIDER,
      debug: env.DEBUG,
    },
  };
}

function createVadConfig(): VadConfig {
  const common = {
    sampleRate: env.SAMPLE_RATE,
    numThreads: env.VAD_NUM_THREADS,
    provider: env.PROVIDER,
    debug: env.DEBUG,
  };

  if (env.VAD_KIND === 'silero') {
    return {
      sileroVad: {
        model: env.VAD_MODEL,
        threshold: env.VAD_THRESHOLD,
        minSpeechDuration: env.VAD_MIN_SPEECH,
        minSilenceDuration: env.VAD_MIN_SILENCE,
        windowSize: env.VAD_WINDOW_SIZE,
      },
      ...common,
    };
  }

  return {
    tenVad: {
      model: env.VAD_MODEL,
      threshold: env.VAD_THRESHOLD,
      minSpeechDuration: env.VAD_MIN_SPEECH,
      minSilenceDuration: env.VAD_MIN_SILENCE,
      windowSize: env.VAD_WINDOW_SIZE,
    },
    ...common,
  };
}
