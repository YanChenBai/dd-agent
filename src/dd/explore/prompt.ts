import type { LiveRoomCandidate, WatchedRoomSummary } from './types.ts';

export function createExploreInstructions(agentName: string) {
  return `
你是“${agentName}”的“到处 D”决策层，负责浏览 Bilibili 直播分区，挑选值得观看的直播间。
你不能直接发送弹幕；进入直播间后，单房间 see agent 会根据直播内容生成或预览弹幕。

目标：
- 优先选择标题清晰、看起来适合自然互动的直播间。
- 可以调用 loadMoreRooms 继续向下滚动，通过无限加载寻找更多主播；不要只看最初的一批直播间。
- 不要反复进入同一个直播间，除非它明显值得继续看。
- 每次进入前必须结合主播名和直播标题判断初始观看时长，并在 seeRoom.reason 中明确说明判断依据。低兴趣或信息较少可先看 1–3 分钟，中等兴趣看 4–10 分钟，高兴趣看 11–30 分钟，特别感兴趣可看更久，最多 ${formatDuration(60 * 60 * 1_000)}。
- 不要机械地给每个直播间相同的 durationMinutes，也不要只根据房间号决定时长；主播名未知时，应根据标题中可识别的主播名和内容判断。
- 进入后至少观察 1 分钟。Brain 可以用正数延长或负数缩短计划观看时长；如果明确不喜欢，可以直接触发切换，不必等待原计划结束。
- 进入直播间后，房间内的 Brain 会根据实时语音和画面触发继续观看或切换事件。优先遵循 Brain 的实时判断：调整时长时更新当前计划，建议切换时不要再次进入同一直播间。
- 总运行时间接近上限时必须结束。

安全边界：
- 只使用工具提供的直播间列表和观看工具。
- 不要要求绕过平台限制、刷屏、诱导消费或骚扰主播。
- 如果直播间不够、页面不可用或已经浏览充分，调用 finish。

每一步都要简洁说明选择理由。`;
}

export function createExplorePrompt(input: {
  areaUrl: string;
  maxRunMs: number;
  observeRoomMs: number;
  candidates: readonly LiveRoomCandidate[];
  watched: readonly WatchedRoomSummary[];
}) {
  return `
分区页：${input.areaUrl}
最长运行：${formatDuration(input.maxRunMs)}
单房间观察上限：${formatDuration(input.observeRoomMs)}（硬上限 1 小时，实际时长由你的兴趣程度决定）

当前直播间列表：
${formatCandidates(input.candidates)}

已观察房间：
${formatWatched(input.watched)}

请开始到处 D。`;
}

function formatCandidates(candidates: readonly LiveRoomCandidate[]) {
  if (candidates.length === 0) {
    return '当前没有直播间，请先刷新分区页。';
  }

  return candidates
    .map(candidate => {
      const watched = candidate.watched ? `，已看 ${candidate.watched} 次` : '';
      return `- ${candidate.roomId}｜${candidate.anchor}｜${candidate.title}${watched}`;
    })
    .join('\n');
}

function formatWatched(watched: readonly WatchedRoomSummary[]) {
  if (watched.length === 0) {
    return '暂无。';
  }

  return watched
    .map(summary => {
      const { room, user } = summary.roomInfo;
      const context = summary.context
        ? `｜上下文：${summary.context.hearing.slice(-3).join('；') || '暂无语音'}，画面 ${summary.context.visionFrames} 帧`
        : '';
      const decision = summary.decision
        ? `｜Brain：${summary.decision.shouldContinue ? `调整观看 ${formatSignedDuration(summary.decision.watchDeltaMs)}` : '建议切换'}，${summary.decision.reason}`
        : '';
      return `- ${room.room_id}｜${user.uname}｜${room.title}｜观察 ${formatDuration(summary.watchedMs)}${context}${decision}`;
    })
    .join('\n');
}

function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) {
    return `${seconds} 秒`;
  }

  return `${Math.round(seconds / 60)} 分钟`;
}

function formatSignedDuration(ms: number) {
  if (ms === 0) {
    return '不变';
  }
  return `${ms > 0 ? '+' : '-'}${formatDuration(Math.abs(ms))}`;
}
