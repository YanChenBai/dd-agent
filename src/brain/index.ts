import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Output, ToolLoopAgent, stepCountIs } from 'ai';
import { createNanoEvents } from 'nanoevents';
import { z } from 'zod';

import { env } from '../env.ts';
import type { Memory, TimeRange } from '../memory/types.ts';
import { createDanmakuInstructions, createWindowPrompt } from './prompt.ts';
import type { BrainContext, BrainEvents } from './types.ts';

const danmakuOutput = Output.object({
  schema: z.array(z.string().trim().min(1).max(40)).max(2),
});
const MAX_CONTEXT_IMAGES = 3;
const MAX_HISTORY_TURNS = 6;

const provider = createOpenAICompatible({
  name: 'openrouter',
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
  supportsStructuredOutputs: true,
});

export function createBrain(memory: Memory, context: BrainContext) {
  const emitter = createNanoEvents<BrainEvents>();
  const agent = createDanmakuAgent();
  const history: Array<{ user: string; assistant: string }> = [];
  let queue = Promise.resolve();

  return {
    queueDanmaku(range: TimeRange) {
      queue = queue
        .then(async () => {
          const records = memory.query({
            startTimeMs: Math.max(0, range.endTimeMs - env.BRAIN_CONTEXT_WINDOW_MS),
            endTimeMs: range.endTimeMs,
          });
          const hearing = records.filter(record => record.type === 'hearing');
          const vision = records
            .filter(record => record.type === 'vision')
            .slice(-MAX_CONTEXT_IMAGES);

          if (hearing.length === 0 && vision.length === 0) {
            return;
          }

          const prompt = createWindowPrompt(context, range, hearing);
          const result = await agent.generate({
            messages: [
              ...history.flatMap(turn => [
                { role: 'user' as const, content: turn.user },
                { role: 'assistant' as const, content: turn.assistant },
              ]),
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: prompt,
                  },
                  ...vision.map(record => ({
                    type: 'file' as const,
                    data: record.buffer.toString('base64'),
                    mediaType: 'image/jpeg',
                  })),
                ],
              },
            ],
          });

          history.push({
            user: prompt,
            assistant: JSON.stringify(result.output),
          });
          if (history.length > MAX_HISTORY_TURNS) {
            history.shift();
          }

          emitter.emit('danmaku', {
            ...range,
            messages: result.output,
          });
        })
        .catch(error => {
          emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
        });
    },
    onDanmaku: (callback: BrainEvents['danmaku']) => emitter.on('danmaku', callback),
    onError: (callback: BrainEvents['error']) => emitter.on('error', callback),
    idle() {
      return queue;
    },
  };
}

function createDanmakuAgent() {
  return new ToolLoopAgent({
    model: provider.chatModel(env.AI_MODEL),
    instructions: createDanmakuInstructions(env.AGENT_NAME),
    output: danmakuOutput,
    providerOptions: {
      openrouter: {
        provider: {
          require_parameters: true,
        },
      },
    },
    stopWhen: stepCountIs(1),
    temperature: 0.7,
  });
}
