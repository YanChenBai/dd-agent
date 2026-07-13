import type { createMemory } from './index.ts';

export type MemoryRecord =
  | {
      type: 'hearing';
      startTimeMs: number;
      endTimeMs: number;
      text: string;
    }
  | {
      type: 'vision';
      startTimeMs: number;
      endTimeMs: number;
      filePath: string;
    };

export interface TimeRange {
  startTimeMs: number;
  endTimeMs: number;
}

export type Memory = ReturnType<typeof createMemory>;
