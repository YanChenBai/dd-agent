# DD Agent 改进 TODO

目标：先修复直播结束后的退出语义和资源回收，再建立本地可观测性基础，最后补齐性能、稳定性与外部观测后端。

## 约定的结束语义

- `single` 模式：直播自然结束属于正常退出，关闭全部资源，CLI 退出码为 `0`。
- `explore` 模式：当前直播结束后立即结束本房间观察，记录原因并回到选房循环；Explore 总任务不因此失败。
- 手动 `Ctrl+C`：属于取消，关闭全部资源，不记录为组件故障。
- 达到 `stopAfterMs` 或 `maxRunMs`：属于正常超时结束。
- FFmpeg、ASR、Vision、Brain 或 Browser 在直播仍进行时异常退出：属于故障，应携带组件和原因结束或降级。

---

## P0：修复直播结束无法正确退出

### 1. 建立统一的停止原因模型

- [x] 在 `src/dd` 定义 `DDStopReason`：
  - `live-ended`
  - `manual-stop`
  - `signal`
  - `timeout`
  - `component-failure`
- [x] 定义 `DDStopResult`，至少包含 `reason`、`roomId`、`startedAt`、`endedAt`、`error?`。
- [x] 让 `stop()` 接收停止原因，并保证第一次原因生效，后续重复调用不覆盖。
- [x] 让 `waitForStop()` 返回 `DDStopResult`；只有 `component-failure` 抛出错误。
- [x] 增加状态转换保护，确保 `starting -> running -> stopping -> stopped` 只发生一次。

验收标准：

- [x] 重复调用 `stop()` 不会重复关闭资源，也不会改变最初的停止原因。
- [x] 直播自然结束时 `waitForStop()` 正常 resolve。
- [x] 真正的组件故障仍能被调用方识别。

### 2. 为 Bilibili API 增加可取消的直播状态查询

- [x] 让 `fetchRoomInfo`、`fetchRoomUserInfo`、`fetchPlayInfo` 接收可选 `AbortSignal`。
- [x] 明确配置请求超时与重试策略，不依赖库默认值。
- [x] 新增 `isRoomLive(roomId, signal)` 或等价帮助函数。
- [x] 区分网络错误、Bilibili 业务错误、直播未开播三种情况。
- [ ] 不在日志中输出带签名的 FLV URL、Cookie 或 API Key。

验收标准：

- [x] 关闭 DD 时，正在执行的直播状态请求可以被取消。
- [x] 网络暂时失败不会被误判为直播结束。

### 3. 检测直播自然结束与媒体流假活

- [x] 在 `blive` 中记录最后一次音频、视频和任意媒体数据到达时间。
- [x] 增加媒体 watchdog：超过阈值没有任何媒体数据时触发健康检查。
- [x] FFmpeg 自然关闭时查询一次直播状态：
  - 房间已下播：发出 `live-ended` 事件。
  - 房间仍开播：发出 `component-failure`，保留退出码和 signal。
  - 状态查询失败：按有限次数退避重试，不能直接判断为下播。
- [x] FFmpeg 仍存活但媒体长期不再更新时执行同样的状态判断。
- [x] 可选：房间仍开播但流断开时，重新获取 FLV 地址并有限次数重启 FFmpeg。
- [x] 将 watchdog 阈值、状态检查周期、最大重启次数和退避时间加入配置。

验收标准：

- [x] 下播后无需用户按 `Ctrl+C`，单房间模式可自动退出。
- [x] FFmpeg 假活但无媒体数据时能在规定时间内退出或重连。
- [x] 短暂网络抖动不会立刻结束任务。

### 4. 将所有子模块错误接入顶层生命周期

- [x] 在 `createDD` 中监听并解绑：
  - `vision.onError`
  - `brain.onError`
  - `hand.onError`
  - `blive` 的 `live-ended`/健康状态事件
- [x] 给错误分类：`fatal`、`degraded`、`recoverable`。
- [ ] 明确策略：
  - FFmpeg/Hearing 持续不可用：fatal。
  - Vision 单次拼图失败：recoverable；连续失败达到阈值再 fatal/degraded。
  - Brain 单次请求失败：recoverable；连续失败达到阈值后停止或降级。
  - Hand 失败且未开启实际弹幕发送：degraded，不应终止观看。
- [x] 确保每个事件订阅都在关闭阶段解绑。

验收标准：

- [x] 不再出现子模块已经停止、顶层仍显示运行中的状态。
- [x] 预览模式下浏览器发送模块失败不会误杀音视频观察。

