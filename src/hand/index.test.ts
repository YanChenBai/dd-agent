import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createDefaultConfig } from '@/config/index.ts';

const { launch, page } = vi.hoisted(() => {
  const page = {
    bringToFront: vi.fn(async () => undefined),
    browserContext: vi.fn(() => ({
      cookies: vi.fn(async () => [{ name: 'SESSDATA' }, { name: 'DedeUserID' }]),
    })),
    evaluate: vi.fn(async (callback: (argument?: string) => unknown, argument?: string) =>
      argument === undefined ? undefined : callback(argument),
    ),
    goto: vi.fn(async () => ({ status: () => 200 })),
    isClosed: vi.fn(() => false),
    on: vi.fn(),
    setUserAgent: vi.fn(async () => undefined),
    url: vi.fn(() => 'https://live.bilibili.com/blanc/1'),
    waitForFunction: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => undefined),
  };
  const browser = {
    close: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page),
    pages: vi.fn(async () => [page]),
    version: vi.fn(async () => 'Chrome/Test'),
  };
  return {
    launch: vi.fn(async () => browser),
    page,
  };
});

vi.mock('puppeteer', () => ({
  default: { launch },
}));

import { createHand } from './index.ts';

describe('createHand', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('accepts a void return from livePlayer.sendDanmaku as success', async () => {
    const sendDanmaku = vi.fn(async () => undefined);
    vi.stubGlobal('livePlayer', { sendDanmaku });
    const hand = createHand(1, createDefaultConfig());

    await hand.start();
    await expect(hand.sendDanmaku(['hello'])).resolves.toEqual([undefined]);
    expect(sendDanmaku).toHaveBeenCalledWith({ msg: 'hello' });
    expect(page.evaluate).toHaveBeenCalled();
    expect(hand.getStats()).toMatchObject({
      attemptedMessages: 1,
      sentMessages: 1,
      failedMessages: 0,
    });

    await hand.stop();
  });
});
