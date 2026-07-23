import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { hasToolCall, stepCountIs, ToolLoopAgent } from 'ai';
import type { ConsolaInstance } from 'consola';

import type { DDConfig } from '../../config/index.ts';
import { formatDuration } from './duration.ts';
import { createExploreInstructions } from './prompt.ts';
import type { ExploreTools } from './tools.ts';

export function createExploreAgent(config: DDConfig, tools: ExploreTools, logger: ConsolaInstance) {
  const provider = createOpenAICompatible({
    name: 'openai-compatible',
    apiKey: config.ai.apiKey,
    baseURL: config.ai.baseUrl,
    supportsStructuredOutputs: config.ai.supportsStructuredOutputs,
  });

  return new ToolLoopAgent({
    model: provider.chatModel(config.ai.model),
    instructions: createExploreInstructions(config.agent.name),
    tools,
    stopWhen: [hasToolCall('finish'), stepCountIs(20)],
    temperature: 0.7,
    onToolExecutionStart: ({ toolCall }) => {
      logger.info(`调用工具 ${toolCall.toolName}：${stringify(toolCall.input)}`);
    },
    onToolExecutionEnd: ({ toolCall, toolExecutionMs, toolOutput }) => {
      if (toolOutput.type === 'tool-error') {
        logger.error(
          `工具 ${toolCall.toolName} 执行失败（${formatDuration(toolExecutionMs)}）`,
          toolOutput.error,
        );
        return;
      }
      logger.info(`工具 ${toolCall.toolName} 执行完成（${formatDuration(toolExecutionMs)}）`);
    },
    onStepEnd: ({ dynamicToolCalls }) => {
      for (const toolCall of dynamicToolCalls) {
        if (toolCall.invalid) {
          logger.error(`工具 ${toolCall.toolName} 参数无效`, toolCall.error);
        }
      }
    },
  });
}

function stringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
