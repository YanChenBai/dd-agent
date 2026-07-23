import { readFileSync } from 'node:fs';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Output, ToolLoopAgent, stepCountIs } from 'ai';
import { createNanoEvents } from 'nanoevents';
import { z } from 'zod';

import type { DDConfig } from '@/config/index.ts';
import { formatDurationMs } from '@/logger/format.ts';
import { createLogger } from '@/logger/index.ts';
import type { Memory, MemoryRecord, TimeRange } from '@/memory/types.ts';
import { withComponent, type RoomContext } from '@/observability/context.ts';
import {
  addFailedTokenRequest,
  addTokenUsage,
  createTokenUsageReport,
  snapshotTokenUsage,
} from '@/observability/token-usage.ts';
import type { DDMode } from '@/types/index.ts';
import { createEventHandlers } from '@/utils/events.ts';

import { createBrainInstructions, createWindowPrompt } from './prompt.ts';
import type {
  BrainContext,
  BrainEvents,
  BrainOutput,
  BrainResultEvent,
  ExploreModeOutput,
} from './types.ts';

export * from './types.ts';
export type { DDMode } from '@/types/index.ts';

const danmakusSchema = z.array(z.string().trim().min(1).max(40)).max(1);
const singleOutput = Output.object({
  schema: z.object({
    danmakus: danmakusSchema,
  }),
});
const exploreOutput = Output.object({
  schema: z
    .object({
      danmakus: danmakusSchema,
      shouldContinue: z.boolean(),
      watchDeltaMs: z
        .number()
        .int()
        .min(-60 * 60 * 1_000)
        .max(60 * 60 * 1_000),
      reason: z.string().trim().min(1).max(200),
    })
    .superRefine((value, context) => {
      if (!value.shouldContinue && value.watchDeltaMs !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['watchDeltaMs'],
          message: 'watchDeltaMs must be 0 when shouldContinue is false',
        });
      }
    }),
});

