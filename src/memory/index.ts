import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { HearingFinalEvent } from '@/hearing/types.ts';
import type { VisionImageEvent } from '@/vision/types.ts';

import type { MemoryRecord, TimeRange } from './types.ts';

export * from './types.ts';

/** Bounded short-term memory containing hearing and vision observations. */
export function createMemory(retentionMs: number, visionDir: string) {
  const records: MemoryRecord[] = [];
  mkdirSync(visionDir, { recursive: true });

  function addHearing(event: HearingFinalEvent): void {
    add({
      type: 'hearing',
      startTimeMs: event.startTimeMs,
      endTimeMs: event.endTimeMs,
      text: event.text,
    });
  }

  function addVision(event: VisionImageEvent): void {
    const filePath = resolve(
      visionDir,
      `${event.endTimeMs}-${event.startTimeMs}-${Date.now()}.jpg`,
    );
    writeFileSync(filePath, event.buffer);
    add({
      type: 'vision',
      startTimeMs: event.startTimeMs,
      endTimeMs: event.endTimeMs,
      filePath,
    });
  }

  function query(range: TimeRange): MemoryRecord[] {
    validateRange(range);
    prune(range.endTimeMs);
    return records.filter(
      record => record.endTimeMs >= range.startTimeMs && record.startTimeMs <= range.endTimeMs,
    );
  }

  function getSize(): number {
    return records.length;
  }

  return {
    addHearing,
    addVision,
    query,
    getSize,
  };

  function add(record: MemoryRecord) {
    records.push(record);
    records.sort((left, right) => left.startTimeMs - right.startTimeMs);
    prune(record.endTimeMs);
  }

  function prune(nowMs: number) {
    const cutoff = nowMs - retentionMs;
    const firstRetained = records.findIndex(record => record.endTimeMs >= cutoff);

    if (firstRetained < 0) {
      for (const record of records) {
        removeVisionFile(record);
      }
      records.length = 0;
    } else if (firstRetained > 0) {
      for (const record of records.splice(0, firstRetained)) {
        removeVisionFile(record);
      }
    }
  }
}

function removeVisionFile(record: MemoryRecord) {
  if (record.type !== 'vision') {
    return;
  }

  try {
    unlinkSync(record.filePath);
  } catch {
    // The file may already have been removed during shutdown or recovery.
  }
}

function validateRange(range: TimeRange) {
  if (!Number.isFinite(range.startTimeMs) || !Number.isFinite(range.endTimeMs)) {
    throw new RangeError('Memory time range must contain finite timestamps');
  }

  if (range.startTimeMs > range.endTimeMs) {
    throw new RangeError('Memory startTimeMs must not be after endTimeMs');
  }
}
