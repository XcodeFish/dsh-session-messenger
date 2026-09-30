# dsh-session-messenger

DSH 跨会话协作插件（host-only，零外部导入）。让**两个独立启动的 DSH 会话**在改同一批文件前先登记占用、冲突时互相协商，消息以一等用户消息形态出现在对方聊天界面。

## v2.1 自动化层（2026-09-30）

| 层 | 机制 | 状态 |
| --- | --- | --- |
| L0 自动登记 | 进程级旁听 `internal/dispatch`（`{global:true}`）过滤 `fs/write-intent` / `fs/edit-intent`，按写入者身份自动登记 600s 短 claim——不依赖 agent 自觉 | ✅ **真实宿主终验通过**（2026-09-30）：子代理零 claim 调用纯写入 → `claims.json` 自动出现 `auto:edit` 条目（sessionId/cwd/绝对路径/TTL 全字段正确）；本地探针 `probe-l0-autoregister.mjs` 守住回归 |
| L1 冲突自动通知 | 写入撞册 → 自动给持有方发 steer 急件（空闲自动降级 queue）+ 给写入方发 queue 回执；持有方冷却 10min/（持有者,写入者,路径），写入方 60s/路径 | ✅ **持有方侧真实宿主终验通过**：子代理写入我占用的文件时，冲突告警以 steer 插话注入本会话（信封 corr/type/path/holder/writer 完整、归属正确）；写入方自动条目被 all-or-nothing 正确拦下。⚠️ 写入方侧告警对**子代理会话**失败（宿主拒绝向子代理会话 prompt：`owned by subagent routing`，与 send_to_session 同一 fail-closed 保护），需两个**持久会话**窗口才能完整复核；开关 `DSH_SESSION_MESSENGER_AUTO_NOTIFY=0` 可关 |
| L2 硬闸门（默认关） | `tools/pre-execute` 对 `write`/`edit` 工具做写前路径冲突检查，命中他人活 claim 直接 deny 并引导 send_to_session 协商 | 已实现；开关 `DSH_SESSION_MESSENGER_HARD_GATE=1` 或插件行 `config.hardGate=true`；PreToolDecision 宿主形状未实测，整段 try/catch 失败即放行 |
| v1.5 采纳杠杆 | `ctx.systemPrompt.section` 注入常驻提醒（改共享文件前先 claim_files） | 已实现 |

已知精确度边界：同路径冲突精确零误报；走文件服务的写入全覆盖（与工具名无关）；**bash 内联重定向是盲区**（子进程直写不经 fs 服务）；目录级/import 耦合级风险不在本版范围。

### L0 修复记（2026-09-30，三次线上实测踩坑全记录）

1. **作用域可见性（首测失败根因）**：宿主是在**工具执行时的 agent 作用域 ctx** 上分发瀑布的（`dsh-tool-fs/lib/index.js:583` `await ctx.waterfall("fs/write-intent", target, exec, () => void 0)`），根级插件用普通 `ctx.on('fs/write-intent')` **听不到**。正解＝宿主的进程级旁听通道 `ctx.on('internal/dispatch', (_mode, name, args) => …, { global: true })`（宿主 fs 守卫插件 `dsh-fs/lib/invariant.js:15` 同款）。直连订阅保留为兜底，重复触发无害（claim 幂等 upsert + 通知节流）。
2. **事件形状**：`args[0]` = `FsTarget { targetKey, displayPath, … }`（**没有** `.path`/`.filePath`）；`displayPath` 由宿主 `displayPathOf()` 构造为**相对 cwd 优先**（工作区内 posix 相对 / `~/` / 绝对），已按三形态归一化回绝对路径与手动 claim 对齐。`args[1]` = `exec`（ToolExecution，`.agent` 即 Agent，可取 `id` 与 `session.header.cwd`）。
3. **落盘竞态**：L0 是 fire-and-forget，write 紧接 edit 时两次原子写（tmp+rename）互相覆盖（实测 `auto:edit` 被 `auto:write` 旧快照盖掉）→ 新增 `persistCoalesced()` 脏标记合并写（飞行中再脏跑第二轮），探针两段式断言守住该回归。
4. **跨重启语义**：`registry.load()` 此前从未接线（内存表重启即空 → all-or-nothing 跨重启失效），已在 activate 时补上。

