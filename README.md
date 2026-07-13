# DD Agent

一个面向 Bilibili 直播间的多模态弹幕 Agent。它实时读取直播流，从语音和画面中提取上下文，调用 OpenAI 兼容的多模态模型生成中文弹幕，并通过终端仪表盘展示运行状态；是否真正发送弹幕由配置开关控制。

> 项目仍处于早期开发阶段，目前主要面向 Windows 本地开发环境。

## 工作方式

```text
Bilibili FLV 直播流（fetchFlvPlayInfo）
  ├─ 音频 → VAD → SenseVoice 语音识别 ─┐
  └─ 视频 → 定时抽帧 → 2×2 画面拼图 ───┼─ 短期记忆 → 多模态模型 → 弹幕
                                       ├─ 终端预览
                                       └─ 嘴（Puppeteer）→ Bilibili 直播间
```

- 通过 `fetchFlvPlayInfo` 获取 FLV 地址并交给 FFmpeg，每 5 秒抽取一帧画面，同时输出 16 kHz 单声道 PCM 音频。
- “嘴”模块始终启动 Puppeteer 并复用持久化登录态；是否实际向当前直播间发送弹幕由配置开关控制。
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

3. 编辑根目录的 [`dd.config.ts`](dd.config.ts)。它使用项目导出的 `defineConfig`，至少需要替换 `ai.apiKey`，并按需要设置 `live.roomId`。

4. 启动单直播间 Agent：

   ```powershell
   vpr start -- single
   ```

   `vpr start -- single` 会先生成面向 Node.js 的生产构建，再运行 CLI，不会启用热更新。开发时可使用 `vpr dev -- single` 启动带热更新的 Vite 开发模式。

   按 `Ctrl+C` 安全退出。浏览器会打开当前直播间，首次运行需完成 Bilibili 登录。默认 `live.sendDanmaku=false`，仅预览生成的弹幕；将其改为 `true` 后才会实际发送。

5. 启动 Explore Agent：

   ```powershell
   vpr start -- explore
   ```

   Explore Agent 会打开 `explore.areaUrl` 指向的 Bilibili 直播分区页，逐页读取直播间列表，然后让 AI 根据兴趣程度选择进入哪个房间以及观察多久。进入房间后复用单直播间模式的听觉、视觉和弹幕逻辑；`explore.maxRunMs` 控制总运行时长，`explore.observeRoomMs` 控制单房间最长观察时间（代码硬上限为 1 小时）。

## 常用配置

完整配置及注释见 [`dd.config.ts`](dd.config.ts)。常用 CLI 命令：

| 命令                  | 说明                                           |
| --------------------- | ---------------------------------------------- |
| `dd single [room-id]` | 运行单个直播间；省略 ID 时使用 `live.roomId`。 |
| `dd explore`          | 运行 ExploreAgent 到处 D 模式。                |
| `--send-danmaku`      | 覆盖配置，在本次运行中实际发送弹幕。           |

## 未来开发方向

- **说话人区分与主播声纹识别**：接入 sherpa-onnx Speaker Diarization，将字幕按说话人分段；支持预先注册主播声纹，通过 Speaker Identification 标记主播、嘉宾及其他音源，减少错误归因。
- **自定义唤醒词**：接入 sherpa-onnx Keyword Spotting，支持类似“小爱同学”的本地唤醒词；结合主播声纹校验，只在主播说出唤醒词时触发 Agent，降低直播音轨中的误唤醒。
- **Explore Agent**：将当前单次弹幕生成扩展为可持续决策的 Agent 循环，引入工具调用、短期与长期记忆、事件判断和行动规划，使 Agent 能根据直播上下文决定何时观察、回应、等待或执行其他操作。

## 开发

常用命令：

```powershell
vp check          # 格式化检查、Lint 和类型检查
vp test           # 运行测试
vpr build # 构建 Agent
vpr start -- single  # 构建并运行单直播间 Agent，不启用热更新
vpr dev -- explore   # 以开发模式运行 ExploreAgent，启用热更新
vpr ready # 依次执行检查、测试和构建
```

## 安全提示

- 不要提交含有真实 API Key 的配置文件、Cookie 或浏览器用户数据目录。
- 首次使用请保持 `live.sendDanmaku=false`，检查生成质量和频率后再开启发送。
- 使用自动弹幕前，请自行确认符合平台规则及直播间规范。
