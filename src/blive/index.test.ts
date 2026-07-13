import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  fetchFlvPlayInfo: vi.fn<(roomId: number) => Promise<string>>(),
  spawn: vi.fn(),
}));

vi.mock('../bili-api/index.ts', () => ({
  fetchFlvPlayInfo: mocks.fetchFlvPlayInfo,
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

import { createBlive } from './index.ts';

interface FakeFFmpeg extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  image: PassThrough;
  stdio: Array<PassThrough | null>;
  kill: ReturnType<typeof vi.fn>;
}

const ROOM_ID = 24_680;
const FLV_URL = 'https://cdn.example.test/live.flv?expires=123';

describe('createBlive', () => {
  let ffmpeg: FakeFFmpeg;

  beforeEach(() => {
    vi.clearAllMocks();
    ffmpeg = createFakeFFmpeg();
    mocks.fetchFlvPlayInfo.mockResolvedValue(FLV_URL);
    mocks.spawn.mockReturnValue(ffmpeg as unknown as ChildProcess);
  });

  afterEach(() => {
    vi.useRealTimers();
    ffmpeg.stdout.destroy();
    ffmpeg.stderr.destroy();
    ffmpeg.image.destroy();
  });

  it('fetches the FLV URL with the runtime room id and starts FFmpeg with it', async () => {
    const blive = createBlive(ROOM_ID);

    await blive.start();

    expect(mocks.fetchFlvPlayInfo).toHaveBeenCalledOnce();
    expect(mocks.fetchFlvPlayInfo).toHaveBeenCalledWith(ROOM_ID);
    expect(mocks.spawn).toHaveBeenCalledOnce();

    const [command, args] = getSpawnCall();
    const inputIndex = args.indexOf('-i');
    expect(command).toBe('ffmpeg');
    expect(inputIndex).toBeGreaterThan(-1);
    expect(args[inputIndex + 1]).toBe(FLV_URL);
  });

  it('places the Bilibili HTTP headers before the FLV input and ignores stdin', async () => {
    await createBlive(ROOM_ID).start();

    const [, args, options] = getSpawnCall();
    const inputIndex = args.indexOf('-i');
    const userAgentIndex = args.indexOf('-user_agent');
    const refererIndex = args.indexOf('-referer');
    const headersIndex = args.indexOf('-headers');

    expect(userAgentIndex).toBeGreaterThan(-1);
    expect(refererIndex).toBeGreaterThan(-1);
    expect(headersIndex).toBeGreaterThan(-1);
    expect(userAgentIndex).toBeLessThan(inputIndex);
    expect(refererIndex).toBeLessThan(inputIndex);
    expect(headersIndex).toBeLessThan(inputIndex);
    expect(args[userAgentIndex + 1]).toContain('Mozilla/5.0');
    expect(args[refererIndex + 1]).toBe(`https://live.bilibili.com/${ROOM_ID}`);
    expect(args[headersIndex + 1]).toBe('Origin: https://live.bilibili.com\r\n');
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe', 'pipe']);
  });

  it('kills the active FFmpeg process when stopped', async () => {
    const blive = createBlive(ROOM_ID);
    await blive.start();

    expect(blive.stop()).toBe(true);
    expect(ffmpeg.kill).toHaveBeenCalledOnce();
    expect(ffmpeg.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('emits continuous PCM timing derived from 16 kHz s16le samples', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(123_456);
    const blive = createBlive(ROOM_ID);
    const onAudio = vi.fn();
    blive.onAudio(onAudio);
    await blive.start();

    const first = Buffer.alloc(3_200);
    const second = Buffer.alloc(1_600);
    ffmpeg.stdout.emit('data', first);
    ffmpeg.stdout.emit('data', second);

    expect(onAudio).toHaveBeenNthCalledWith(1, first, {
      receivedAtMs: 123_456,
      mediaStartMs: 0,
      mediaEndMs: 100,
    });
    expect(onAudio).toHaveBeenNthCalledWith(2, second, {
      receivedAtMs: 123_456,
      mediaStartMs: 100,
      mediaEndMs: 150,
    });
  });
});

function createFakeFFmpeg(): FakeFFmpeg {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const image = new PassThrough();

  return Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    image,
    stdio: [null, stdout, stderr, image],
    kill: vi.fn(() => true),
  });
}

function getSpawnCall() {
  return mocks.spawn.mock.calls[0] as unknown as [
    command: string,
    args: string[],
    options: { stdio: string[] },
  ];
}
