import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import { createNanoEvents } from 'nanoevents';

import { fetchFlvPlayInfo } from '@/bili-api/index.ts';
import { createLogger } from '@/logger/index.ts';

import type { BliveEvents } from './types.ts';

export * from './types.ts';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const FFMPEG_STOP_TIMEOUT_MS = 5_000;

export function createBlive(roomId: number) {
  const logger = createLogger({ prefix: 'ffmpeg', prefixColor: 'yellow' });
  let ffmpeg: ChildProcess | undefined;
  let imageBuffer = Buffer.alloc(0);
  let audioSampleCount = 0;
  let imageIndex = 0;
  let waitForClose: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  const emitter = createNanoEvents<BliveEvents>();

  const consumeImageData = (chunk: Buffer) => {
    // pipe 的 data 事件不会按 JPEG 图片边界分块：
    // 一个 chunk 可能只包含半张图，也可能同时包含多张图，因此先与上次残留数据合并。
    imageBuffer = Buffer.concat([imageBuffer, chunk]);

    while (true) {
      // JPEG 以 SOI 标记 FF D8 开始。
      const start = imageBuffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        // 没找到完整 SOI 时仅保留最后一个字节。
        // 如果 FF 和 D8 恰好被拆到两个 chunk，它可与下一个 chunk 的 D8 重新组成 SOI。
        imageBuffer = imageBuffer.subarray(-1);
        return;
      }

      // 从 SOI 后查找 JPEG 的 EOI 结束标记 FF D9。
      const end = imageBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        // 图片尚未接收完整，丢弃 SOI 之前的无效数据并等待后续 chunk。
        if (start > 0) imageBuffer = imageBuffer.subarray(start);
        return;
      }

      // 拷贝出一张包含 SOI/EOI 的完整 JPEG，避免后续修改 imageBuffer 影响回调数据。
      const image = Buffer.from(imageBuffer.subarray(start, end + 2));

      // 移除已消费的数据；若缓冲区里还有下一张图片，循环会继续解析并触发回调。
      imageBuffer = imageBuffer.subarray(end + 2);
      const mediaStartMs = imageIndex * 5_000;
      emitter.emit('image', image, {
        receivedAtMs: Date.now(),
        mediaStartMs,
        mediaEndMs: mediaStartMs,
      });
      imageIndex += 1;
    }
  };

  const startUrl = (flvUrl: string) => {
    if (ffmpeg) {
      throw new Error('Blive is already running');
    }

    imageBuffer = Buffer.alloc(0);
    audioSampleCount = 0;
    imageIndex = 0;
    const process = createFFmpeg(roomId, flvUrl);
    ffmpeg = process;
    waitForClose = new Promise(resolve => {
      resolveClose = resolve;
    });

    process.stdout?.on('data', (chunk: Buffer) => {
      const buffer = Buffer.from(chunk);
      const mediaStartMs = (audioSampleCount / 16_000) * 1_000;
      audioSampleCount += Math.floor(buffer.byteLength / 2);
      emitter.emit('audio', buffer, {
        receivedAtMs: Date.now(),
        mediaStartMs,
        mediaEndMs: (audioSampleCount / 16_000) * 1_000,
      });
    });

    const imageStream = process.stdio[3] as Readable | null;
    imageStream?.on('data', (chunk: Buffer) => {
      consumeImageData(Buffer.from(chunk));
    });

    process.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message && !message.includes('deprecated pixel format used')) {
        logger.warn(message);
        emitter.emit('stderr', message);
      }
    });

    process.on('error', error => {
      logger.error(error);
      emitter.emit('error', error);
    });

    process.on('close', (code, signal) => {
      if (ffmpeg === process) {
        ffmpeg = undefined;
        imageBuffer = Buffer.alloc(0);
        audioSampleCount = 0;
        imageIndex = 0;
      }
      resolveClose?.();
      resolveClose = undefined;
      logger.info(`已关闭（code=${String(code)}, signal=${String(signal)}）`);
      emitter.emit('close', code, signal);
    });
  };

  function isRunning(): boolean {
    return ffmpeg !== undefined;
  }

  function onAudio(callback: BliveEvents['audio']) {
    return emitter.on('audio', callback);
  }

  function onImage(callback: BliveEvents['image']) {
    return emitter.on('image', callback);
  }

  function onError(callback: BliveEvents['error']) {
    return emitter.on('error', callback);
  }

  function onClose(callback: BliveEvents['close']) {
    return emitter.on('close', callback);
  }

  function onStderr(callback: BliveEvents['stderr']) {
    return emitter.on('stderr', callback);
  }

  async function start(): Promise<void> {
    startUrl(await fetchFlvPlayInfo(roomId));
  }

  async function stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<boolean> {
    const activeProcess = ffmpeg;
    const closePromise = waitForClose;
    if (!activeProcess || !closePromise) {
      return false;
    }

    const killed = activeProcess.kill(signal);
    if (!killed) {
      return false;
    }

    const closed = await waitWithTimeout(closePromise, FFMPEG_STOP_TIMEOUT_MS);
    if (!closed && ffmpeg === activeProcess) {
      logger.warn('FFmpeg 未在超时内退出，发送 SIGKILL');
      activeProcess.kill('SIGKILL');
      await waitWithTimeout(closePromise, FFMPEG_STOP_TIMEOUT_MS);
    }
    return true;
  }

  return {
    roomId,
    isRunning,
    onAudio,
    onImage,
    onError,
    onClose,
    onStderr,
    start,
    startUrl,
    stop,
  };
}

function waitWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

function createFFmpeg(roomId: number, flvUrl: string) {
  return spawn(
    'ffmpeg',
    [
      // 隐藏 FFmpeg 启动时的大段版本/编译信息，让 stderr 更干净
      '-hide_banner',

      // 日志等级：只输出 warning 及以上日志
      // 可选：error / warning / info / debug
      '-loglevel',
      'error',

      // 输入参数：降低缓冲，尽量减少直播流延迟
      // 注意：这类低延迟参数可能会牺牲稳定性，部分流上可能更容易卡顿或丢包
      '-fflags',
      'nobuffer',

      // 输入/解码参数：启用低延迟模式
      // 对部分编码格式/封装有效，不是所有直播流都会明显生效
      '-flags',
      'low_delay',

      // 探测输入流信息的最大时长，单位是微秒
      // 1000000 = 1 秒
      // 值越小，启动越快；但太小可能导致音视频轨识别不完整
      '-analyzeduration',
      '1000000',

      // 探测输入流信息时最多读取的数据量，单位是字节
      // 1000000 ≈ 1 MB
      // 值越小，启动越快；但太小可能导致识别不到音频/视频轨
      '-probesize',
      '1000000',

      // B 站直播 CDN 会校验请求来源。缺少这些请求头时，即使签名 URL 有效也可能返回 403。
      // HTTP 输入选项必须位于 -i 之前，才会应用到下面的 FLV 请求。
      '-user_agent',
      BROWSER_USER_AGENT,
      '-referer',
      `https://live.bilibili.com/${roomId}`,
      '-headers',
      'Origin: https://live.bilibili.com\r\n',

      // 输入地址，这里是 FLV 直播流 URL
      '-i',
      flvUrl,

      // =========================
      // 输出 1：音频 -> stdout
      // =========================

      // 选择第一个音频流
      // 0 表示第一个输入源
      // a 表示 audio
      // 0 表示第一个音频轨
      // ? 表示可选：如果没有音频轨，不要直接让 FFmpeg 启动失败
      '-map',
      '0:a:0?',

      // 禁用视频输出
      // 这个输出只要音频，不要混入视频
      '-vn',

      // 音频编码器：输出 16-bit little-endian PCM
      // 对应后面的 -f s16le
      // 很适合直接喂给 ASR / VAD / 音频环形缓冲区
      '-acodec',
      'pcm_s16le',

      // 音频声道数：1 = 单声道
      // ASR 通常用单声道即可，数据量也更小
      '-ac',
      '1',

      // 音频采样率：16000 Hz
      // 大多数语音识别模型常用 16k
      '-ar',
      '16000',

      // 输出格式：裸 PCM s16le
      // 没有 wav header，stdout 里全是连续 PCM bytes
      '-f',
      's16le',

      // 输出到 stdout，也就是 ffmpeg.stdout
      'pipe:1',

      // =========================
      // 输出 2：视频截图 -> fd 3
      // =========================

      // 选择第一个视频流
      // 0 表示第一个输入源
      // v 表示 video
      // 0 表示第一个视频轨
      // ? 表示可选：如果没有视频轨，不要直接让 FFmpeg 启动失败
      '-map',
      '0:v:0?',

      // 禁用音频输出
      // 这个输出只要图片，不要混入音频
      '-an',

      // 视频滤镜：
      // fps=1/5 表示每 5 秒抽 1 帧
      // scale=320:-1 表示宽度缩放到 320，高度按比例自动计算
      '-vf',
      'fps=1/5,scale=320:-1',

      // MJPEG/JPEG 质量
      // 数字越小质量越高、体积越大
      // 常用范围大概 2~8
      '-q:v',
      '4',

      // 输出格式：image2pipe
      // 表示把一张张图片连续写入 pipe，而不是写成文件
      '-f',
      'image2pipe',

      // 视频编码器：mjpeg
      // 每一帧输出为一张 JPEG 图片
      '-vcodec',
      'mjpeg',

      // 输出到文件描述符 3，也就是 ffmpeg.stdio[3]
      // 注意：这里不是 stdout，stdout 已经被音频占用了
      'pipe:3',
    ],
    {
      // stdio[0] = stdin：ignore，不给 FFmpeg 输入命令
      // stdio[1] = stdout：pipe，对应 pipe:1，用来读取 PCM 音频
      // stdio[2] = stderr：pipe，用来读取 FFmpeg 日志
      // stdio[3] = 额外 pipe，对应 pipe:3，用来读取 MJPEG 图片流
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    },
  );
}