export function createBrain(
  memory: Memory,
  context: BrainContext,
  config: DDConfig,
  mode: DDMode = 'single',
  logContext?: RoomContext,
) {
  const logger = createLogger({
    prefix: 'brain',
    prefixColor: 'green',
    context: logContext ? withComponent(logContext, 'brain') : undefined,
  });
  const emitter = createNanoEvents<BrainEvents>();
  const eventHandlers = createEventHandlers(emitter);
  const agent = createBrainAgent(config, context, mode);
  const tokenUsage = createTokenUsageReport();
  const history: Array<{ user: string; assistant: string }> = [];
  let queue = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let lastPollTimeMs = 0;
  let pendingPollEndTimeMs: number | undefined;
  let pollQueued = false;
  let latestResult: BrainResultEvent | undefined;
  let lastActivityTimeMs = Date.now();
  let plannedWatchEndAt: number | undefined;
  let requestController: AbortController | undefined;
  let running = false;

  function queryWindow(range: TimeRange) {
    const records = memory.query({
      startTimeMs: Math.max(0, range.endTimeMs - config.memory.brainContextWindowMs),
      endTimeMs: range.endTimeMs,
    });
    const hearing: Extract<MemoryRecord, { type: 'hearing' }>[] = [];
    const vision: Extract<MemoryRecord, { type: 'vision' }>[] = [];

    for (const record of records) {
      if (record.type === 'hearing') {
        hearing.push(record);
      } else {
        vision.push(record);
      }
    }

    return {
      hearing,
      vision: vision.slice(-config.memory.brainContextImages),
      hasFreshRecords: records.some(record => record.endTimeMs > range.startTimeMs),
      latestActivityTimeMs: records.reduce(
        (latest, record) => Math.max(latest, record.endTimeMs),
        0,
      ),
    };
  }

  function createPollContent(
    range: TimeRange,
    hearing: Extract<MemoryRecord, { type: 'hearing' }>[],
    vision: Extract<MemoryRecord, { type: 'vision' }>[],
  ) {
    const prompt = createWindowPrompt(range, hearing, mode, {
      inactiveMs: Math.max(0, range.endTimeMs - lastActivityTimeMs),
      remainingWatchMs:
        plannedWatchEndAt === undefined
          ? undefined
          : Math.max(0, plannedWatchEndAt - range.endTimeMs),
    });
    const content = [
      {
        type: 'text' as const,
        text: prompt,
      },
      ...vision.flatMap(record => [
        {
          type: 'text' as const,
          text:
            record.endTimeMs > range.startTimeMs
              ? '以下是当前轮询窗口内的新视觉画面：'
              : '以下是较早的视觉上下文，仅用于理解，不要单独回应：',
        },
        {
          type: 'file' as const,
          data: readFileSync(record.filePath).toString('base64'),
          mediaType: 'image/jpeg' as const,
        },
      ]),
    ];

    return { prompt, content };
  }

  async function processPoll(endTimeMs: number): Promise<void> {
    const range = {
      startTimeMs: lastPollTimeMs,
      endTimeMs,
    };
    lastPollTimeMs = endTimeMs;

    const { hearing, vision, hasFreshRecords, latestActivityTimeMs } = queryWindow(range);
    if (hasFreshRecords) {
      lastActivityTimeMs = Math.max(lastActivityTimeMs, latestActivityTimeMs);
    }
    if (
      (mode === 'single' && (!hasFreshRecords || (hearing.length === 0 && vision.length === 0))) ||
      (!hasFreshRecords && range.endTimeMs <= lastActivityTimeMs)
    ) {
      return;
    }

    const { prompt, content } = createPollContent(range, hearing, vision);
    const controller = new AbortController();
    requestController = controller;
    const requestStartedAt = performance.now();
    const result = await agent
      .generate({
        abortSignal: controller.signal,
        timeout: { stepMs: config.ai.requestTimeoutMs },
        messages: [
          ...history.flatMap(turn => [
            { role: 'user' as const, content: turn.user },
            { role: 'assistant' as const, content: turn.assistant },
          ]),
          {
            role: 'user',
            content,
          },
        ],
      })
      .then(
        result => {
          addTokenUsage(tokenUsage, result.usage);
          return result;
        },
        error => {
          addFailedTokenRequest(tokenUsage);
          throw error;
        },
      )
      .finally(() => {
        if (requestController === controller) {
          requestController = undefined;
        }
      });

    logger.info(
      `AI 请求完成：${formatDurationMs(performance.now() - requestStartedAt)}，tokens ${result.usage.inputTokens ?? '?'}+${result.usage.outputTokens ?? '?'}=${result.usage.totalTokens ?? '?'}，finish=${result.finishReason}`,
    );

    if (!running) {
      return;
    }

    const output = result.output as BrainOutput;
    history.push({
      user: prompt,
      assistant: JSON.stringify(output),
    });
    if (history.length > config.agent.danmakuHistoryTurns) {
      history.shift();
    }

    emitter.emit('danmaku', {
      ...range,
      messages: output.danmakus,
    });
    latestResult = { ...range, ...output };
    emitter.emit('result', latestResult);

    if (mode === 'explore') {
      emitDecision(range, output as ExploreModeOutput);
    }
  }

  function emitDecision(range: TimeRange, decision: ExploreModeOutput): void {
    const decisionEvent = {
      ...range,
      shouldContinue: decision.shouldContinue,
      watchDeltaMs: decision.watchDeltaMs,
      reason: decision.reason,
    };
    emitter.emit('decision', decisionEvent);
    if (decision.shouldContinue) {
      emitter.emit('continueWatching', {
        ...range,
        watchDeltaMs: decision.watchDeltaMs,
        reason: decision.reason,
      });
    } else {
      emitter.emit('switchRoom', {
        ...range,
        reason: decision.reason,
      });
    }
  }

  function queuePoll(endTimeMs: number): void {
    if (!running) {
      return;
    }
    pendingPollEndTimeMs = Math.max(pendingPollEndTimeMs ?? 0, endTimeMs);
    if (pollQueued) {
      return;
    }

    pollQueued = true;
    queue = queue
      .then(async () => {
        const pollEndTimeMs = pendingPollEndTimeMs;
        pendingPollEndTimeMs = undefined;
        if (pollEndTimeMs === undefined) {
          return;
        }
        await processPoll(pollEndTimeMs);
      })
      .catch(error => {
        if (!running) {
          return;
        }
        const value = error instanceof Error ? error : new Error(String(error));
        logger.error(value);
        emitter.emit('error', value);
      })
      .finally(() => {
        pollQueued = false;
        if (pendingPollEndTimeMs !== undefined) {
          queuePoll(pendingPollEndTimeMs);
        }
      });
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    const now = Date.now();
    lastActivityTimeMs = now;
    lastPollTimeMs = Math.max(0, now - config.memory.brainContextWindowMs);
    queuePoll(now);
    timer = setInterval(() => {
      queuePoll(Date.now());
    }, config.agent.danmakuIntervalMs);
  }

  function stop(): void {
    if (!running) {
      return;
    }

    running = false;
    pendingPollEndTimeMs = undefined;
    requestController?.abort(new Error('Brain stopped'));
    requestController = undefined;
    if (timer) {
      clearInterval(timer);
    }
    timer = undefined;
  }

  function getLatestDecision() {
    if (mode !== 'explore' || !latestResult || !('shouldContinue' in latestResult)) {
      return undefined;
    }

    return {
      startTimeMs: latestResult.startTimeMs,
      endTimeMs: latestResult.endTimeMs,
      shouldContinue: latestResult.shouldContinue,
      watchDeltaMs: latestResult.watchDeltaMs,
      reason: latestResult.reason,
    };
  }

  function getLatestResult() {
    return latestResult;
  }

  function setPlannedWatchEndAt(endAt: number | undefined): void {
    plannedWatchEndAt = endAt;
  }

  function idle(): Promise<void> {
    return queue;
  }

  function getTokenUsage() {
    return snapshotTokenUsage(tokenUsage);
  }

  return {
    start,
    stop,
    onDanmaku: eventHandlers.onDanmaku,
    onDecision: eventHandlers.onDecision,
    onContinueWatching: eventHandlers.onContinueWatching,
    onSwitchRoom: eventHandlers.onSwitchRoom,
    onResult: eventHandlers.onResult,
    onError: eventHandlers.onError,
    getLatestDecision,
    getLatestResult,
    getTokenUsage,
    setPlannedWatchEndAt,
    idle,
  };
}

function createBrainAgent(config: DDConfig, context: BrainContext, mode: DDMode) {
  const provider = createOpenAICompatible({
    name: 'openai-compatible',
    apiKey: config.ai.apiKey,
    baseURL: config.ai.baseUrl,
    supportsStructuredOutputs: config.ai.supportsStructuredOutputs,
  });

  return new ToolLoopAgent({
    model: provider.chatModel(config.ai.model),
    instructions: createBrainInstructions(config.agent.name, context, mode),
    output: mode === 'explore' ? exploreOutput : singleOutput,
    stopWhen: stepCountIs(1),
    temperature: 0.7,
  });
}
