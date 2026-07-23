import ky, { HTTPError, NetworkError, TimeoutError } from 'ky';

import { BiliApiError, BiliApiRequestError } from './errors.ts';
import type {
  BiliApiResponse,
  LiveRoomInfo,
  LiveRoomUserInfo,
  PlayerInfo,
  RoomUserInfo,
} from './types.ts';

export * from './types.ts';
export * from './errors.ts';

const api = ky.create({
  prefix: 'https://api.live.bilibili.com',
  headers: {
    Accept: 'application/json',
  },
});

const PLAY_INFO_PARAMS = {
  protocol: '0,1',
  format: '0,1,2',
  codec: '0,1,2',
  qn: 10000,
  platform: 'web',
  ptype: 8,
  dolby: 5,
  panoramic: 1,
} as const;

export interface BiliApiRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retryLimit?: number;
  retryBackoffMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_LIMIT = 2;
const DEFAULT_RETRY_BACKOFF_MS = 300;
const RETRYABLE_STATUS_CODES = [408, 425, 429, 500, 502, 503, 504];

/** Fetches live-room information and resolves short room ids. */
export async function fetchRoomInfo(roomId: number, options: BiliApiRequestOptions = {}) {
  const response = await request<BiliApiResponse<LiveRoomInfo>>(
    'room/v1/Room/get_info',
    { id: roomId },
    options,
  );

  return unwrap(response);
}

export async function isRoomLive(roomId: number, options: BiliApiRequestOptions = {}) {
  return (await fetchRoomInfo(roomId, options)).live_status === 1;
}

/** Fetches the streamer information associated with a live room. */
export async function fetchRoomUserInfo(
  roomId: number,
  options: BiliApiRequestOptions = {},
): Promise<RoomUserInfo> {
  const room = await fetchRoomInfo(roomId, options);
  const searchParams = new URLSearchParams();
  searchParams.append('uids[]', String(room.uid));

  const response = await request<BiliApiResponse<Record<string, LiveRoomUserInfo>>>(
    'room/v1/Room/get_status_info_by_uids',
    searchParams,
    options,
  );
  const users = unwrap(response);
  const user = users[String(room.uid)];

  if (!user) {
    throw new Error(`Missing live-room user info for UID ${room.uid}`);
  }

  return { room, user };
}

/** Fetches stream playback information for a live room. */
export async function fetchPlayInfo(roomId: number, options: BiliApiRequestOptions = {}) {
  const response = await request<BiliApiResponse<PlayerInfo>>(
    'xlive/web-room/v2/index/getRoomPlayInfo',
    {
      ...PLAY_INFO_PARAMS,
      room_id: roomId,
    },
    options,
  );

  return unwrap(response);
}

/** Resolves the preferred AVC FLV stream URL for FFmpeg. */
export async function fetchFlvPlayInfo(roomId: number, options: BiliApiRequestOptions = {}) {
  const playInfo = await fetchPlayInfo(roomId, options);
  const flvStream = playInfo.playurl_info?.playurl.stream.find(
    item => item.protocol_name === 'http_stream',
  );
  const flvFormat = flvStream?.format.find(format => format.format_name === 'flv');

  if (!flvFormat) {
    throw new Error(`Missing FLV stream info for room ${roomId}`);
  }

  const codec =
    flvFormat.codec.find(item => item.codec_name.toLowerCase() === 'avc') ?? flvFormat.codec[0];
  const urlInfo = codec?.url_info[0];

  if (!codec || !urlInfo) {
    throw new Error(`Missing FLV URL info for room ${roomId}`);
  }

  return `${urlInfo.host}${codec.base_url}${urlInfo.extra}`;
}

function unwrap<T>(response: BiliApiResponse<T>) {
  if (response.code !== 0) {
    throw new BiliApiError(response);
  }

  return response.data;
}

async function request<T>(
  path: string,
  searchParams: URLSearchParams | Record<string, string | number>,
  options: BiliApiRequestOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const retryLimit = options.retryLimit ?? DEFAULT_RETRY_LIMIT;
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

  try {
    return await api
      .get(path, {
        searchParams,
        signal: options.signal,
        timeout: timeoutMs,
        retry: {
          limit: retryLimit,
          methods: ['get'],
          statusCodes: RETRYABLE_STATUS_CODES,
          afterStatusCodes: [429, 503],
          backoffLimit: retryBackoffMs * 4,
          delay: attemptCount => retryBackoffMs * 2 ** (attemptCount - 1),
          jitter: true,
          retryOnTimeout: true,
        },
      })
      .json<T>();
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    throw classifyRequestError(error, path);
  }
}

function classifyRequestError(error: unknown, path: string): BiliApiRequestError {
  if (error instanceof TimeoutError) {
    return new BiliApiRequestError('timeout', `Bilibili API request timed out: ${path}`, {
      cause: error,
    });
  }
  if (error instanceof HTTPError) {
    return new BiliApiRequestError('http', `Bilibili API HTTP ${error.response.status}: ${path}`, {
      cause: error,
      status: error.response.status,
    });
  }
  if (error instanceof NetworkError) {
    return new BiliApiRequestError('network', `Bilibili API network request failed: ${path}`, {
      cause: error,
    });
  }

  return new BiliApiRequestError('invalid-response', `Invalid Bilibili API response: ${path}`, {
    cause: error instanceof Error ? error : new Error(String(error)),
  });
}
