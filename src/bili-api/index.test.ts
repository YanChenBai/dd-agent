import { NetworkError, TimeoutError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('ky', async importOriginal => ({
  ...(await importOriginal()),
  default: {
    create: () => ({ get: mocks.get }),
  },
}));

import { BiliApiError, BiliApiRequestError, fetchRoomInfo, isRoomLive } from './index.ts';

describe('Bilibili API requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses explicit timeout and bounded exponential retry options', async () => {
    mockResponse(roomResponse(1));

    await fetchRoomInfo(1, {
      timeoutMs: 1_500,
      retryLimit: 3,
      retryBackoffMs: 250,
    });

    expect(mocks.get).toHaveBeenCalledOnce();
    const requestOptions = mocks.get.mock.calls[0]?.[1];
    expect(requestOptions).toMatchObject({
      timeout: 1_500,
      retry: {
        limit: 3,
        methods: ['get'],
        retryOnTimeout: true,
        backoffLimit: 1_000,
      },
    });
    expect(requestOptions.retry.delay(1)).toBe(250);
    expect(requestOptions.retry.delay(3)).toBe(1_000);
  });

  it('reports live status without converting request failures to offline', async () => {
    mockResponse(roomResponse(0));
    await expect(isRoomLive(1)).resolves.toBe(false);

    const timeout = new TimeoutError(new Request('https://api.live.bilibili.com/test'));
    mockFailure(timeout);
    await expect(isRoomLive(1)).rejects.toMatchObject({
      name: 'BiliApiRequestError',
      kind: 'timeout',
    });
  });

  it('keeps Bilibili business errors distinct from transport errors', async () => {
    mockResponse({ code: -400, message: 'bad request', ttl: 1, data: {} });

    const error = await fetchRoomInfo(1).catch(value => value);

    expect(error).toBeInstanceOf(BiliApiError);
    expect(error).not.toBeInstanceOf(BiliApiRequestError);
    expect(error).toMatchObject({ code: -400, message: 'bad request' });
  });

  it('classifies exhausted network failures', async () => {
    const request = new Request('https://api.live.bilibili.com/test');
    mockFailure(new NetworkError(request, { cause: new Error('connection reset') }));

    await expect(fetchRoomInfo(1)).rejects.toMatchObject({
      name: 'BiliApiRequestError',
      kind: 'network',
    });
  });

  it('preserves caller cancellation instead of wrapping it as a network failure', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled by caller');
    controller.abort(reason);
    mockFailure(reason);

    await expect(fetchRoomInfo(1, { signal: controller.signal })).rejects.toBe(reason);
  });
});

function mockResponse(value: unknown) {
  mocks.get.mockReturnValue({
    json: vi.fn(async () => value),
  });
}

function mockFailure(error: Error) {
  mocks.get.mockReturnValue({
    json: vi.fn(async () => {
      throw error;
    }),
  });
}

function roomResponse(liveStatus: number) {
  return {
    code: 0,
    message: 'ok',
    ttl: 1,
    data: {
      uid: 10,
      room_id: 1,
      short_id: 0,
      title: '测试直播间',
      description: '',
      live_status: liveStatus,
      area_name: '测试分区',
      parent_area_name: '测试父分区',
    },
  };
}
