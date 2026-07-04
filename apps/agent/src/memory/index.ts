import type { HearingFinalEvent } from '../hearing/types.ts';
import type { VisionImageEvent } from '../vision/types.ts';
import type { MemoryRecord, TimeRange } from './types.ts';

/** Bounded short-term memory containing hearing and vision observations. */
export function createMemory(retentionMs: number) {
  const records: MemoryRecord[] = [];

  return {
    addHearing(event: HearingFinalEvent) {
      add({
        type: 'hearing',
        startTimeMs: event.startTimeMs,
        endTimeMs: event.endTimeMs,
        text: event.text,
      });
    },
    addVision(event: VisionImageEvent) {
      add({
        type: 'vision',
        startTimeMs: event.startTimeMs,
        endTimeMs: event.endTimeMs,
        buffer: event.buffer,
      });
    },
    query(range: TimeRange) {
      validateRange(range);
      prune(range.endTimeMs);
      return records.filter(
        record => record.endTimeMs >= range.startTimeMs && record.startTimeMs <= range.endTimeMs,
      );
    },
    get size() {
      return records.length;
    },
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
      records.length = 0;
    } else if (firstRetained > 0) {
      records.splice(0, firstRetained);
    }
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