### 5. 修正 Explore 模式的房间结束行为

- [x] 给 `WatchedRoomSummary` 增加 `endReason`。
- [x] 当当前 DD 因 `live-ended` 停止时，立即结束 `waitForWatchCheckpoint`，不要继续等待原定计时器。
- [x] 记录实际观察时长和结束原因。
- [x] 将下播房间标记为不可再次选择或从候选中移除。
- [x] 返回 Explore 选房循环，继续结构化 JSON 决策。
- [x] 当前房间组件故障时，根据错误类型选择跳过房间或终止整个 Explore。

验收标准：

- [x] 当前直播下播后，Explore 在数秒内关闭当前 DD 并继续选房。
- [x] 下播房间不会被模型再次选择。

### 6. 强化关闭与资源回收

- [x] 将关闭流程改成 `Promise.allSettled` 或等价的“全部尝试关闭”逻辑。
- [x] 分别记录 Vision、Hearing、Brain、FFmpeg、Browser、Memory 的关闭耗时和结果。
- [x] 即使某个组件关闭失败，也继续关闭其余组件。
- [x] 给整体关闭增加超时和最终错误汇总。
- [x] 确保 Memory 清理在其他组件失败时仍会执行。
- [x] 确保 `waitForStop()` 只在所有关闭动作完成后返回。

验收标准：

- [x] 任意一个组件的 `stop()` 抛错时，其他组件仍会收到关闭调用。
- [x] Chrome、FFmpeg、定时器和事件监听器不残留。

### 7. 补齐直播结束回归测试

- [x] FFmpeg 关闭且房间已下播：正常返回 `live-ended`。
- [x] FFmpeg 关闭但房间仍开播：返回 `component-failure`。
- [x] FFmpeg 存活但无音视频：watchdog 触发状态检查。
- [x] 状态查询网络失败：不会误判下播。
- [x] 停止、下播和 FFmpeg close 同时发生：只关闭一次。
- [ ] `single` 模式直播结束后 CLI 正常退出。
- [x] `explore` 模式直播结束后立即切换候选。
- [x] 一个组件清理失败时，其他组件仍完成清理。

---

## P1：轻量本地可观测性

### 8. 简短日志上下文

- [x] 新增 `src/observability` 模块。
- [x] 上下文只保留 `mode`、`roomId?`、`component`。
- [x] 将房间上下文传递到 Blive/Hearing/Vision/Brain/Hand。
- [x] 移除模块级全局 logger。
- [x] 终端前缀保持简短：例如 `[brain room=123]`，不引入 `runId` 或 `roomSessionId`。
- [x] Explore 切换房间时通过 `roomId` 区分日志。

### 9. 仅终端日志，不做持久化

- [x] 保留彩色终端日志。
- [x] 不创建 `.dd-observability`，不写 JSONL。
- [x] API Key、Cookie、Bearer token 和签名 URL 在输出前脱敏。
- [x] 将 `room-catalog.ts` 的 `console.log` 接入统一 logger。

### 10. 周期摘要

- [x] 不引入通用指标注册表，直接读取各组件已有 stats。
- [x] 每 30 秒在终端输出一次运行摘要。
- [x] 退出时在终端输出最终摘要。
- [x] 摘要包含：运行时长、房间、媒体新鲜度、ASR 队列、Memory 条数、AI 调用与 token、弹幕发送结果。

建议摘要：

```text
run 12m | room 123 | audio lag 0.8s | frame age 4s | ASR queue 2.1s | AI 12 calls / 3.8k tokens | send 2/2
```

---

## P1：核心管线指标

### 11. 媒体与 FFmpeg

- [x] 音频字节数、音频 chunk 数、视频帧数。
- [x] 最后音频/视频/任意媒体数据年龄。
- [ ] 媒体时间与本地接收时间的延迟。
- [x] FFmpeg 启动耗时、运行时长、退出码、signal。
- [x] SIGTERM 超时和 SIGKILL 次数。
- [x] FLV 地址刷新和 FFmpeg 重启次数。

### 12. Hearing/ASR 背压

- [x] 待识别段数。
- [x] 待识别音频总秒数。
- [ ] 单段音频长度和识别耗时。
- [x] Real-time factor：`decodeMs / audioDurationMs`。
- [ ] 空识别结果数和比例。
- [ ] VAD 产生段数、识别成功数、失败数。
- [x] 超过积压阈值时丢弃/合并的段数。

验收标准：

