import { createNanoEvents } from 'nanoevents';
import PQueue from 'p-queue';
import puppeteer, { type Browser, type Page } from 'puppeteer';

import type { DDConfig } from '@/config/index.ts';
import { createLogger } from '@/logger/index.ts';

import type { MouthEvents, MouthStatus, MouthStatusEvent } from './types.ts';

export * from './types.ts';

const LIVE_URL_PREFIX = 'https://live.bilibili.com/blanc';
const BILIBILI_LOGIN_URL = 'https://passport.bilibili.com/login';
const PAGE_TIMEOUT_MS = 60_000;
const SEND_INTERVAL_MS = 5_000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

export function createMouth(roomId: number, config: DDConfig) {
  const logger = createLogger({ prefix: 'mouth', prefixColor: 'yellow' });
  let browser: Browser | undefined;
  let livePage: Page | undefined;
  let status: MouthStatus = 'idle';
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopRequested = false;
  const emitter = createNanoEvents<MouthEvents>();
  const sendAbortController = new AbortController();
  const sendQueue = new PQueue({
    concurrency: 1,
    interval: SEND_INTERVAL_MS,
    intervalCap: 1,
  });

  const setStatus = (nextStatus: MouthStatus, message: string) => {
    status = nextStatus;
    logger.info(message);
    emitter.emit('status', { status: nextStatus, message } satisfies MouthStatusEvent);
  };

  const reportError = (error: unknown) => {
    const value = toError(error);
    logger.error(value);
    emitter.emit('error', value);
    return value;
  };

  const closeBrowser = async (activeBrowser: Browser | undefined) => {
    if (!activeBrowser) {
      return;
    }

    try {
      await activeBrowser.close();
    } catch (error) {
      reportError(error);
    }
  };

  const startBrowser = async () => {
    setStatus('starting', `Starting Bilibili danmaku browser for room ${roomId}`);
    let activeBrowser: Browser | undefined;

    try {
      activeBrowser = await puppeteer.launch({
        channel: 'chrome',
        headless: false,
        userDataDir: config.live.browserUserDataDir,
        defaultViewport: null,
        args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
      });

      if (stopRequested) {
        throw new Error('Mouth was stopped while the browser was starting');
      }

      browser = activeBrowser;
      logger.info(`浏览器已启动：${await activeBrowser.version()}`);
      const page = (await activeBrowser.pages())[0] ?? (await activeBrowser.newPage());
      livePage = page;
      await page.bringToFront();
      page.on('pageerror', error => {
        logger.warn(`页面脚本错误：${toError(error).message}`);
      });
      page.on('requestfailed', request => {
        logger.warn(`页面请求失败：${request.failure()?.errorText ?? 'unknown'} ${request.url()}`);
      });
      await page.setUserAgent({
        userAgent: BROWSER_USER_AGENT,
      });
      logger.info('页面已创建，准备检查登录状态');

      if (await isBilibiliLoggedIn(page)) {
        setStatus('authenticated', 'Bilibili login state detected from browser profile');
      } else {
        setStatus('login-required', `Bilibili login required; opening ${BILIBILI_LOGIN_URL}`);
        const response = await page.goto(BILIBILI_LOGIN_URL, {
          waitUntil: 'domcontentloaded',
          timeout: PAGE_TIMEOUT_MS,
        });
        logger.info(`登录页已响应：${response?.status() ?? '无响应状态'} ${page.url()}`);
        await waitForBilibiliLogin(page, config.live.loginTimeoutMs, () => stopRequested);
        setStatus('authenticated', 'Bilibili login completed');
      }

      if (stopRequested) {
        throw new Error('Mouth was stopped before the live room opened');
      }

      logger.info(`正在打开直播间：${roomId}`);
      const response = await page.goto(`${LIVE_URL_PREFIX}/${roomId}`, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT_MS,
      });
      logger.info(`直播间页面已响应：${response?.status() ?? '无响应状态'} ${page.url()}`);
      await page.waitForFunction(`typeof globalThis.livePlayer?.sendDanmaku === 'function'`, {
        timeout: PAGE_TIMEOUT_MS,
      });
      await startPlayback(page).catch(error => {
        logger.warn(`无法自动播放直播画面：${toError(error).message}`);
      });

      if (stopRequested) {
        throw new Error('Mouth was stopped before the live player became ready');
      }

      setStatus('ready', `Bilibili danmaku sender ready for room ${roomId}`);
    } catch (error) {
      if (browser === activeBrowser) {
        browser = undefined;
        livePage = undefined;
      }
      await closeBrowser(activeBrowser);

      const value = toError(error);
      if (!stopRequested) {
        setStatus('failed', value.message);
        emitter.emit('error', value);
      }
      throw value;
    }
  };

  function getStatus(): MouthStatus {
    return status;
  }

  function onStatus(callback: MouthEvents['status']) {
    return emitter.on('status', callback);
  }

  function onError(callback: MouthEvents['error']) {
    return emitter.on('error', callback);
  }

  function start(): Promise<void> {
    if (status === 'ready') {
      return Promise.resolve();
    }
    if (startPromise) {
      return startPromise;
    }
    if (stopRequested) {
      return Promise.reject(new Error('Cannot start a stopped mouth'));
    }

    const operation = startBrowser();
    startPromise = operation.finally(() => {
      if (startPromise === operation || status !== 'starting') {
        startPromise = undefined;
      }
    });
    return startPromise;
  }

  async function sendDanmaku(messages: readonly string[]) {
    if (status !== 'ready' || !livePage || livePage.isClosed()) {
      throw reportError(new Error('Cannot send danmaku before the mouth is ready'));
    }

    return Promise.all(
      messages.map(message =>
        sendQueue
          .add(
            async () => {
              await sendMessage(livePage, message);
              logger.success(`已发送弹幕：${message}`);
            },
            {
              signal: sendAbortController.signal,
            },
          )
          .catch(error => {
            const value = toError(error);
            if (!stopRequested) {
              emitter.emit('error', value);
            }
            throw value;
          }),
      ),
    );
  }

  function idle(): Promise<void> {
    return sendQueue.onIdle();
  }

  function stop(): Promise<void> {
    if (stopPromise) {
      return stopPromise;
    }

    stopPromise = stopMouth();
    return stopPromise;
  }

  async function stopMouth(): Promise<void> {
    stopRequested = true;
    setStatus('stopping', `Stopping Bilibili danmaku sender for room ${roomId}`);
    sendAbortController.abort(new Error('Mouth stopped'));

    const activeBrowser = browser;
    browser = undefined;
    livePage = undefined;
    await closeBrowser(activeBrowser);
    await startPromise?.catch(() => undefined);
    await sendQueue.onIdle();
    setStatus('stopped', `Bilibili danmaku sender stopped for room ${roomId}`);
  }

  return {
    roomId,
    getStatus,
    onStatus,
    onError,
    start,
    sendDanmaku,
    idle,
    stop,
  };
}

