# DD Agent

一个面向 Bilibili 直播间的多模态弹幕 Agent。它实时读取直播流，从语音和画面中提取上下文，调用 OpenAI 兼容的多模态模型生成中文弹幕，并通过终端仪表盘展示运行状态；是否真正发送弹幕由配置开关控制。

> 项目仍处于早期开发阶段，目前主要面向 Windows 本地开发环境。

## 工作方式

```text
Bilibili 直播流
  ├─ 音频 → VAD → SenseVoice 语音识别 ─┐
  └─ 视频 → 定时抽帧 → 2×2 画面拼图 ───┼─ 短期记忆 → 多模态模型 → 弹幕
                                       └─ 终端仪表盘
```

- 使用 FFmpeg 拉取直播流，每 5 秒抽取一帧画面，同时输出 16 kHz 单声道 PCM 音频。
- 使用 sherpa-onnx、SenseVoice 和 Silero VAD（或 TEN VAD）在本地识别主播语音。
- 每 20 秒组合最近四帧，并与近期字幕一起交给 OpenAI 兼容的多模态模型。
- 默认仅在终端预览生成结果；启用发送后，每 20 秒最多发送一条，以避免刷屏。

## 环境要求

- Node.js 22.12 或更高版本
- [Vite+](https://viteplus.dev/guide/) 全局命令 `vp`
- 可从命令行调用的 FFmpeg
- 一个支持图片输入和结构化输出的 OpenAI 兼容模型

## 快速开始

1. 安装依赖：

   ```powershell
   vp install
   ```

2. 准备本地语音模型。默认目录结构如下：

   ```text
   models/
   ├─ sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/
   │  ├─ model.int8.onnx
   │  └─ tokens.txt
   └─ silero_vad.onnx
   ```

   也可以在环境变量中通过 `SENSEVOICE_MODEL`、`TOKENS` 和 `VAD_MODEL` 指向其他位置。

3. 从示例创建本地配置：

   ```powershell
   Copy-Item .env.example .env
   ```

   至少需要填写：

   | 变量                  | 说明                                        |
   | --------------------- | ------------------------------------------- |
   | `LIVE_ROOM_ID`        | Bilibili 直播间号，运行时直播间必须正在开播 |
   | `AI_MODEL`            | OpenAI 兼容服务提供的模型 ID                |
   | `AI_API_KEY`          | 模型服务 API Key                            |
   | `AI_BASE_URL`         | OpenAI 兼容 API 地址                        |
   | `LOGIN_SYNC_URL`      | Bilibili 登录凭据同步服务的 WebSocket 地址  |
   | `LOGIN_SYNC_PASSWORD` | 登录同步服务的共享密码                      |

4. 启动 Agent：

   ```powershell
   vpr start
   ```

   `vpr start` 会先生成面向 Node.js 的生产构建，再运行 `dist/index.js`，不会启用热更新。开发时可使用 `vpr dev` 启动带热更新的 Vite 开发模式。

   按 `Ctrl+C` 安全退出。默认 `SEND_DANMAKU=0`，只预览生成的弹幕；确认登录同步配置可用后，将其改为 `1` 才会真正发送。

## 常用配置

完整配置及注释见 [`.env.example`](.env.example)。常用选项包括：

| 变量                      | 默认值   | 说明                               |
| ------------------------- | -------- | ---------------------------------- |
| `AGENT_NAME`              | `DD`     | 主播称呼 Agent 时使用的名字        |
| `AGENT_STOP_AFTER_MS`     | `0`      | 自动停止时间；`0` 表示持续运行     |
| `SEND_DANMAKU`            | `0`      | `1` 为发送弹幕，`0` 为仅预览       |
| `LIVE_STREAMER_ALIASES`   | 空       | 主播别名，多个值使用英文逗号分隔   |
| `MEMORY_RETENTION_MS`     | `600000` | 语音和视觉记录的保留时长           |
| `BRAIN_CONTEXT_WINDOW_MS` | `120000` | 每次请求模型时使用的近期上下文长度 |
| `VAD_KIND`                | `silero` | VAD 实现，可选 `silero` 或 `ten`   |
| `PROVIDER`                | `cpu`    | sherpa-onnx 执行提供程序           |

## 未来开发方向

- **说话人区分与主播声纹识别**：接入 sherpa-onnx Speaker Diarization，将字幕按说话人分段；支持预先注册主播声纹，通过 Speaker Identification 标记主播、嘉宾及其他音源，减少错误归因。
- **自定义唤醒词**：接入 sherpa-onnx Keyword Spotting，支持类似“小爱同学”的本地唤醒词；结合主播声纹校验，只在主播说出唤醒词时触发 Agent，降低直播音轨中的误唤醒。
- **LoopAgent**：将当前单次弹幕生成扩展为可持续决策的 Agent 循环，引入工具调用、短期与长期记忆、事件判断和行动规划，使 Agent 能根据直播上下文决定何时观察、回应、等待或执行其他操作。

## 开发

常用命令：

```powershell
vp check          # 格式化检查、Lint 和类型检查
vp test           # 运行测试
vpr build # 构建 Agent
vpr start # 构建并运行 Agent，不启用热更新
vpr dev   # 以开发模式运行 Agent，启用热更新
vpr ready # 依次执行检查、测试和构建
```

## 安全提示

- 不要提交 `.env`、API Key、Cookie 或登录同步密码。
- 首次使用请保持 `SEND_DANMAKU=0`，检查生成质量和频率后再开启发送。
- 使用自动弹幕前，请自行确认符合平台规则及直播间规范。