- [x] 能明确判断 ASR 是实时、轻微落后还是持续积压。
- [x] 队列有硬上限，不会无限持有 `Float32Array`。

### 13. Vision 与 Memory

- [ ] 收到帧数、缓存帧数。
- [ ] 因帧不足或正在合成而跳过的周期数。
- [ ] 拼图耗时、成功/失败次数、输出字节数。
- [ ] Memory 中 hearing/vision 数量。
- [ ] Vision 文件数量、磁盘占用、清理数量和清理失败数。
- [ ] 文件读写耗时。

### 14. AI 请求与决策

- [ ] Brain 和 Explore 的请求次数、耗时、成功/失败。
- [x] 记录 AI SDK `usage`：input/output/total tokens。
- [x] 完全结束并关闭所有资源后，输出选房、直播间 Brain 和总计 Token 消耗报告。
- [ ] 记录模型、finish reason、结构化输出解析失败。
- [ ] 记录请求携带的 hearing 条数、图片数、历史轮数。
- [ ] 记录空弹幕、生成弹幕、预览和发送数量。
- [x] 记录 Explore 的 `continue`、`roomId`、`reason` 和选房合法性。
- [x] Explore 结构化决策恢复 `requestTimeoutMs`；当前不再执行长时间工具，可以安全使用单次请求超时。

### 15. Browser/Hand

- [ ] Browser 启动、登录检测、导航、播放器 ready 的耗时。
- [ ] Hand 状态转换事件。
- [ ] 页面脚本错误与请求失败按类型聚合。
- [ ] 弹幕队列长度、等待时间、发送成功/失败数。
- [ ] 失败时记录平台返回 code，但不记录 Cookie。

### 16. Explore 页面抓取

- [ ] 每批导航和总抓取耗时。
- [ ] 每次滚动前后的 `scrollY`、`scrollHeight`。
- [ ] 滚动尝试数、停滞次数和停止原因。
- [ ] 原始候选数、去重后新增数、排除数。
- [ ] 用 DOM 变化/候选变化等待替代固定 `sleep(1_000)`。
- [ ] 区分“滚动到底”“页面未加载”“验证码/登录拦截”。

---

## P2：稳定性和性能优化

### 17. 异步化 Memory 文件操作

- [ ] 将图片写入、读取、删除改为异步 `fs/promises`。
- [ ] 避免在媒体回调和模型请求准备阶段阻塞事件循环。
- [ ] 为文件不存在和清理冲突保留幂等行为。

### 18. 清理配置与 magic numbers

- [ ] 将 FFmpeg 抽帧周期、Vision 合成周期、页面超时、滚动等待、发送间隔、watchdog 阈值加入配置。
- [ ] 为配置补充 Zod 校验、示例和测试。
- [ ] 启动时输出脱敏后的有效配置摘要。

### 19. Explore 数据质量与遗留清理

- [ ] 按实际卡片 DOM 分别提取主播名和直播标题，避免两者都取自 `imageAlt`。
- [ ] 删除或改造已经不再被主流程使用的 `src/dd/explore/tools.ts`。
- [ ] 更新 README 中旧的工具循环、候选翻页和观看时长描述。
- [ ] 为无效 `roomId` 增加一次带纠错信息的模型重试，而不是直接终止 Explore。

### 20. 外部观测后端（可选）

- [ ] 在本地事件和指标稳定后再引入 OpenTelemetry。
- [ ] 将一次 CLI 运行为 root trace，一次房间观察为 child span。
- [ ] 为 Bilibili API、FFmpeg 启动、ASR、Vision、AI、Browser 发送建立 spans。
- [ ] 通过 OTLP 输出到选定后端；保持 JSONL 本地降级能力。
- [ ] 默认不上传字幕、图片、弹幕内容等敏感数据。

---

## 每个阶段的验证命令

- [ ] 运行相关模块的定向测试。
- [ ] `vp check`
- [ ] `vp test`
- [ ] `vp run build`
- [ ] 手工验证 single：正常下播、网络断开、`Ctrl+C`。
- [ ] 手工验证 explore：下播切房、无新增候选、模型超时、总运行超时。

## 推荐提交顺序

1. `fix: model dd stop reasons and live-ended lifecycle`
2. `fix: detect ended and stalled live streams`
3. `fix: make explore leave ended rooms immediately`
4. `fix: make cleanup exhaustive and idempotent`
5. `feat: add observability context and structured logs`
6. `feat: add media asr vision and ai metrics`
7. `perf: add asr backpressure and async memory io`
8. `docs: update runtime behavior and observability guide`