## v3 冲突协商（多轮，2026-09-30）

冲突不再只是一封告警，而是一张**可多轮往返的协商桌**（`negotiate` 工具 + 状态机 + 看门狗）。

### 协议
收到 `[[DSH session-messenger · negotiate]]` 消息后，用 `negotiate` 回一个意图：

| 意图 | 谁可以发 | 效果 |
| --- | --- | --- |
| `offer` / `counter` + `terms` | 持有方：`release-now` / `release-at`；写入方：`wait-until` | 记录条件并通知对方（只有持有方能承诺释放） |
| `accept` | 收到对方条件的一方 | 插件**执行**该条件：立即释放 / 到点自动释放 / 到点提醒写入方 |
| `decline` | 任一方 | 结束协商，各自按保守策略行动 |
| `escalate` | 任一方 | 立即请求人工裁决 |
| `status` | 任一方 | 只读查看该路径上的开放协商 |

### 边界与兜底（逐条对应一类失败模式）

| 失败模式 | 处置 |
| --- | --- |
| 沉默（无人响应） | deadline（默认 10 分钟）→ `escalated`；**默认结论 = 占用方保留 claim**，绝不自动判给写入方 |
| 持有方会话已死（子代理销毁 / 会话关闭） | 冲突时立即清孤儿 claim + 通知写入方，不等 TTL |
| 路径中途被释放 / claim 消失 | 看门狗把开放协商收敛为 `resolved` 并通知双方 |
| 模型互喷 | 每 (路径, 双方) 意图限速（默认 5s）；**被拒绝的意图退还额度**，不误伤后续合法意图 |
| 无限往返 | 轮次上限（默认 6）→ 升级人工；不设「谁先说话谁赢」的玄学 |
| 权限越界（写入方承诺释放别人的文件） | 状态机直接拒绝，并给出正确写法 |
| 重启 | 协商状态落盘 `negotiations.json`；定时器不跨重启 → 激活时补跑一次看门狗（超期升级、到点释放） |
| 事件重复投递 | 同一 fs 事件可能经 `internal/dispatch` 与直连订阅各到达一次 → 按 (kind, session, path) 1 秒去重（孤儿分支不幂等，双跑会让写入方误抢注） |

### 开关

| 环境变量 | 默认 | 含义 |
| --- | --- | --- |
| `DSH_SESSION_MESSENGER_NEGOTIATE=0` | 开 | 关闭 v3，退回 v2.1 纯告警 |
| `DSH_SESSION_MESSENGER_NEG_DEADLINE_MS` | 600000 | 每轮响应的最长等待（活性 deadline，每次意图重置） |
| `DSH_SESSION_MESSENGER_NEG_MAX_ROUNDS` | 6 | 轮次上限，超限升级人工 |
| `DSH_SESSION_MESSENGER_NEG_RATE_MS` | 5000 | 同一 (路径, 双方) 意图最小间隔 |
| `DSH_SESSION_MESSENGER_WATCHDOG_MS` | 30000 | 看门狗周期 |

### 验收状态

**真机验收通过（2026-09-30，宿主 11:10 启动加载 v0.3.0，双会话实测）**：冲突自动开桌 ✓；**持有方协商消息以 steer 投进持久会话** ✓（此前唯一不可验证的环节）；多轮往返 ✓（`offer release-at` round 1 → `accept`，落盘 `history=[offer→accept]`）；**看门狗到点释放** ✓（`pendingReleaseAt` 置零、claim 归零、双方收到终局消息）；**写入方接手** ✓（释放后 `claim_files` 成功，`B took over after negotiated release`）；硬闸门关闭时写入不被阻断 ✓。

