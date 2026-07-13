import { describe, expect, it } from 'vite-plus/test';

import { emojiTags } from './emoji.ts';
import { createBrainInstructions, createWindowPrompt } from './prompt.ts';
import type { BrainContext } from './types.ts';

const context: BrainContext = {
  roomInfo: {
    room: {
      uid: 100,
      room_id: 200,
      short_id: 0,
      title: '测试直播间',
      description: '测试简介',
      live_status: 1,
      area_name: '虚拟主播',
      parent_area_name: '娱乐',
    },
    user: {
      uid: 100,
      uname: '测试主播',
      face: '',
      room_id: 200,
      title: '测试直播间',
      live_status: 1,
    },
  },
  streamerAliases: ['主播别名'],
};

describe('createBrainInstructions', () => {
  it('includes the supported emoji tags and contextual usage rules', () => {
    const instructions = createBrainInstructions('测试 DD', context);

    expect(instructions).toContain('可以的[OK]');
    expect(instructions).toContain('普通场景只在合适时选用');
    expect(instructions).toContain('正在唱歌或刚完成演唱，优先使用“[喝彩]”');
    expect(instructions).toContain(emojiTags.join('、'));
  });

  it('prevents repeated comments about an event and limits each turn to one message', () => {
    const instructions = createBrainInstructions('测试 DD', context);

    expect(instructions).toContain('不要换一种说法重复发送');
    expect(instructions).toContain('同一个动作、话题、笑点或演唱片段只回应一次');
    expect(instructions).toContain('最多返回一条弹幕');
  });

  it('keeps static room metadata in instructions and dynamic time in each window prompt', () => {
    const instructions = createBrainInstructions('测试 DD', context);
    const prompt = createWindowPrompt({ startTimeMs: 1_000, endTimeMs: 2_000 }, []);

    expect(instructions).toContain('主播：测试主播（UID：100）');
    expect(instructions).toContain('直播间：测试直播间（房间号：200）');
    expect(instructions).toContain('主播别名：主播别名');
    expect(instructions).toContain('直播间简介：测试简介');
    expect(prompt).not.toContain('测试主播');
    expect(prompt).toContain('## 分析窗口');
  });

  it('uses the single output contract by default', () => {
    const instructions = createBrainInstructions('测试 DD', context);

    expect(instructions).toContain('当前为 single 模式');
    expect(instructions).toContain('{ "danmakus": string[] }');
    expect(instructions).not.toContain('shouldContinue');
  });

  it('injects the explore decision contract when requested', () => {
    const instructions = createBrainInstructions('测试 DD', context, 'explore');
    const prompt = createWindowPrompt({ startTimeMs: 1_000, endTimeMs: 2_000 }, [], 'explore', {
      inactiveMs: 3 * 60 * 1_000,
      remainingWatchMs: 2 * 60 * 1_000,
    });

    expect(instructions).toContain('当前为 explore 模式');
    expect(instructions).toContain('shouldContinue');
    expect(instructions).toContain('watchDeltaMs');
    expect(instructions).toContain('正数延长，负数缩短');
    expect(instructions).toContain('reason');
    expect(prompt).toContain('判断是否值得继续观看');
    expect(prompt).toContain('计划剩余观看时长：2 分钟');
    expect(prompt).toContain('距离最近一次新语音或画面：3 分钟');
  });
});