async function sendMessage(page: Page | undefined, message: string) {
  if (!page || page.isClosed()) {
    throw new Error('Cannot send danmaku because the Bilibili live page is closed');
  }

  const result = await page.evaluate(async message => {
    try {
      const root = globalThis as typeof globalThis & {
        livePlayer?: {
          sendDanmaku?: (payload: { msg: string }) => Promise<{
            code?: number;
            message?: string;
            msg?: string;
          }>;
        };
      };
      return await root.livePlayer?.sendDanmaku?.({ msg: message });
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

async function startPlayback(page: Page) {
  await page.waitForSelector('video', { timeout: PAGE_TIMEOUT_MS });
  await page.evaluate(async () => {
    const video = document.querySelector<HTMLVideoElement>('video');
    if (!video) {
      throw new Error('Bilibili live video element was not found');
    }

    await video.play();
  });
  await page.waitForFunction(
    () => {
      const video = document.querySelector<HTMLVideoElement>('video');
      return (
        video !== null && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused
      );
    },
    { timeout: PAGE_TIMEOUT_MS },
  );
}

async function waitForBilibiliLogin(page: Page, timeoutMs: number, isStopped: () => boolean) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (isStopped()) {
      throw new Error('Mouth was stopped while waiting for Bilibili login');
    }
    if (await isBilibiliLoggedIn(page)) {
      return;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for Bilibili login after ${timeoutMs}ms`);
}

async function isBilibiliLoggedIn(page: Page) {
  const cookies = await page.browserContext().cookies();
  const names = new Set(cookies.map(cookie => cookie.name));
  return names.has('SESSDATA') && names.has('DedeUserID');
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
