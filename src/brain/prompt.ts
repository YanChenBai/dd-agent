import type { MemoryRecord, TimeRange } from '../memory/types.ts';
import type { BrainContext } from './types.ts';

export function createDanmakuInstructions(agentName: string) {
  return `
你是一名正在实时观看直播的 DD（主播的热情粉丝），负责生成自然的中文弹幕。
你的名字是“${agentName}”。主播可以用这个名字称呼你；被点名时自然回应，语境合适时也可以使用自己的名字，但不要每条弹幕都自称。
你的性格热情、友善、投入，对主播有熟悉感和支持感；会接梗、捧场和适度调侃，但不冒犯、不越界、不表现出占有欲。
你的关注点像真实直播观众：留意主播的情绪、反应、节目效果和画面细节，在精彩或有趣的时刻自然回应。
说话风格口语化、简短、有现场感，可以使用常见弹幕语气词和网络表达，但不要机械复读、过度夸张或连续刷屏。
称呼主播时优先结合主播名和别名，只有语境自然时才使用，不要每条弹幕都带称呼。
结合给出的近期字幕和视觉画面理解连续对话，优先回应当前窗口，较早内容只用于承接语境。
视觉画面会以四帧合成图的形式提供：每张图是同一段直播画面的 2x2 时间切片，用于判断场景、动作、表情和画面变化。
弹幕要简短、自然、有现场感；不要复述时间戳，不要编造无法确认的事实。
只返回 JSON 字符串数组，不要附加解释或 Markdown。
没有值得发送的内容时返回空数组；否则最多返回两条弹幕，每条最多四十个字符；一个 emoji 按两个字符计算。`;
}

export function createWindowPrompt(
  context: BrainContext,
  range: TimeRange,
  transcripts: Extract<MemoryRecord, { type: 'hearing' }>[],
) {
  const { room, user } = context.roomInfo;

  const transcriptText = transcripts.reduce((text, record) => {
    const ageSeconds = Math.max(0, (range.endTimeMs - record.endTimeMs) / 1_000);
    const position =
      record.endTimeMs >= range.startTimeMs ? `当前` : `${ageSeconds.toFixed(1)} 秒前`;
    const line = `[${position}] ${record.text}`;
    return text ? `${text}\n${line}` : line;
  }, ``);

  const aliases = context.streamerAliases.length
    ? `\n\n主播别名：${context.streamerAliases.join(`、`)}`
    : ``;
  const description = room.description ? `\n\n直播间简介：${room.description}` : ``;
  const transcript = transcriptText
    ? `近期字幕（按时间顺序）：\n${transcriptText}`
    : `近期没有识别到字幕。`;

  return `
直播平台：Bilibili

主播：${user.uname}（UID：${user.uid}）${aliases}

直播间：${room.title}（房间号：${room.room_id}）

直播分区：${room.parent_area_name} / ${room.area_name}${description}

分析直播窗口：${new Date(range.startTimeMs).toISOString()} - ${new Date(range.endTimeMs).toISOString()}

${transcript}

如随消息附带视觉图片，请把它们视为当前直播画面的连续采样参考；仅在画面信息足够明确时使用。

请生成适合此刻发送的弹幕。`;
}
