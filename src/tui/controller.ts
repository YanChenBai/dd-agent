import { createApp } from '@vue-tui/runtime';
import { reactive } from 'vue';

import type { RoomUserInfo } from '../bili-api/types.ts';
import type { DanmakuEvent } from '../brain/types.ts';
import type { HearingFinalEvent } from '../hearing/types.ts';
import type { VisionImageEvent } from '../vision/types.ts';
import DashboardApp from './DashboardApp.vue';
import type {
  BrainDashboardEntry,
  DanmakuDelivery,
  DashboardModule,
  DashboardState,
} from './types.ts';

export const DEFAULT_ENTRY_LIMIT = 8;

export interface DashboardOptions {
  entryLimit?: number;
}

export function createDashboard(roomInfo: RoomUserInfo, options: DashboardOptions = {}) {
  const entryLimit = options.entryLimit ?? DEFAULT_ENTRY_LIMIT;
  const state = reactive<DashboardState>({
    roomInfo,
    startedAtMs: Date.now(),
    brain: [],
    hearing: [],
    vision: [],
    errors: [],
  });
  const app = createApp(DashboardApp, { state });
  let nextId = 0;
  let mounted = false;

  return {
    state,
    mount() {
      if (!mounted) {
        app.mount({
          alternateScreen: true,
          exitOnCtrlC: false,
          patchConsole: false,
          rawMode: 'auto',
        });
        mounted = true;
      }
    },
    unmount() {
      if (mounted) {
        app.unmount();
        mounted = false;
      }
    },
    addDanmaku(event: DanmakuEvent, willSend: boolean) {
      const entries: BrainDashboardEntry[] = [];
      for (const message of event.messages) {
        const entry: BrainDashboardEntry = {
          id: nextId++,
          delivery: willSend ? 'pending' : 'preview',
          message,
          startTimeMs: event.startTimeMs,
          endTimeMs: event.endTimeMs,
        };
        appendLimited(state.brain, entry, entryLimit);
        entries.push(entry);
      }
      return entries;
    },
    setDanmakuDelivery(entries: readonly BrainDashboardEntry[], delivery: DanmakuDelivery) {
      for (const entry of entries) {
        entry.delivery = delivery;
      }
    },
    addHearing(event: HearingFinalEvent) {
      appendLimited(
        state.hearing,
        {
          id: nextId++,
          index: event.index,
          text: event.text,
          startTimeMs: event.startTimeMs,
          endTimeMs: event.endTimeMs,
        },
        entryLimit,
      );
    },
    addVision(event: VisionImageEvent) {
      appendLimited(
        state.vision,
        {
          id: nextId++,
          bufferSize: event.buffer.byteLength,
          frameCount: event.frames.length,
          startTimeMs: event.startTimeMs,
          endTimeMs: event.endTimeMs,
        },
        entryLimit,
      );
    },
    addError(module: DashboardModule, error: unknown) {
      appendLimited(
        state.errors,
        {
          id: nextId++,
          module,
          message: error instanceof Error ? error.message : String(error),
          timeMs: Date.now(),
        },
        entryLimit * 4,
      );
    },
  };
}

function appendLimited<T>(entries: T[], entry: T, limit: number) {
  entries.push(entry);
  if (entries.length > limit) {
    entries.splice(0, entries.length - limit);
  }
}

export type Dashboard = ReturnType<typeof createDashboard>;
