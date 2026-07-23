import type { BiliApiResponse } from './types.ts';

export class BiliApiError<T> extends Error {
  readonly code: number;
  readonly data: T;

  constructor(response: BiliApiResponse<T>) {
    super(response.message);
    this.name = 'BiliApiError';
    this.code = response.code;
    this.data = response.data;
  }
}

export type BiliApiRequestErrorKind = 'timeout' | 'network' | 'http' | 'invalid-response';

export class BiliApiRequestError extends Error {
  readonly kind: BiliApiRequestErrorKind;
  readonly status?: number;

  constructor(
    kind: BiliApiRequestErrorKind,
    message: string,
    options: { cause: Error; status?: number },
  ) {
    super(message, { cause: options.cause });
    this.name = 'BiliApiRequestError';
    this.kind = kind;
    this.status = options.status;
  }
}

export class RoomNotLiveError extends Error {
  readonly roomId: number;

  constructor(roomId: number) {
    super(`直播间 ${roomId} 当前未开播`);
    this.name = 'RoomNotLiveError';
    this.roomId = roomId;
  }
}
