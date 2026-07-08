import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import { createNanoEvents } from 'nanoevents';
import PQueue from 'p-queue';
import puppeteer from 'puppeteer';
import { getStream, launch, wss, type PuppeteerStream } from 'puppeteer-stream';

import { env } from '../env.ts';
import type { BliveEvents } from './types.ts';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const LIVE_URL_PREFIX = 'https://live.bilibili.com';
const BILIBILI_LOGIN_URL = 'https://passport.bilibili.com/login';
const LIVE_PAGE_SETTLE_MS = 3_000;
const SEND_INTERVAL_MS = 5_000;
type BrowserPage = Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['newPage']>>;

export function createBlive(roomId: number) {
  let browser: Awaited<ReturnType<typeof launch>> | undefined;
  let livePage: BrowserPage | undefined;
  let mediaStream: PuppeteerStream | undefined;
  let ffmpeg: ChildProcess | undefined;
  let imageBuffer = Buffer.alloc(0);
  let audioSampleCount = 0;
  let imageIndex = 0;
  const emitter = createNanoEvents<BliveEvents>();
  const sendQueue = new PQueue({
    concurrency: 1,
    interval: SEND_INTERVAL_MS,
    intervalCap: 1,
  });

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

  const startBrowser = async () => {
    if (ffmpeg || browser || mediaStream) {
      throw new Error('Blive is already running');
    }

    imageBuffer = Buffer.alloc(0);
    audioSampleCount = 0;
    imageIndex = 0;
    browser = await launch(puppeteer, {
      headless: false,
      userDataDir: env.BROWSER_USER_DATA_DIR,
      defaultViewport: {
        width: 1280,
        height: 720,
      },
      args: [
        '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
        '--no-sandbox',
      ],
      startDelay: 500,
    });

    const page = await browser.newPage();
    livePage = page;
    await page.setUserAgent(BROWSER_USER_AGENT);
    await ensureBilibiliLogin(page, message => {
      emitter.emit('stderr', message);
    });
    await page.goto(`${LIVE_URL_PREFIX}/${roomId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await prepareLivePage(page);

    const stream = await getStream(page, {
      audio: true,
      video: true,
      mimeType: 'video/webm;codecs=vp8,opus',
      frameSize: 250,
      videoConstraints: {
        mandatory: {
          width: 1280,
          height: 720,
          frameRate: 15,
        },
      },
      retry: {
        each: 100,
        times: 5,
      },
    });
    mediaStream = stream;

    const process = createFFmpeg();
    ffmpeg = process;
    stream.pipe(process.stdin!);

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
      emitter.emit('stderr', chunk.toString());
    });

    process.on('error', error => {
      emitter.emit('error', error);
    });

    process.on('close', (code, signal) => {
      if (ffmpeg === process) {
        ffmpeg = undefined;
        imageBuffer = Buffer.alloc(0);
        audioSampleCount = 0;
        imageIndex = 0;
      }
      emitter.emit('close', code, signal);
    });
  };

  return {
    roomId,
    get running() {
      return ffmpeg !== undefined || mediaStream !== undefined || browser !== undefined;
    },
    onAudio: (callback: BliveEvents['audio']) => emitter.on('audio', callback),
    onImage: (callback: BliveEvents['image']) => emitter.on('image', callback),
    onError: (callback: BliveEvents['error']) => emitter.on('error', callback),
    onClose: (callback: BliveEvents['close']) => emitter.on('close', callback),
    onStderr: (callback: BliveEvents['stderr']) => emitter.on('stderr', callback),
    async start() {
      await startBrowser();
    },
    sendDanmaku(messages: readonly string[]) {
      return Promise.all(
        messages.map(message => sendQueue.add(() => sendDanmaku(livePage, message))),
      );
    },
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      const didSignalFFmpeg = ffmpeg?.kill(signal) ?? false;
      const stream = mediaStream;
      const activeBrowser = browser;
      mediaStream = undefined;
      browser = undefined;
      livePage = undefined;
      sendQueue.pause();
      sendQueue.clear();

      await stream?.stop().catch(error => {
        emitter.emit('error', toError(error));
      });
      stream?.destroy();
      await activeBrowser?.close().catch(error => {
        emitter.emit('error', toError(error));
      });
      await wss
        .then(server => server.close())
        .catch(error => {
          emitter.emit('error', toError(error));
        });

      return didSignalFFmpeg;
    },
  };
}

async function sendDanmaku(page: BrowserPage | undefined, message: string) {
  if (!page || page.isClosed()) {
    throw new Error('Cannot send danmaku before the live browser page is ready');
  }

  await page.bringToFront();
  const result = await page.evaluate(async message => {
    try {
      return await (globalThis as any).livePlayer?.sendDanmaku?.({ msg: message });
    } catch (error) {
      return {
        code: -1,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }, message);

  if (result?.code !== 0) {
    throw new Error(result?.message || result?.msg || 'Failed to send danmaku through livePlayer');
  }
}

async function ensureBilibiliLogin(page: BrowserPage, log: (message: string) => void) {
  await page.goto(LIVE_URL_PREFIX, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  if (await isBilibiliLoggedIn(page)) {
    log('Bilibili login state detected from browser profile');
    return;
  }

  log(`Bilibili login required; opening ${BILIBILI_LOGIN_URL}`);
  await page.goto(BILIBILI_LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await waitForBilibiliLogin(page, env.BILIBILI_LOGIN_TIMEOUT_MS);
  log('Bilibili login completed');
}

async function waitForBilibiliLogin(page: BrowserPage, timeoutMs: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isBilibiliLoggedIn(page)) {
      return;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for Bilibili login after ${timeoutMs}ms`);
}

async function isBilibiliLoggedIn(page: BrowserPage) {
  const cookies = await page.cookies(LIVE_URL_PREFIX, 'https://www.bilibili.com');
  const names = new Set(cookies.map(cookie => cookie.name));

  if (names.has('SESSDATA') && names.has('DedeUserID')) {
    return true;
  }

  return page.evaluate(`
    Boolean(
      document.querySelector('.header-entry-avatar')
        || document.querySelector('[class*="avatar"] img')
        || document.querySelector('[class*="user"] [class*="name"]')
    )
  `);
}

async function prepareLivePage(page: BrowserPage) {
  await page.waitForSelector('video', { timeout: 60_000 });
  await sleep(LIVE_PAGE_SETTLE_MS);
  await applyLivePageLayout(page);
  await page.evaluate(`
    for (const video of document.querySelectorAll('video')) {
      video.muted = false;
      video.volume = 1;
      void video.play();
    }
  `);
  await page.waitForFunction(
    `[...document.querySelectorAll('video')].some(video => video.readyState >= 2)`,
    { timeout: 60_000 },
  );
}

async function applyLivePageLayout(page: BrowserPage) {
  await page.evaluate(`
    document.body.classList.add('player-full-win');
    document.body.classList.add('hide-aside-area');

    const livePlayer = window.livePlayer;
    const safeCall = (callback) => {
      try {
        callback();
      } catch {
        // Ignore unstable livePlayer private API errors; CSS fallbacks below still apply.
      }
    };

    if (livePlayer) {
      safeCall(() => livePlayer.setFullscreenStatus?.(1));
      safeCall(() => livePlayer.changeCtrlVisible?.(false));
      safeCall(() => livePlayer.resize?.());
    }

    const styleId = 'dd-agent-live-page-layout';
    document.getElementById(styleId)?.remove();
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = [
      '#gift-control-vm { display: none !important; }',
      '#gift-control-panel-vm { display: none !important; }',
      '.gift-control-section { display: none !important; }',
      '.gift-panel { display: none !important; }',
      '.gift-section { display: none !important; }',
      '.bilibili-live-player-video-danmaku { display: none !important; }',
      '.web-player-danmaku { display: none !important; }',
      '.danmaku-screen { display: none !important; }',
      '.web-player-icon-roomStatus { display: none !important; }',
      '.web-player-controller-wrap { display: none !important; }',
      'body.player-full-win .player-section { bottom: 0 !important; }',
    ].join('\\n');
    document.head.append(style);
    window.dispatchEvent(new Event('resize'));
  `);
}

function createFFmpeg() {
  return spawn(
    'ffmpeg',
    [
      // 隐藏 FFmpeg 启动时的大段版本/编译信息，让 stderr 更干净
      '-hide_banner',

      // 日志等级：只输出 warning 及以上日志
      // 可选：error / warning / info / debug
      '-loglevel',
      'warning',

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

      // 输入地址：puppeteer-stream 录制当前浏览器 tab 后写入 stdin 的 WebM。
      '-i',
      'pipe:0',

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
      // stdio[0] = stdin：pipe，对应 pipe:0，用来接收浏览器录制的 WebM
      // stdio[1] = stdout：pipe，对应 pipe:1，用来读取 PCM 音频
      // stdio[2] = stderr：pipe，用来读取 FFmpeg 日志
      // stdio[3] = 额外 pipe，对应 pipe:3，用来读取 MJPEG 图片流
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    },
  );
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
