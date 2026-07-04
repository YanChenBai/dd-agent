import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Output, ToolLoopAgent, stepCountIs } from 'ai';
import { createNanoEvents } from 'nanoevents';
import { z } from 'zod';

import { env } from '../env.ts';
import type { Memory, MemoryRecord, TimeRange } from '../memory/types.ts';
import type { BrainContext, BrainEvents } from './types.ts';

const danmakuOutput = Output.object({
  schema: z.array(z.string().trim().min(1).max(40)).max(2),
});
const MAX_CONTEXT_IMAGES = 3;

const provider = createOpenAICompatible({
  name: 'openrouter',
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
  supportsStructuredOutputs: true,
});

export function createBrain(memory: Memory, context: BrainContext) {
  const emitter = createNanoEvents<BrainEvents>();
  const agent = createDanmakuAgent();
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

          const result = await agent.generate({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: createWindowPrompt(context, range, hearing),
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
    instructions: [
      '你是一名正在实时观看直播的 DD（主播的热情粉丝），负责生成自然的中文弹幕。',
      `你的名字是“${env.AGENT_NAME}”。主播可以用这个名字称呼你；被点名时自然回应，语境合适时也可以使用自己的名字，但不要每条弹幕都自称。`,
      '你的性格热情、友善、投入，对主播有熟悉感和支持感；会接梗、捧场和适度调侃，但不冒犯、不越界、不表现出占有欲。',
      '你的关注点像真实直播观众：留意主播的情绪、反应、节目效果和画面细节，在精彩或有趣的时刻自然回应。',
      '说话风格口语化、简短、有现场感，可以使用常见弹幕语气词和网络表达，但不要机械复读、过度夸张或连续刷屏。',
      '称呼主播时优先结合主播名和别名，只有语境自然时才使用，不要每条弹幕都带称呼。',
      '结合给出的近期字幕和视觉画面理解连续对话，优先回应当前窗口，较早内容只用于承接语境。',
      '弹幕要简短、自然、有现场感；不要复述时间戳，不要编造无法确认的事实。',
      '只返回 JSON 字符串数组，不要附加解释或 Markdown。',
      '没有值得发送的内容时返回空数组；否则最多返回两条弹幕，每条最多四十个字符；一个 emoji 按两个字符计算。',
    ].join('\n'),
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

function createWindowPrompt(
  context: BrainContext,
  range: TimeRange,
  transcripts: Extract<MemoryRecord, { type: 'hearing' }>[],
) {
  const { room, user } = context.roomInfo;
  const transcriptLines = transcripts.map(record => {
    const ageSeconds = Math.max(0, (range.endTimeMs - record.endTimeMs) / 1_000);
    const position =
      record.endTimeMs >= range.startTimeMs ? '当前' : `${ageSeconds.toFixed(1)} 秒前`;
    return `[${position}] ${record.text}`;
  });

  return [
    '直播平台：Bilibili',
    `主播：${user.uname}（UID：${user.uid}）`,
    context.streamerAliases.length > 0
      ? `主播别名：${context.streamerAliases.join('、')}`
      : undefined,
    `直播间：${room.title}（房间号：${room.room_id}）`,
    `直播分区：${room.parent_area_name} / ${room.area_name}`,
    room.description ? `直播间简介：${room.description}` : undefined,
    `分析直播窗口：${new Date(range.startTimeMs).toISOString()} - ${new Date(range.endTimeMs).toISOString()}`,
    transcriptLines.length > 0
      ? `近期字幕（按时间顺序）：\n${transcriptLines.join('\n')}`
      : '近期没有识别到字幕。',
    '请生成适合此刻发送的弹幕。',
  ]
    .filter(value => value !== undefined)
    .join('\n\n');
}
