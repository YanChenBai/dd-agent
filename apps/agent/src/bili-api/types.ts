export interface BiliApiResponse<T> {
  code: number;
  message: string;
  ttl: number;
  data: T;
}

export interface LiveRoomInfo {
  uid: number;
  room_id: number;
  short_id: number;
  title: string;
  description: string;
  live_status: number;
  area_name: string;
  parent_area_name: string;
}

export interface LiveRoomUserInfo {
  uid: number;
  uname: string;
  face: string;
  room_id: number;
  title: string;
  live_status: number;
}

export interface RoomUserInfo {
  room: LiveRoomInfo;
  user: LiveRoomUserInfo;
}

export enum LiveStatusEnum {
  LIVE,
  OFFLINE,
  RECORD,
}

export type PlayerInfo =
  | (PlayerInfoBase<LiveStatusEnum.LIVE> & { playurl_info: PlayUrlInfo })
  | (PlayerInfoBase<LiveStatusEnum.OFFLINE | LiveStatusEnum.RECORD> & { playurl_info: null });

interface PlayerInfoBase<TStatus extends LiveStatusEnum> {
  room_id: number;
  short_id: number;
  uid: number;
  live_status: TStatus;
}

export interface PlayUrlInfo {
  conf_json: string;
  playurl: Playurl;
}

export interface Playurl {
  stream: Stream[];
}

export interface Stream {
  protocol_name: string;
  format: Format[];
}

export interface Format {
  format_name: string;
  codec: Codec[];
}

export interface Codec {
  codec_name: string;
  base_url: string;
  url_info: UrlInfo[];
}

export interface UrlInfo {
  host: string;
  extra: string;
  stream_ttl: number;
}
