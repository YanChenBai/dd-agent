import puppeteer, { type Browser, type Page } from 'puppeteer';

import type { DDConfig } from '../../config/index.ts';
import type { LiveAreaBatch, LiveRoomCandidate } from './types.ts';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const LIVE_ROOM_URL_PATTERN = /^https:\/\/live\.bilibili\.com\/(?:blanc\/)?(\d+)(?:[/?#].*)?$/;
const MAX_SCROLL_ATTEMPTS = 20;
const MAX_STAGNANT_SCROLLS = 3;

export function createLiveAreaSource(areaUrl: string, config: DDConfig) {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let closePromise: Promise<void> | undefined;
  let batchNumber = 1;
  const seenRoomIds = new Set<number>();

  async function refresh(limit: number): Promise<LiveAreaBatch> {
    batchNumber = 1;
    seenRoomIds.clear();
    return collectAreaBatch(limit);
  }

  async function loadMore(limit: number): Promise<LiveAreaBatch> {
    batchNumber += 1;
    return collectAreaBatch(limit);
  }

  function close(): Promise<void> {
    if (closePromise) {
      return closePromise;
    }

    const activeBrowser = browser;
    browser = undefined;
    page = undefined;
    if (!activeBrowser) {
      return Promise.resolve();
    }

    const operation = activeBrowser.close().finally(() => {
      if (closePromise === operation) {
        closePromise = undefined;
      }
    });
    closePromise = operation;
    return operation;
  }

  return {
    getBatchNumber: () => batchNumber,
    loadMore,
    refresh,
    close,
  };

  async function getPage() {
    if (page && !page.isClosed()) {
      return page;
    }

    browser = await puppeteer.launch({
      channel: 'chrome',
      headless: false,
      userDataDir: `${config.live.browserUserDataDir}-explore`,
      defaultViewport: null,
      args: ['--start-maximized'],
    });

    page = (await browser.pages())[0] ?? (await browser.newPage());

    await page.setUserAgent({
      userAgent: BROWSER_USER_AGENT,
      platform: 'Windows',
    });
    return page;
  }

  async function collectBatch(activePage: Page, limit: number): Promise<LiveAreaBatch> {
    const candidates = await collectCandidates(activePage, limit, seenRoomIds);
    for (const candidate of candidates) {
      seenRoomIds.add(candidate.roomId);
    }
    return { batch: batchNumber, candidates };
  }

  async function collectAreaBatch(limit: number): Promise<LiveAreaBatch> {
    const activePage = await getPage();
    try {
      await activePage.goto(withoutPageParameter(areaUrl), {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await activePage.bringToFront();
      await activePage.evaluate(() => window.scrollTo(0, 0));
      await sleep(1_000);
      return await collectBatch(activePage, limit);
    } finally {
      await close();
    }
  }
}

async function collectCandidates(page: Page, limit: number, excludedRoomIds: ReadonlySet<number>) {
  const candidates = new Map<number, LiveRoomCandidate>();
  const observedRoomIds = new Set<number>();
  let stagnantScrolls = 0;

  for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt += 1) {
    const previousObservedSize = observedRoomIds.size;
    for (const candidate of await extractCandidates(page)) {
      observedRoomIds.add(candidate.roomId);
      if (!excludedRoomIds.has(candidate.roomId)) {
        candidates.set(candidate.roomId, candidate);
      }
    }

    if (candidates.size >= limit) {
      break;
    }

    stagnantScrolls = observedRoomIds.size === previousObservedSize ? stagnantScrolls + 1 : 0;
    if (stagnantScrolls >= MAX_STAGNANT_SCROLLS) {
      break;
    }

    await scrollPage(page);
    await sleep(1_000);
  }

  return [...candidates.values()].slice(0, limit);
}

function withoutPageParameter(areaUrl: string) {
  const url = new URL(areaUrl);
  url.searchParams.delete('page');
  return url.toString();
}

async function extractCandidates(page: Page) {
  const rawCandidates = await page.evaluate(() => {
    return [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].map(anchor => {
      const href = anchor.href;
      const card =
        anchor.closest('[class*="room"], [class*="card"], [class*="item"], li') ?? anchor;
      const text = (card.textContent ?? anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
      const image = card.querySelector<HTMLImageElement>('img');
      return {
        href,
        imageAlt: image?.alt?.trim() ?? '',
        text,
      };
    });
  });

  const seen = new Set<number>();
  const candidates: LiveRoomCandidate[] = [];

  for (const item of rawCandidates) {
    const match = LIVE_ROOM_URL_PATTERN.exec(item.href);
    if (!match) {
      continue;
    }

    const roomId = Number(match[1]);
    if (!Number.isSafeInteger(roomId) || seen.has(roomId)) {
      continue;
    }

    const title = pickTitle(item.text, item.imageAlt);
    if (!title) {
      continue;
    }

    seen.add(roomId);
    candidates.push({
      roomId,
      title,
      anchor: item.imageAlt || '未知主播',
    });
  }

  return candidates;
}

async function scrollPage(page: Page) {
  await page.evaluate(() => {
    window.scrollTo({
      top: document.scrollingElement?.scrollHeight ?? document.documentElement.scrollHeight,
      behavior: 'auto',
    });
  });
}

function pickTitle(text: string, imageAlt: string) {
  const value = imageAlt || text;
  return value.slice(0, 80).trim();
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
