import { createNanoEvents } from 'nanoevents';
import PQueue from 'p-queue';
import puppeteer, { type Browser, type Page } from 'puppeteer';

import type { DDConfig } from '@/config/index.ts';
import { createLogger } from '@/logger/index.ts';
import { withComponent, type RoomContext } from '@/observability/context.ts';

import type { HandEvents, HandStats, HandStatus, HandStatusEvent } from './types.ts';

export * from './types.ts';

const LIVE_URL_PREFIX = 'https://live.bilibili.com/blanc';
const BILIBILI_LOGIN_URL = 'https://passport.bilibili.com/login';
const PAGE_TIMEOUT_MS = 60_000;
const SEND_INTERVAL_MS = 5_000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

export function createHand(roomId: number, config: DDConfig, context?: RoomContext) {
  const logger = createLogger({
    prefix: 'hand',
    prefixColor: 'yellow',
    context: context ? withComponent(context, 'hand') : undefined,
  });
  let browser: Browser | undefined;
  let livePage: Page | undefined;
  let status: HandStatus = 'idle';
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopRequested = false;
  let attemptedMessages = 0;
  let sentMessages = 0;
  let failedMessages = 0;
  const emitter = createNanoEvents<HandEvents>();
  const sendAbortController = new AbortController();
  const sendQueue = new PQueue({
    concurrency: 1,
    interval: SEND_INTERVAL_MS,
    intervalCap: 1,
  });

  const setStatus = (nextStatus: HandStatus, message: string) => {
    status = nextStatus;
    logger.info(message);
    emitter.emit('status', { status: nextStatus, message } satisfies HandStatusEvent);
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
        args: ['--autoplay-policy=no-user-gesture-required'],
      });

      if (stopRequested) {
        throw new Error('Hand was stopped while the browser was starting');
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
        throw new Error('Hand was stopped before the live room opened');
      }

      logger.info(`正在打开直播间：${roomId}`);
      const response = await page.goto(`${LIVE_URL_PREFIX}/${roomId}`, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT_MS,
      });
      logger.info(`直播间页面已响应：${response?.status() ?? '无响应状态'} ${page.url()}`);
      await page.waitForFunction(`typeof window.livePlayer?.sendDanmaku === 'function'`, {
        timeout: PAGE_TIMEOUT_MS,
      });
      await startPlayback(page).catch(error => {
        logger.warn(`无法自动播放直播画面：${toError(error).message}`);
      });

      if (stopRequested) {
        throw new Error('Hand was stopped before the live player became ready');
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

  function getStatus(): HandStatus {
    return status;
  }

  function getStats(): HandStats {
    return {
      queuedMessages: sendQueue.size,
      activeMessages: sendQueue.pending,
      attemptedMessages,
      sentMessages,
      failedMessages,
    };
  }

  function onStatus(callback: HandEvents['status']) {
    return emitter.on('status', callback);
  }

  function onError(callback: HandEvents['error']) {
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
      return Promise.reject(new Error('Cannot start a stopped hand'));
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
      throw reportError(new Error('Cannot send danmaku before the hand is ready'));
    }

    return Promise.all(
      messages.map(message =>
        sendQueue
          .add(
            async () => {
              attemptedMessages += 1;
              try {
                await sendMessage(livePage, message);
                sentMessages += 1;
                logger.success(`已发送弹幕：${message}`);
              } catch (error) {
                failedMessages += 1;
                throw error;
              }
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

    stopPromise = stopHand();
    return stopPromise;
  }

  async function stopHand(): Promise<void> {
    stopRequested = true;
    setStatus('stopping', `Stopping Bilibili danmaku sender for room ${roomId}`);
    sendAbortController.abort(new Error('Hand stopped'));

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
    getStats,
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
    const root = globalThis as typeof globalThis & {
      livePlayer?: {
        sendDanmaku?: (payload: { msg: string }) => Promise<{
          code?: number;
          message?: string;
          msg?: string;
        } | void>;
      };
    };
    const sendDanmaku = root.livePlayer?.sendDanmaku;
    if (typeof sendDanmaku !== 'function') {
      return {
        ok: false as const,
        error: 'Bilibili livePlayer.sendDanmaku is unavailable',
      };
    }

    try {
      const response = await sendDanmaku.call(root.livePlayer, { msg: message });
      if (response?.code !== undefined && response.code !== 0) {
        return {
          ok: false as const,
          error:
            response.message ||
            response.msg ||
            `Bilibili rejected danmaku with code ${response.code}`,
        };
      }
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, message);

  if (!result.ok) {
    throw new Error(result.error);
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
      throw new Error('Hand was stopped while waiting for Bilibili login');
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
