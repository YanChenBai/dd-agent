import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startSystemAudioCapture, type SystemAudioChunk } from "@dd-agent/native";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node");

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = resolve(appDir, "models");
const senseVoiceDir = resolve(modelsDir, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09");

const targetSampleRate = Number(process.env.SHERPA_ONNX_SAMPLE_RATE ?? 16_000);
const maxPendingSeconds = Number(process.env.SHERPA_ONNX_MAX_PENDING_SECONDS ?? 30);
const vadModel = process.env.SHERPA_ONNX_VAD_KIND ?? "ten";

export type HearingFinalEvent = {
  index: number;
  text: string;
};

export function startHearing() {
  const events = new EventEmitter();
  const recognizer = new sherpa.OfflineRecognizer(createRecognizerConfig());
  const vad = new sherpa.Vad(createVadConfig(), maxPendingSeconds);
  const vadWindowSize = Number(
    vad.config.tenVad?.windowSize ?? vad.config.sileroVad?.windowSize ?? 256,
  );
  const vadBuffer = new sherpa.CircularBuffer(maxPendingSeconds * targetSampleRate);

  let resampler: any;
  let currentInputSampleRate = 0;
  let segmentIndex = 0;
  let stopped = false;

  const capture = startSystemAudioCapture((chunk) => {
    if (stopped) {
      return;
    }

    const mono = pcmChunkToMonoFloat32(chunk);
    const samples = resampleIfNeeded(mono, chunk.sampleRate);

    vadBuffer.push(samples);

    while (vadBuffer.size() >= vadWindowSize) {
      const window = vadBuffer.get(vadBuffer.head(), vadWindowSize);
      vadBuffer.pop(vadWindowSize);
      vad.acceptWaveform(window);
    }

    while (!vad.isEmpty()) {
      const segment = vad.front();
      vad.pop();
      printFinal(segment.samples);
      segmentIndex += 1;
    }
  });

  return {
    events,
    async stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      capture.stop();
      vad.flush();
    },
  };

  function printFinal(samples: Float32Array) {
    if (samples.length === 0) {
      return;
    }

    const stream = recognizer.createStream();
    stream.acceptWaveform({
      samples,
      sampleRate: targetSampleRate,
    });

    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    const text = result.text?.trim();

    if (text) {
      events.emit("final", {
        index: segmentIndex,
        text,
      } satisfies HearingFinalEvent);
    }
  }

  function resampleIfNeeded(samples: Float32Array, inputSampleRate: number) {
    if (inputSampleRate === targetSampleRate) {
      return samples;
    }

    if (!resampler || currentInputSampleRate !== inputSampleRate) {
      resampler = new sherpa.LinearResampler(inputSampleRate, targetSampleRate);
      currentInputSampleRate = inputSampleRate;
    }

    return resampler.resample(samples);
  }
}

function pcmChunkToMonoFloat32(chunk: SystemAudioChunk) {
  const sampleCount = Math.floor(chunk.data.byteLength / bytesPerSample(chunk.sampleFormat));
  const frames = Math.floor(sampleCount / chunk.channels);
  const samples = new Float32Array(frames);

  for (let frame = 0; frame < frames; frame += 1) {
    let value = 0;

    for (let channel = 0; channel < chunk.channels; channel += 1) {
      value += readSample(chunk.data, frame * chunk.channels + channel, chunk.sampleFormat);
    }

    samples[frame] = value / chunk.channels;
  }

  return samples;
}

function readSample(buffer: Buffer, sampleIndex: number, sampleFormat: string) {
  switch (sampleFormat) {
    case "f32":
      return buffer.readFloatLE(sampleIndex * 4);
    case "f64":
      return buffer.readDoubleLE(sampleIndex * 8);
    case "i8":
      return buffer.readInt8(sampleIndex) / 128;
    case "u8":
      return (buffer.readUInt8(sampleIndex) - 128) / 128;
    case "i16":
      return buffer.readInt16LE(sampleIndex * 2) / 32768;
    case "u16":
      return (buffer.readUInt16LE(sampleIndex * 2) - 32768) / 32768;
    case "i24":
    case "i32":
      return buffer.readInt32LE(sampleIndex * 4) / 2147483648;
    case "u24":
    case "u32":
      return (buffer.readUInt32LE(sampleIndex * 4) - 2147483648) / 2147483648;
    default:
      throw new Error(`Unsupported sample format: ${sampleFormat}`);
  }
}

function bytesPerSample(sampleFormat: string) {
  switch (sampleFormat) {
    case "i8":
    case "u8":
      return 1;
    case "i16":
    case "u16":
      return 2;
    case "f64":
      return 8;
    default:
      return 4;
  }
}

function createRecognizerConfig() {
  return {
    featConfig: {
      sampleRate: targetSampleRate,
      featureDim: Number(process.env.SHERPA_ONNX_FEATURE_DIM ?? 80),
    },
    modelConfig: {
      senseVoice: {
        model: fileEnv("SHERPA_ONNX_SENSEVOICE_MODEL", resolve(senseVoiceDir, "model.int8.onnx")),
        useInverseTextNormalization: Number(process.env.SHERPA_ONNX_USE_ITN ?? 1),
      },
      tokens: fileEnv("SHERPA_ONNX_TOKENS", resolve(senseVoiceDir, "tokens.txt")),
      numThreads: Number(process.env.SHERPA_ONNX_NUM_THREADS ?? 2),
      provider: process.env.SHERPA_ONNX_PROVIDER ?? "cpu",
      debug: Number(process.env.SHERPA_ONNX_DEBUG ?? 0),
    },
  };
}

function createVadConfig() {
  const common = {
    sampleRate: targetSampleRate,
    numThreads: Number(process.env.SHERPA_ONNX_VAD_NUM_THREADS ?? 1),
    provider: process.env.SHERPA_ONNX_PROVIDER ?? "cpu",
    debug: Number(process.env.SHERPA_ONNX_DEBUG ?? 0),
  };

  if (vadModel === "silero") {
    return {
      sileroVad: {
        model: fileEnv("SHERPA_ONNX_VAD_MODEL", resolve(modelsDir, "silero_vad.onnx")),
        threshold: Number(process.env.SHERPA_ONNX_VAD_THRESHOLD ?? 0.5),
        minSpeechDuration: Number(process.env.SHERPA_ONNX_VAD_MIN_SPEECH ?? 0.25),
        minSilenceDuration: Number(process.env.SHERPA_ONNX_VAD_MIN_SILENCE ?? 0.5),
        windowSize: Number(process.env.SHERPA_ONNX_VAD_WINDOW_SIZE ?? 512),
      },
      ...common,
    };
  }

  return {
    tenVad: {
      model: fileEnv("SHERPA_ONNX_VAD_MODEL", resolve(modelsDir, "ten-vad.onnx")),
      threshold: Number(process.env.SHERPA_ONNX_VAD_THRESHOLD ?? 0.5),
      minSpeechDuration: Number(process.env.SHERPA_ONNX_VAD_MIN_SPEECH ?? 0.25),
      minSilenceDuration: Number(process.env.SHERPA_ONNX_VAD_MIN_SILENCE ?? 0.5),
      windowSize: Number(process.env.SHERPA_ONNX_VAD_WINDOW_SIZE ?? 256),
    },
    ...common,
  };
}

function fileEnv(name: string, defaultValue: string) {
  const value = process.env[name] ?? defaultValue;
  assertPath(name, value);
  return value;
}

function assertPath(name: string, value: string) {
  if (!existsSync(value)) {
    throw new Error(`${name} does not exist: ${value}`);
  }
}
