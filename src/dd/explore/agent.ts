import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Output, stepCountIs, ToolLoopAgent } from 'ai';
import { z } from 'zod';

import type { DDConfig } from '../../config/index.ts';
import { createExploreInstructions } from './prompt.ts';

const exploreDecisionOutput = Output.object({
  schema: z
    .object({
      continue: z.boolean(),
      roomId: z.number().int().positive().nullable(),
      reason: z.string().trim().min(1).max(200),
    })
    .superRefine((decision, context) => {
      if (decision.continue && decision.roomId !== null) {
        context.addIssue({
          code: 'custom',
          path: ['roomId'],
          message: 'roomId must be null when continue is true',
        });
      }
    }),
});

export function createExploreAgent(config: DDConfig) {
  const provider = createOpenAICompatible({
    name: 'openai-compatible',
    apiKey: config.ai.apiKey,
    baseURL: config.ai.baseUrl,
    supportsStructuredOutputs: config.ai.supportsStructuredOutputs,
  });

  return new ToolLoopAgent({
    model: provider.chatModel(config.ai.model),
    instructions: createExploreInstructions(config.agent.name),
    output: exploreDecisionOutput,
    stopWhen: stepCountIs(1),
    temperature: 0.7,
  });
}