**真机验收抓出并已修复的缺陷（v0.3.1）**：`negotiate` 的 render 原先只输出 `state=open round=N`，而 neg id / lastOffer / 释放时间都在 `detail` 字段里、**模型看不到**——对收不到协商消息的会话（子代理会话受宿主 `owned by subagent routing` 保护）协议等于不可用。现已全量带出 detail，status 增加 `you/peer/releases-at/wake-at`，并加回归断言 A5 守住该可见性。

本地真实 cordis 探针 `probe-negotiation.mjs` **18/18 通过**：开桌 / 双方通知（持有方 steer）/ 权限边界 / 多轮 offer→accept / 到点自动释放 / 沉默→升级且保守保留 / 孤儿立即清理 / 不重复开桌 / status 可见性。

## 工具

| 工具 | 作用 |
| --- | --- |
| `claim_files` | 改文件前登记占用（带 TTL，默认 1800s）。他人已占用 → 返回冲突方与到期时间，**all-or-nothing**（有冲突就一条都不登记）。 |
| `release_files` | 释放本会话的占用；省略 `paths` = 全部释放。 |
| `send_to_session` | 向同 Host 的另一个活跃会话投递消息。`mode=queue`（默认）排队为对方下一条用户消息（空闲则直接开跑）；`mode=steer` 插话进对方当前运行中的 step（空闲会失败）。消息头带 `from/corr/topic` 信封，对方用同一工具回信。 |

## 设计要点

- 注入通道是官方契约：`sessionController.prompt`（`@deepseek-ai/dsh-api-session-controller` 的 typert 生成类型，`SessionPromptRequest.mode: 'queue' | 'steer'`），不是私有 hack。
- 登记表状态存 `~/.dsh/plugin-data/dsh-session-messenger/claims.json`（插件自有存储）。**刻意不写 session event**——自定义事件类型会让 Session 拒绝重开。
- 注入策略：静态 `inject = ['tools']`；`sessions` / `sessionController` 走 `ctx.inject` 可选注入。服务缺失的 profile 里插件保持惰性，不会拖垮 profile 启动（Jet-Hub `dsh-codearts-auth` 对 `connection` 的同款处理）。
- 防死锁：claim 必带 TTL，过期自动剪枝；冲突时.all-or-nothing；发送方收到冲突后应通过 `send_to_session` 协商或换文件，而不是等待。

## 验收状态（0.1.0）

- [x] 包成型并通过本地校验（JSON 合法、双文件语法、真实 `@deepseek-ai/dsh-tools` 解析下完整 ESM 加载）
- [x] `install_bundle` 安装成功（`application: applied`，profile `desktop`；依赖行 + bundle 行均落盘核验）
- [x] bundle toggle 循环（disable→enable）落盘核验命中本插件行，未触发运行时激活
- [x] **运行时激活卡点定位并修复（2026-09-29）**：`ctx.inject(deps, cb)` 等价于
      `ctx.plugin({ inject: deps, apply: cb })`（`@deepseek-ai/cordis` src/registry.ts:300），
      回调按 `(ctx, config)` 调用（src/fiber.ts:259 `runtime.callback(this.ctx, this.config)`），
      依赖以作用域 ctx 的属性出现（`scope.sessions` / `scope.sessionController`），**不是位置参数数组**。
      旧写法把 args 当数组解构 → `sessions` 实际拿到 scope ctx 本体 →
      `activate()` 被 `typeof sessions.list !== 'function'` 静默拒掉 → 插件从未激活。
