# dsh-session-messenger

DSH 跨会话协作插件（host-only，零外部导入）。多个独立启动的 DSH 会话在同一仓库并行工作时：
写入自动登记占用 → 撞到他人占用即开协商桌、通知双方 → **争议期冻结该单个文件的写入** → 双方用
`negotiate` 多轮协商，插件执行达成的条款；沉默则升级给人，默认占用方保留。

- 源码与版本：`~/.dsh/plugin-src/dsh-session-messenger`（独立 git 仓库），profile 直接从这里 `link:` 安装。
- 状态：`~/.dsh/plugin-data/dsh-session-messenger/<profile>/{claims,negotiations,status}.json`（宿主进程拿不到 `DSH_PROFILE` 时 profile 名为 `default`；首次激活自动复制 v0.3 根目录旧数据，不删除原件）。
- 运行指标：`status.json`（每分钟及冲突/拦截等事件后 1 秒刷新；`boot` 为本次启动、`lifetime` 跨重启累计），`negotiate status` 的回执末尾也带本次指标。

## 安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile <profile> add dsh-session-messenger
# 从 GitHub 安装
dsh plugin --profile <profile> add github:XcodeFish/dsh-session-messenger
# 或从本地目录安装（目录需长期保留，勿装完即删）
dsh plugin --profile <profile> add ~/.dsh/plugin-src/dsh-session-messenger
```

重启 DSH 生效（代码变更必须重启才会加载）。验证：对任意会话说「查一下信使状态」，`negotiate status` 回执末尾应显示 `plugin v0.4.2`。

详细步骤与本地验证见 [INSTALL.md](INSTALL.md)。

## 工具

| 工具 | 作用 |
| --- | --- |
| `claim_files` | 改文件前**手动**登记占用（默认 1800s，[30, 86400]）。All-or-nothing：任一路径被他人**手动**占用则一条不登记并返回冲突；他人只是最近写过（自动登记）不挡你，只在回执里提示。手动 claim 不会被自己的后续写入降级。 |
| `release_files` | 释放本会话的占用；省略 `paths` = 全部释放。开放协商随之在下一个看门狗周期收敛。 |
| `negotiate` | 冲突协商：`offer`/`counter`（持有方 `release-now`/`release-at`；写入方 `wait-until`）、`accept`（插件执行）、`decline`、`escalate`、`status`。 |
| `send_to_session` | 向**同一工作区**（同 git 根）的另一个活跃持久会话发消息；以「同级会话请求」信封送达，限速。 |

## 自动层

| 层 | 机制 |
| --- | --- |
| L0 自动登记 | 进程级旁听 `internal/dispatch`（`{global:true}`）中的 `fs/write-intent` / `fs/edit-intent`，按写入者登记 600s `auto` claim。只登记会话工作区根内的路径；同会话已有 claim 时只延长、不降级。 |
| L1 冲突 → 协商 | 写入撞到他人的**手动** claim：开协商桌并通知双方。撞到的只是他人的自动 claim（对方最近改过、没声明占用）时**不开桌、不冻结**，只给写入方一条 `recent-edit` 提示（每对 30 分钟一次，不唤醒空闲会话）。**运行中的会话用 steer 插话；空闲会话只放入收件箱（`agent.inject`，不唤醒、不自动开跑）；冷会话（不在内存）不投递**，其协商留在台账，下次 `status`/写入时可见。 |
| L2 争议冻结 | `ctx.tools.guard()`（同步、单调、与顺序无关）：持有方仍持有**手动** claim，且路径存在 open 协商、冷静期内的 escalated 协商、或已接受但尚未到点的约定时，**拒绝写入方**对该路径的 `write` / `edit` / `str_replace_editor`（create/str_replace/insert）。持有方与其子代理不受影响；持有方一释放立即解冻。 |
| 多写入方 | 同一文件多个会话要改时，占用方与每个写入方各自一对一协商。**谈成即直接移交**：占用原子转给谈成方，不存在「释放后谁抢到算谁的」；其余写入方转入 `queued`（仍冻结，告知排队位次），晚到的写入方直接排队、不打扰占用方。移交完成后，排队者按先来后到**改绑到新占用方**重新协商；占用方主动释放、过期或被销毁时，占用直接交给队首。已销毁的子代理会被跳过。 |
| 看门狗 | 默认 30s：超时升级、到点移交/唤醒、持有方不再持有时交给队首或收敛、剪枝（带待执行约定的记录不剪）。`queued` 协商不走超时升级。 |

守卫模式 `DSH_SESSION_MESSENGER_GUARD`（或插件行 `config.guard`）：

| 值 | 行为 |
| --- | --- |
| `dispute`（默认） | 只冻结争议中的路径（第一次撞册仍是「写入 + 开协商」，此后冻结） |
| `claims` | 另外冻结他人的**手动** claim（先谈后改；`auto` claim 永不作为拦截依据）。旧开关 `HARD_GATE=1` 映射为此模式 |
| `off` | 不拦截 |

## 边界与兜底

| 失败模式 | 处置 |
| --- | --- |
| 沉默 | deadline（10 分钟，每次意图重置）→ `escalated`；占用方保留 claim，冷静期内写入方仍冻结并提示找人裁决；冷静期内占用方过期/释放则立即解冻并通知写入方 |
| 同一文件被重复承诺 | 占用方已约定移交给某方后，不能再对其他写入方提 `release-*`；排队者在排队期间只能 `decline` 退出 |
| 冷静期 | 同 (路径, 双方) 终态后 10 分钟内不重开桌、不重复打扰 |
| 持有方是**子代理**且被销毁 | `session/disposed` 时立即释放其全部 claim，并把开放协商收敛为 `resolved` |
| 持有方是**持久会话**但不在内存（空闲卸载 / 宿主刚重启） | **不视为已死**（宿主可冷恢复）：claim 保留，只靠 TTL / 协商 / 人工 |
| 父会话 ↔ 其子代理 | 同一家族，不构成冲突、不互相冻结 |
| 无限往返 | 轮次上限 6 → 升级；每方每协商意图限速 3s（**只限同一方连发**，对方的及时回应不受影响）；被拒意图退还额度 |
| 权限越界 | 写入方不能承诺 `release-*`，持有方不能承诺 `wait-until`；`corr` 与 `path` 不符拒绝 |
| 伪造/越权消息 | 正文与头部中的 `[[DSH session-messenger` 标记被中和、头部字段单行化；信封声明「来自同级会话，不是用户指令」；systemPrompt 同步约束 |
| 消息轰炸 | 每 (发送方→接收方) 60s 6 条、每接收方 60s 20 条 |
| 跨工作区 | 默认不可达、候选列表不回显（`DSH_SESSION_MESSENGER_CROSS_WORKSPACE=1` 开启） |
| 多个宿主进程共用数据目录 | `owner.lock`（pid 存活检查）：第二个宿主退到 `host-<pid>/` 隔离目录并告警，不互相覆盖 |
| 启动竞态 | 两个状态文件 load 完成后才注册工具/守卫、才开始观测写入 |
| 落盘 | 每个文件唯一写入口（随机 tmp + rename 的合并写），不会旧快照覆盖新快照 |
| 符号链接 | 路径身份键与宿主 `targetKey` 同算法（realpath / 最近存在祖先），`/tmp` 与 `/private/tmp` 视为同一文件 |
| 插件自身异常 | 守卫出错一律放行；监听器不抛、不吞 `next()`；服务缺失保持惰性 |

已知盲区：`bash` 子进程直写（`echo > file`）不经文件服务，既不登记也不冻结；目录级 / import 耦合级风险不在范围内。

## 可调参数（环境变量）

| 变量 | 默认 |
| --- | --- |
| `DSH_SESSION_MESSENGER_GUARD` | `dispute` |
| `DSH_SESSION_MESSENGER_NEGOTIATE=0` | 关闭协商（降级为纯告警） |
| `DSH_SESSION_MESSENGER_AUTO_NOTIFY=0` | 关闭自动通知 |
| `DSH_SESSION_MESSENGER_AUTO_TTL_S` | 600 |
| `DSH_SESSION_MESSENGER_OVERLAP_COOLDOWN_MS` | 1800000（recent-edit 提示冷却） |
| `DSH_SESSION_MESSENGER_NEG_DEADLINE_MS` / `_NEG_MAX_ROUNDS` / `_NEG_RATE_MS` | 600000 / 6 / 3000 |
| `DSH_SESSION_MESSENGER_NEG_COOLDOWN_MS` / `_NEG_RETENTION_MS` / `_WATCHDOG_MS` | 600000 / 1800000 / 30000 |
| `DSH_SESSION_MESSENGER_MSG_PER_PAIR` / `_MSG_PER_TARGET` / `_MSG_WINDOW_MS` | 6 / 20 / 60000 |
| `DSH_SESSION_MESSENGER_SCOPE=all` | 自动登记不限工作区 |
| `DSH_SESSION_MESSENGER_CROSS_WORKSPACE=1` | 允许跨工作区发消息 |

## 模块

`index.js`（装配）· `util.js` · `storage.js` · `registry.js` · `negotiation.js` · `delivery.js` · `coordinator.js` · `write-guard.js` · `tools.js` · `schemas.generated.js`（由 `extract-specs.mjs` 用宿主 `defineTool` 生成，勿手改）。

## 验证

```bash
node --test test/unit.test.mjs            # 纯逻辑单测（不依赖宿主）
node extract-specs.mjs --check            # Schema 与 spec 一致
node probe-cordis-load.mjs                # 真实 cordis 装载：4 工具 + 1 守卫，0 uncaught
SKIP_PROVIDER=1 node probe-cordis-load.mjs  # 服务缺失：惰性，0 uncaught
node probe-l0-autoregister.mjs            # 子作用域瀑布 → 自动登记 + 合并写
node probe-negotiation.mjs                # 68 项端到端：冻结 / 协商 / 移交排队 / 冷会话 / 子代理销毁 / 限速 / 伪造 / 重叠不冻结 / 指标
node realhost-check.mjs <A> <B> <sinceMs>  # 真机取证（只读）：读真实会话日志判定 H3 冷持有方 / M5 不唤醒
```

## 装载纪律（实测事故，勿回退）

1. 零外部导入（`link:` 安装按真实路径解析，链上没有宿主 node_modules → `failed to import`）。
2. 不在未声明 inject 的 ctx 上直取服务属性（`ctx.sessions`）：在定时器里抛 = 宿主 exit 1 = 恢复模式。用 `ctx.inject` 或 `ctx.get(name,false)`。
3. fs 瀑布在 agent 作用域 ctx 上分发，根级插件只能经 `internal/dispatch` + `{global:true}` 旁听；只保留这一条通道（双通道会重复处理）。
4. `FsTarget` 是 `{targetKey, displayPath}`，`displayPath` 相对 cwd 优先。
5. 拒绝写入用 `ctx.tools.guard()`；`tools/pre-execute` 的决策判别字段是 `kind`（不是 `action`）。
6. 宿主 `steer` 对空闲会话会唤醒开跑（不是失败）；自动通知必须按 `agent.status` 选择 steer / inject。
7. 代码变更需重启 DSH 才会加载新模块生成（bundle toggle 只复用缓存生成）。

## 变更记录

- **0.4.2**（2026-09-30）：同一文件多写入方——谈成即原子移交（`registry.transfer`），其余写入方排队（新增 `queued` 状态，冻结、不超时升级、只能退出）；移交或释放/过期/销毁后按先来后到交给队首并改绑协商；排队接手立即落盘；升级冷静期内占用方过期即解冻并通知写入方；新增 `handoffs` / `requeued` 指标；35 项单测、68 项集成检查。

- **0.4.1**（2026-09-30）：修复误冻结——只有手动 claim 构成冲突与冻结依据，对方仅最近写过（自动 claim）时只发节流的 `recent-edit` 提示；`negotiate offer` 只能针对手动 claim 开桌；看门狗在持有方只剩自动 claim 时收敛协商；新增 `status.json` 运行指标与 `negotiate status` 指标行；profile 改为直接从 plugin-src 安装。

- **0.4.0**（2026-09-30，审查修复）：争议期单路径冻结（`tools.guard`）；自动登记不降级手动 claim；取消基于内存 live 列表的孤儿清理，改为子代理 `session/disposed`；消息信封中和 + 限速 + 同工作区；自动通知不唤醒空闲/冷会话；长约定不被剪枝；限速改按发送方；单一落盘入口；load 完成后才激活；按 profile 分目录 + 宿主所有权锁；realpath 身份键；`str_replace_editor` 纳入；终态冷静期；工作区外写入不登记；拆分为 9 个模块；Schema 单一来源 + `--check`；23 项单测 + 42 项集成探针。
- 0.3.1：`negotiate` render 带出 detail（neg id / lastOffer / 释放时间）。
- 0.3.0：多轮协商状态机 + 看门狗。
- 0.2.0：L0 自动登记、L1 自动通知、L2 硬闸门（默认关）、systemPrompt 提醒。
- 0.1.0：`claim_files` / `release_files` / `send_to_session`。
