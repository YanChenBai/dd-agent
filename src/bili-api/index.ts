import ky from 'ky';

import { BiliApiError } from './errors.ts';
import type {
  BiliApiResponse,
  LiveRoomInfo,
  LiveRoomUserInfo,
  PlayerInfo,
  RoomUserInfo,
} from './types.ts';

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

/** Fetches live-room information and resolves short room ids. */
export async function fetchRoomInfo(roomId: number) {
  const response = await api
    .get('room/v1/Room/get_info', {
      searchParams: { id: roomId },
    })
    .json<BiliApiResponse<LiveRoomInfo>>();

  return unwrap(response);
}

/** Fetches the streamer information associated with a live room. */
export async function fetchRoomUserInfo(roomId: number): Promise<RoomUserInfo> {
  const room = await fetchRoomInfo(roomId);
  const searchParams = new URLSearchParams();
  searchParams.append('uids[]', String(room.uid));

  const response = await api
    .get('room/v1/Room/get_status_info_by_uids', { searchParams })
    .json<BiliApiResponse<Record<string, LiveRoomUserInfo>>>();
  const users = unwrap(response);
  const user = users[String(room.uid)];

  if (!user) {
    throw new Error(`Missing live-room user info for UID ${room.uid}`);
  }

  return { room, user };
}

/** Fetches stream playback information for a live room. */
export async function fetchPlayInfo(roomId: number) {
  const response = await api
    .get('xlive/web-room/v2/index/getRoomPlayInfo', {
      searchParams: {
        ...PLAY_INFO_PARAMS,
        room_id: roomId,
      },
    })
    .json<BiliApiResponse<PlayerInfo>>();

  return unwrap(response);
}

/** Resolves the preferred AVC FLV stream URL for FFmpeg. */
export async function fetchFlvPlayInfo(roomId: number) {
  const playInfo = await fetchPlayInfo(roomId);
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
