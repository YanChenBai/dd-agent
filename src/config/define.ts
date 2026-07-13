import { createDefineConfig } from 'c12';

export interface DDConfig {
  /** Agent 运行行为。 */
  agent: {
    /** 主播称呼 Agent 时使用的名字。 */
    name: string;
    /** 自动停止时间（毫秒）；0 表示持续运行。 */
    stopAfterMs: number;
    /** 大脑读取短期记忆并考虑生成弹幕的间隔（毫秒）。 */
    danmakuIntervalMs: number;
    /** 模型请求携带的最近生成对话轮数。 */
    danmakuHistoryTurns: number;
  };
  /** Bilibili 直播间与弹幕发送设置。 */
  live: {
    /** 默认进入的 Bilibili 直播间 ID。 */
    roomId: number;
    /** 是否实际发送生成的弹幕；关闭时仅终端预览。 */
    sendDanmaku: boolean;
    /** 主播别名，用于理解直播内容与生成弹幕。 */
    streamerAliases: string[];
    /** 浏览器登录态的持久化目录。 */
    browserUserDataDir: string;
    /** 等待手动完成 Bilibili 登录的最长时间（毫秒）。 */
    loginTimeoutMs: number;
  };
  /** OpenAI 兼容模型服务设置。 */
  ai: {
    /** 模型 ID。 */
    model: string;
    /** 模型服务的 API Key。 */
    apiKey: string;
    /** OpenAI 兼容 API 的基础地址。 */
    baseUrl: string;
  };
  /** 短期记忆设置。 */
  memory: {
    /** 语音和画面记录的保留时间（毫秒）。 */
    retentionMs: number;
    /** 视觉拼图的本地缓存目录。 */
    visionDir: string;
    /** 每次模型请求使用的近期上下文窗口（毫秒）。 */
    brainContextWindowMs: number;
    /** 每次模型请求最多携带的四帧视觉拼图数量。 */
    brainContextImages: number;
  };
  /** 本地语音识别与语音活动检测设置。 */
  asr: {
    /** 语音识别与 VAD 使用的目标采样率。 */
    sampleRate: number;
    /** 可积压处理的最长音频时长（秒）。 */
    maxPendingSeconds: number;
    /** sherpa-onnx 执行提供程序，例如 cpu。 */
    provider: string;
    /** 语音识别线程数。 */
    numThreads: number;
    /** VAD 线程数。 */
    vadNumThreads: number;
    /** 是否启用 sherpa-onnx 调试日志。 */
    debug: boolean;
    /** SenseVoice ONNX 模型文件路径。 */
    senseVoiceModel: string;
    /** SenseVoice token 文件路径。 */
    tokens: string;
    /** 声学特征维度。 */
    featureDim: number;
    /** 是否启用逆文本规范化。 */
    useItn: boolean;
    /** 语音活动检测器设置。 */
    vad: {
      /** VAD 实现，可选 silero 或 ten。 */
      kind: 'silero' | 'ten';
      /** VAD ONNX 模型文件路径。 */
      model: string;
      /** 判定为语音的最低置信度。 */
      threshold: number;
      /** 最短有效语音时长（秒）。 */
      minSpeechSeconds: number;
      /** 结束语音段前所需的最短静音时长（秒）。 */
      minSilenceSeconds: number;
      /** 单次 VAD 处理的采样窗口大小。 */
      windowSize: number;
    };
  };
  /** Explore 到处 D 模式设置。 */
  explore: {
    /** 用于发现候选直播间的 Bilibili 分区页面。 */
    areaUrl: string;
    /** 到处 D 模式最长运行时间（毫秒）。 */
    maxRunMs: number;
    /** 单个直播间最长观察时间（毫秒），实际值不会超过 1 小时。 */
    observeRoomMs: number;
    /** 每次刷新最多保留的直播间候选数。 */
    candidateLimit: number;
  };
}

export type DDConfigInput = DeepPartial<DDConfig>;

type DeepPartial<T> = {
  [Key in keyof T]?: T[Key] extends readonly unknown[]
    ? T[Key]
    : T[Key] extends object
      ? DeepPartial<T[Key]>
      : T[Key];
};

export const defineConfig = createDefineConfig<DDConfigInput>();
