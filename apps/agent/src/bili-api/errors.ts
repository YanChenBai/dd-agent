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
