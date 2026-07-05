import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface SenseVoiceRecognizerConfig {
  featConfig: { sampleRate: number; featureDim: number };
  modelConfig: {
    senseVoice: {
      model: string;
      language?: string;
      useInverseTextNormalization: number;
    };
    tokens: string;
    numThreads: number;
    provider: string;
    debug: number;
  };
}

export interface VadModelConfig {
  model: string;
  threshold: number;
  minSpeechDuration: number;
  minSilenceDuration: number;
  windowSize: number;
  maxSpeechDuration?: number;
}

interface VadCommonConfig {
  sampleRate: number;
  numThreads: number;
  provider: string;
  debug: number;
}

export type VadConfig = VadCommonConfig &
  ({ sileroVad: VadModelConfig; tenVad?: never } | { sileroVad?: never; tenVad: VadModelConfig });

export interface RecognitionResult {
  lang: string;
  emotion: string;
  event: string;
  text: string;
  timestamps: number[];
  durations: number[];
  tokens: string[];
  ys_log_probs: number[];
  words: number[];
}

export interface SpeechSegment {
  start: number;
  samples: Float32Array;
}

export interface OfflineStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
  setOption(key: string, value: string): void;
}

export interface OfflineRecognizer {
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  decodeAsync(stream: OfflineStream): Promise<RecognitionResult>;
  getResult(stream: OfflineStream): RecognitionResult;
}

export interface VoiceActivityDetector {
  readonly config: VadConfig;
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  isDetected(): boolean;
  pop(): void;
  clear(): void;
  front(enableExternalBuffer?: boolean): SpeechSegment;
  reset(): void;
  flush(): void;
}

export interface CircularBuffer {
  push(samples: Float32Array): void;
  get(startIndex: number, length: number, enableExternalBuffer?: boolean): Float32Array;
  pop(length: number): void;
  size(): number;
  head(): number;
  reset(): void;
}

export interface LinearResampler {
  resample(samples: Float32Array): Float32Array;
  flush(samples: Float32Array): Float32Array;
  reset(): void;
  getInputSampleRate(): number;
  getOutputSampleRate(): number;
}

interface SherpaOnnxBinding {
  OfflineRecognizer: new (config: SenseVoiceRecognizerConfig) => OfflineRecognizer;
  Vad: new (config: VadConfig, bufferSizeInSeconds: number) => VoiceActivityDetector;
  CircularBuffer: new (capacity: number) => CircularBuffer;
  LinearResampler: new (inputSampleRate: number, outputSampleRate: number) => LinearResampler;
}

const binding = require('sherpa-onnx-node') as SherpaOnnxBinding;

export function createOfflineRecognizer(config: SenseVoiceRecognizerConfig) {
  return new binding.OfflineRecognizer(config);
}

export function createVoiceActivityDetector(config: VadConfig, bufferSizeInSeconds: number) {
  return new binding.Vad(config, bufferSizeInSeconds);
}

export function createCircularBuffer(capacity: number) {
  return new binding.CircularBuffer(capacity);
}

export function createLinearResampler(inputSampleRate: number, outputSampleRate: number) {
  return new binding.LinearResampler(inputSampleRate, outputSampleRate);
}
