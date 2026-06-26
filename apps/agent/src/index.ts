import OpenAI from "openai";
import { type HearingFinalEvent, startHearing } from "./hearing.js";

const stopAfterMs = Number(
  process.env.AGENT_STOP_AFTER_MS ?? process.env.SHERPA_ONNX_STOP_AFTER_MS ?? 0,
);
const openaiModel = process.env.OPENAI_TRANSCRIPT_MODEL ?? "gpt-4.1-mini";
const openaiApiMode = process.env.OPENAI_TRANSCRIPT_API ?? "responses";
const openai = createOpenAIClient();
const hearing = startHearing();
const transcriptRecovery = createTranscriptRecovery();

hearing.events.on("final", (event: HearingFinalEvent) => {
  console.log(`final ${event.index}: ${event.text}`);
  transcriptRecovery.queue(event);
});

process.once("SIGINT", stop);

if (stopAfterMs > 0) {
  setTimeout(stop, stopAfterMs);
}

async function stop() {
  await hearing.stop();
  await transcriptRecovery.idle();
  console.log("\nstopped");
}

function createTranscriptRecovery() {
  let queue = Promise.resolve();
  const recentRecoveredTexts: string[] = [];

  return {
    queue(event: HearingFinalEvent) {
      if (!openai) {
        return;
      }

      queue = queue
        .then(async () => {
          const recovered = await recoverTranscript(event.text, recentRecoveredTexts);

          if (recovered && recovered !== event.text) {
            console.log(`recovered ${event.index}: ${recovered}`);
          }

          rememberRecoveredText(recentRecoveredTexts, recovered || event.text);
        })
        .catch((error) => {
          console.error(
            `recovered ${event.index} failed:`,
            error instanceof Error ? error.message : error,
          );
          rememberRecoveredText(recentRecoveredTexts, event.text);
        });
    },
    idle() {
      return queue;
    },
  };
}

async function recoverTranscript(text: string, recentRecoveredTexts: string[]) {
  const instructions = createRecoveryInstructions();
  const input = createRecoveryInput(text, recentRecoveredTexts);

  if (openaiApiMode === "chat") {
    const completion = await openai!.chat.completions.create({
      model: openaiModel,
      messages: [
        {
          role: "system",
          content: instructions,
        },
        {
          role: "user",
          content: input,
        },
      ],
      temperature: 0,
    });

    return completion.choices[0]?.message.content?.trim() ?? "";
  }

  const response = await openai!.responses.create({
    model: openaiModel,
    instructions,
    input,
  });

  return response.output_text.trim();
}

function createOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;

  if (!apiKey && !baseURL) {
    return undefined;
  }

  return new OpenAI({
    apiKey: apiKey ?? "not-needed",
    baseURL,
    organization: process.env.OPENAI_ORG_ID,
    project: process.env.OPENAI_PROJECT_ID,
  });
}

function createRecoveryInput(text: string, recentRecoveredTexts: string[]) {
  return [
    createLiveContext(),
    recentRecoveredTexts.length > 0
      ? `最近已经恢复的字幕：\n${recentRecoveredTexts.join("\n")}`
      : "",
    `当前 ASR 原文：${text}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createRecoveryInstructions() {
  return [
    "你是直播字幕的自动恢复器，正在实时观看一场直播。",
    "任务是把本地 ASR 的 final 文本恢复成更自然、更准确的中文直播字幕。",
    "充分利用主播姓名、昵称、平台、房间标题、直播主题、最近字幕等上下文。",
    "优先修正常见 ASR 错字、同音词、漏字、标点和中文口语断句。",
    "不要编造 ASR 没有表达的新事实；不确定时保留原意和原词。",
    "只输出恢复后的字幕文本，不要解释，不要加引号，不要加前缀。",
  ].join("\n");
}

function createLiveContext() {
  return [
    "当前场景：用户正在看直播，需要实时理解主播说话内容。",
    contextLine("平台", process.env.LIVE_PLATFORM),
    contextLine("主播名字", process.env.LIVE_STREAMER_NAME),
    contextLine("主播昵称/别名", process.env.LIVE_STREAMER_NICKNAMES),
    contextLine("房间/频道标题", process.env.LIVE_ROOM_TITLE),
    contextLine("直播主题", process.env.LIVE_TOPIC),
    contextLine("额外上下文", process.env.LIVE_CONTEXT),
  ]
    .filter(Boolean)
    .join("\n");
}

function contextLine(name: string, value: string | undefined) {
  return value?.trim() ? `${name}：${value.trim()}` : "";
}

function rememberRecoveredText(recentRecoveredTexts: string[], text: string) {
  recentRecoveredTexts.push(text);

  if (recentRecoveredTexts.length > 12) {
    recentRecoveredTexts.shift();
  }
}
