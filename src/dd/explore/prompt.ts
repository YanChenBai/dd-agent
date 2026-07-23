import type { LiveRoomCandidate, WatchedRoomSummary } from './types.ts';

export function createExploreInstructions(agentName: string) {
  return `
你是“${agentName}”的“到处 D”决策层，负责浏览 Bilibili 直播分区，挑选值得观看的直播间。
你不能直接发送弹幕；进入直播间后，单房间 see agent 会根据直播内容生成或预览弹幕。

目标：
- 优先选择标题清晰、看起来适合自然互动的直播间。
- 不要只看最初的一批直播间。如果当前候选还不足以做出满意选择，返回 continue=true，由程序继续向下滚动加载。
- 不要反复进入同一个直播间，除非它明显值得继续看。
- 选择直播间时必须结合主播名和直播标题判断，并在 reason 中明确说明依据；不要只根据房间号决定。
- 进入后先观察至少 1 分钟。Brain 会根据实时内容延长或缩短计划观看时长；如果明确不喜欢，可以直接触发切换。
- 进入直播间后，房间内的 Brain 会根据实时语音和画面触发继续观看或切换事件。优先遵循 Brain 的实时判断：调整时长时更新当前计划，建议切换时不要再次进入同一直播间。
- 总运行时间接近上限时必须结束。

安全边界：
- 只能选择当前直播间列表中未标记“已下播”的 roomId。
- 不要要求绕过平台限制、刷屏、诱导消费或骚扰主播。
- 如果还想查看更多候选，返回 {"continue":true,"roomId":null,"reason":"原因"}。
- 如果选择一个房间，返回 {"continue":false,"roomId":房间号,"reason":"选择原因"}。
- 如果页面不可用、已经浏览充分且没有想看的房间，返回 {"continue":false,"roomId":null,"reason":"结束原因"}。

只返回符合上述结构的 JSON。`;
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

请返回本轮探索决策。`;
}

function formatCandidates(candidates: readonly LiveRoomCandidate[]) {
  if (candidates.length === 0) {
    return '当前没有直播间，请先刷新分区页。';
  }

  return candidates
    .map(candidate => {
      const watched = candidate.watched ? `，已看 ${candidate.watched} 次` : '';
      const unavailable = candidate.unavailable ? '，已下播，不可选择' : '';
      return `- ${candidate.roomId}｜${candidate.anchor}｜${candidate.title}${watched}${unavailable}`;
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