- [x] **致命崩溃修复（同上，本次恢复模式元凶）**：3 秒兜底里的 `ctx.sessions` 属性直取，
      在未把该服务写进自身 `inject` 的 ctx 上必然抛
      `cannot get property "sessions" without inject`。根因是 cordis 的两套可见性不同：
      属性访问沿祖先 fiber 的 store 查找（`sessions` 由兄弟 fiber `@deepseek-ai/dsh-session`
      提供，不可见，走到 root fiber 即抛），而 `ctx.inject` 走 ReflectService 的全局 store。
      该异常在 `setTimeout` 里抛出 = 进程级 uncaughtException = `dsh desktop host exited with 1`
      = 桌面端进恢复模式。现改为非严格 `ctx.get(name, false)` + try/catch，只诊断不致命。
- [x] 重启后核验（2026-09-29 23:2x，全新子会话地面探测）：三工具 present 且功能正常
- [x] claim_files：注册成功 + `claims.json` 落盘全字段正确 + **双活会话跨会话冲突实证**（挑战方收到 `CONFLICT: … already claimed by 9f6338da @ qait-web`，all-or-nothing 生效）
- [x] release_files：释放计数正确
- [x] send_to_session：活会话枚举、bogus 目标安全失败、self-send 保护、**向持久会话 queue 投递被宿主受理**（受理回执 "Message queued into session …"）
- [x] TTL：claim 带 expiresAt（落盘核验），到期自动剪枝
- [x] 宿主保护发现：向**子代理会话**投递被拒（"owned by subagent routing"，fail-closed），插件如实上抛——不影响两个持久会话互发
- [x] probe-cordis-load.mjs 双场景 PASS：服务齐全=3 工具 0 uncaught；服务缺失=惰性 0 uncaught
- [ ] **人工双窗口联调（2 分钟）**：A、B 两个持久会话互发，确认界面展示形态与回信链路（子代理互发被宿主路由保护拒绝，只能用真窗口测）
- [ ] 待下次重启生效的小修：label 剥 `session-` 前缀（裸 uuid 的 label 本就正确）、render 的 "queueed" 措辞；probe/冲突测试的遗留 claim 已随 TTL 自动过期

### 回归防护

`probe-cordis-load.mjs`（随包，在真实 cordis 上加载本插件；假服务由**兄弟 fiber** 提供以还原生产可见性）
覆盖三种组合，必须是「已激活 / 0 个 uncaught」：

| 场景 | 命令 | 期望 |
| --- | --- | --- |
| 服务齐全 | `node probe-cordis-load.mjs` | 注册 3 个工具，activated=true，0 uncaught |
| 服务缺失 | `SKIP_PROVIDER=1 node probe-cordis-load.mjs` | 保持惰性、0 uncaught（绝不拖垮 startup） |
| 旧 buggy 写法对照 | 指向旧版 index.js 副本 | 必现 `cannot get property "sessions" without inject` |

冻结结论：**永远不要在未声明 inject 的 ctx 上做服务属性直取来"兜底"**。

## 双会话手工验收步骤

1. 打开两个 DSH 会话 A、B（同一 Host、同一 profile）。
2. A：`claim_files { paths: ["src/foo.ts"], note: "refactoring exports" }`。
3. B：对同一文件 `claim_files` → 应收到 `conflicts[0].ownerLabel` 指向 A。
4. B：`send_to_session { target: <A 的 sessionId 前缀>, content: "我要重构 src/foo.ts 的导出，你那边还需要多久？", mode: "queue" }`。
5. 观察 A 的聊天界面出现信使消息（排队形态）→ A 回信 → B 界面出现回信。
6. 完成后各自 `release_files`。

## 边界与已知限制（v1）

- 冲突检测是**协作式**（靠 agent 主动 claim）；文件系统级硬闸门（`fs/write-intent` + `tools/pre-execute` deny）留待 v2，用灰度数据（误报率）决定是否放开自动拦截。
- `steer` 到空闲会话会失败并提示改用 `queue`，不做静默降级。
- 本插件不改写对方会话内容，只投递用户消息；对目标会话而言这是一次真实的用户输入（空闲目标会直接开跑一轮，消耗 token 属预期行为）。
