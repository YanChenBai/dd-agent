import { createNanoEvents } from 'nanoevents';
import sharp from 'sharp';

import type { Blive } from '../blive-stream/types.ts';
import type { VisionEvents, VisionFrame, VisionOptions } from './types.ts';

const FRAME_COUNT = 4;
const DEFAULT_INTERVAL_MS = 20_000;
const BACKGROUND = { r: 0, g: 0, b: 0 } as const;

/** Keeps the four most recent live frames and periodically emits a 2x2 JPEG contact sheet. */
export function startVision(blive: Blive, options: VisionOptions = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('Vision intervalMs must be greater than 0');
  }

  const emitter = createNanoEvents<VisionEvents>();
  const frames: VisionFrame[] = [];
  let stopped = false;
  let composing: Promise<void> | undefined;

  const unbindImage = blive.onImage((buffer, timing) => {
    frames.push({ buffer, ...timing });

    if (frames.length > FRAME_COUNT) {
      frames.shift();
    }
  });

  const timer = setInterval(() => {
    if (stopped || composing || frames.length < FRAME_COUNT) {
      return;
    }

    const snapshot = frames.map(frame => ({ ...frame, buffer: Buffer.from(frame.buffer) }));
    composing = mergeFourImages(snapshot.map(frame => frame.buffer))
      .then(buffer => {
        if (!stopped) {
          emitter.emit('image', {
            buffer,
            frames: snapshot,
            startTimeMs: snapshot[0]!.receivedAtMs,
            endTimeMs: snapshot.at(-1)!.receivedAtMs,
            mediaStartMs: snapshot[0]!.mediaStartMs,
            mediaEndMs: snapshot.at(-1)!.mediaEndMs,
          });
        }
      })
      .catch(error => {
        if (!stopped) {
          emitter.emit('error', toError(error));
        }
      })
      .finally(() => {
        composing = undefined;
      });
  }, intervalMs);

  return {
    onImage: (callback: VisionEvents['image']) => emitter.on('image', callback),
    onError: (callback: VisionEvents['error']) => emitter.on('error', callback),
    async stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      clearInterval(timer);
      unbindImage();
      await composing;
    },
  };
}

/** Combines exactly four images into a normalized 2x2 JPEG contact sheet. */
export async function mergeFourImages(images: readonly Buffer[]) {
  if (images.length !== FRAME_COUNT) {
    throw new RangeError(`Expected exactly ${FRAME_COUNT} images, received ${images.length}`);
  }

  const metadata = await Promise.all(images.map(image => sharp(image).metadata()));
  const cellWidth = Math.max(...metadata.map(item => item.width ?? 0));
  const cellHeight = Math.max(...metadata.map(item => item.height ?? 0));

  if (cellWidth === 0 || cellHeight === 0) {
    throw new Error('Unable to determine the dimensions of one or more vision frames');
  }

  const normalized = await Promise.all(
    images.map(image =>
      sharp(image)
        .resize(cellWidth, cellHeight, {
          fit: 'contain',
          background: BACKGROUND,
        })
        .jpeg()
        .toBuffer(),
    ),
  );

  return sharp({
    create: {
      width: cellWidth * 2,
      height: cellHeight * 2,
      channels: 3,
      background: BACKGROUND,
    },
  })
    .composite(
      normalized.map((input, index) => ({
        input,
        left: (index % 2) * cellWidth,
        top: Math.floor(index / 2) * cellHeight,
      })),
    )
    .jpeg({ quality: 85 })
    .toBuffer();
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
