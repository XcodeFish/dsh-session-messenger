/**
 * dsh-session-messenger — DSH 跨会话协作插件（host-only, 零外部导入）。
 *
 * 三个 agent 工具：
 * - claim_files     改文件前登记占用；他人已占用则返回冲突（all-or-nothing）。
 * - release_files   释放本会话的占用（省略 paths = 全部释放）。
 * - send_to_session 向同 Host 的另一个活跃会话定向投递消息，
 *   走官方 sessionController.prompt({sessionId, mode:'queue'|'steer', content}) 通道：
 *   queue = 排队为对方下一条用户消息（空闲则直接开跑，运行中则等待下一轮），
 *   steer = 插话进对方当前运行中的 step（空闲则失败并提示改用 queue）。
 *
 * v2.1 自动化层（2026-09-30）：
 * - L0 自动登记：订阅 fs/write-intent + fs/edit-intent 瀑布（文件服务每次写入前的
 *   决策点，事件自带 actor），按写入者身份自动登记短 TTL（600s）claim——登记册从
 *   「自觉申报」升级为「系统台账」。注册表本身仍 all-or-nothing：撞他人 claim 时不
 *   抢注，转为 L1 通知。
 * - L1 冲突自动通知：写入撞册时自动给双方投递结构化告警——持有方 steer 优先
 *   （空闲自动降级 queue，不丢消息）、写入方 queue（冷却 60s/路径）；持有方冷却
 *   10min/（持有者,写入者,路径），避免闲会话被反复唤醒。
 * - L2 硬闸门（默认关）：tools/pre-execute 对 write/edit 工具做写前路径冲突检查，
 *   命中他人活 claim 直接 deny 并引导协商。开关：env DSH_SESSION_MESSENGER_HARD_GATE=1
 *   或插件行 config.hardGate=true。PreToolDecision 的宿主确切形状未实测，故整段
 *   try/catch 包裹：任何内部错误一律放行（return next()），绝不影响其他工具。
 * - v1.5 采纳杠杆：ctx.systemPrompt.section 注入一段常驻提醒（改共享文件前先
 *   claim_files），把协作协议从「靠模型自觉」提升为「被 prompt 规则约束」。
 *
 * 工程约束（每一条都来自实测教训）：
 * - 零外部导入：只允许 node 内置模块 + 相对文件。本包经 link: 安装到 profile，
 *   Node 按真实路径（工作区）解析导入，链上没有宿主 app 的 node_modules，
 *   import '@deepseek-ai/dsh-tools' 会导致 "failed to import"（2026-09-29 实测）。
 *   因此 parameters / output.schema 直接内联「编译后」的 JSON Schema ——
 *   由宿主真实 defineTool 离线编译生成（见 extract-specs.mjs），形状与
 *   register(defineTool(spec)) 的产物逐字一致。
 * - 激活双路径：静态 inject 只声明 ['tools']；sessions / sessionController 主路径走
 *   apply 内 ctx.inject(['sessions','sessionController'], (scope) => …) 可选注入，
 *   3 秒兜底只用非严格 ctx.get(name, false) 探测；两路皆失败则插件保持惰性，
 *   绝不拖垮 profile 启动（Jet-Hub 的教训）。
 * - 禁止在未声明 inject 的 ctx 上直取服务属性（ctx.sessions）：cordis 会抛
 *   `cannot get property "…" without inject`；定时器里的未捕获异常 = 宿主 fatal exit 1
 *   = 桌面端进恢复模式（2026-09-29 实测事故，见文末 apply 注释）。
 * - 瀑布监听器绝不抛错、绝不吞 next()：fs/write-intent 里只做旁路观测（同步登记 +
 *   异步通知），登记在单 tick 内同步完成以消除竞态，persist/通知全部 fire-and-forget，
 *   不给写入路径增加可感知延迟（practices.md：不拥有决策权必须 return next()）。
 */
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ClaimRegistry } from './registry.js';
import { NegotiationStore } from './negotiation.js';

export const name = 'session-messenger';
export const inject = ['tools'];

const DEFAULT_TTL_SECONDS = 1800;
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 86400;
const MAX_PATHS = 50;
const MAX_CONTENT_CHARS = 20000;
const MAX_CANDIDATES = 20;
const SERVICE_FALLBACK_MS = 3000;
const AUTO_CLAIM_TTL_SECONDS = 600;
const HOLDER_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
const WRITER_NOTIFY_COOLDOWN_MS = 60 * 1000;
const NOTIFY_TIMEOUT_MS = 10000;
// ---- v3 协商（多轮冲突解决）----
const NEG_DEADLINE_MS = 10 * 60 * 1000;
const NEG_MAX_ROUNDS = 6;
const NEG_RATE_MS = 5000;
const WATCHDOG_INTERVAL_MS = Number(process.env.DSH_SESSION_MESSENGER_WATCHDOG_MS) || 30000;
const NEG_RETENTION_MS = 30 * 60 * 1000;

function negotiationEnabled() {
  return process.env.DSH_SESSION_MESSENGER_NEGOTIATE !== '0';
}

function shortId(id) {
  // 会话 id 形如 "session-<uuid>"（持久会话）或裸 "<uuid>"（子会话）；剥前缀再截，避免得到无意义的 "session-"。
  return String(id || '')
    .replace(/^session-/, '')
    .slice(0, 8);
}

function defaultDataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'plugin-data', 'dsh-session-messenger');
}

function labelFor(id, cwd) {
  const base = cwd ? path.basename(String(cwd)) : '';
  return base ? `${shortId(id)} @ ${base}` : shortId(id);
}

function clampTtl(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(Math.round(n), MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

/** L2 硬闸门开关：env 优先，插件行 config 兜底；默认关。 */
function hardGateEnabled(config) {
  if (process.env.DSH_SESSION_MESSENGER_HARD_GATE != null) {
    return process.env.DSH_SESSION_MESSENGER_HARD_GATE === '1';
  }
  if (config && config.hardGate === true) return true;
  return !!(config && config.hardGate && config.hardGate.enabled === true);
}

function autoNotifyEnabled() {
  return process.env.DSH_SESSION_MESSENGER_AUTO_NOTIFY !== '0';
}

/** 非严格服务探测：永不抛错（ctx.get(name, false)），不满足时返回 undefined。 */
function safeGet(ctx, name) {
  try {
    if (typeof ctx.get !== 'function') return undefined;
    return ctx.get(name, false);
  } catch {
    return undefined;
  }
}

/**
 * fs 意图事件信息提取（形状依据宿主源码实测，2026-09-30）：
 * - target = FsTarget { targetKey（不透明身份）, displayPath（展示路径）, … }，
 *   没有 .path/.filePath 等字段——早前按猜测取值是 L0 首测失败的根因。
 * - displayPath 由宿主 displayPathOf() 构造：工作区内 = 相对 cwd 的 posix 相对路径；
 *   home 内 = "~/…"；否则绝对路径。须归一化回绝对路径才能与手动 claim（绝对路径）对齐。
 * - actor = { agent: Agent, … }（宿主观察策略以 actor?.agent?.session 为归属键），
 *   Agent 上有 id（SessionId）与 session.header.cwd。
 */
function intentInfo(target, actor) {
  if (!target || typeof target !== 'object') return undefined;
  const display = typeof target.displayPath === 'string' ? target.displayPath.trim() : '';
  if (!display) return undefined;
  const agent = actor && typeof actor === 'object' ? actor.agent : undefined;
  const sessionId = agent && typeof agent.id === 'string' ? agent.id : '';
  const cwd = (agent && agent.session && agent.session.header && agent.session.header.cwd) || '';
  let abs;
  if (display.startsWith('~/')) {
    abs = path.join(os.homedir(), display.slice(2));
  } else if (path.isAbsolute(display)) {
    abs = path.normalize(display);
  } else if (cwd) {
    abs = path.resolve(cwd, display);
  } else {
    return undefined; // 无 cwd 无法定位绝对路径：宁缺毋滥，不把不可对齐的形状写进注册表
  }
  return { absPath: path.normalize(abs), sessionId, cwd };
}

/** 冷却节流：同一 key 在 windowMs 内只放行第一次。超过容量整体清空（防御性）。 */
function createThrottle() {
  const map = new Map();
  return (key, windowMs) => {
    if (map.size > 512) map.clear();
    const last = map.get(key) || 0;
    if (Date.now() - last < windowMs) return false;
    map.set(key, Date.now());
    return true;
  };
}

/** 调用方身份：sessionId 必须可解析，否则工具明确报错（不静默猜）。 */
function callerInfo(exec, cwdOverride) {
  const agent = exec && exec.agent;
  const sessionId =
    (agent && agent.id) ||
    (agent && agent.session && agent.session.header && agent.session.header.id) ||
    (exec && exec.sessionId);
  if (!sessionId) {
    throw new Error('caller session id unavailable (tool executed without an agent context)');
  }
  const cwd =
    (cwdOverride && String(cwdOverride)) ||
    (agent && agent.session && agent.session.header && agent.session.header.cwd) ||
    (agent && agent.options && agent.options.cwd) ||
    '';
  return { sessionId: String(sessionId), cwd: cwd ? String(cwd) : '' };
}

/** 归一化请求路径：绝对路径直接 normalize；相对路径基于调用方 cwd 解析。 */
function normalizePaths(rawPaths, cwd) {
  const out = [];
  const unresolvable = [];
  for (const raw of rawPaths) {
    const value = String(raw || '').trim();
    if (!value) continue;
    if (path.isAbsolute(value)) {
      out.push(path.normalize(value));
    } else if (cwd) {
      out.push(path.resolve(cwd, value));
    } else {
      unresolvable.push(value);
    }
  }
  return { paths: [...new Set(out)], unresolvable };
}

function sessionCandidates(sessions) {
  const seen = new Set();
  const list = [];
  for (const session of sessions.list()) {
    const id =
      (session && session.id) ||
      (session && session.header && session.header.id) ||
      (session && session.sessionId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const cwd =
      (session && session.header && session.header.cwd) ||
      (session && session.cwd) ||
      '';
    list.push({ id: String(id), cwd: cwd ? String(cwd) : '' });
  }
  return list;
}

function candidateRows(list) {
  return list.slice(0, MAX_CANDIDATES).map((entry) => ({
    sessionId: entry.id,
    label: labelFor(entry.id, entry.cwd)
  }));
}

// ---------------------------------------------------------------------------
// 编译后的 JSON Schema（由宿主真实 defineTool 离线编译，见 extract-specs.mjs）。
// ---------------------------------------------------------------------------

const CLAIM_FILES_PARAMETERS = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      description:
        'File paths you intend to modify. Workspace-relative paths resolve against this session cwd; absolute paths are kept.',
      items: { type: 'string' }
    },
    ttl_seconds: {
      type: 'number',
      description: 'Claim lifetime in seconds; default 1800, clamped to [30, 86400].'
    },
    note: {
      type: 'string',
      description: 'Short intent note shown to a conflicting session, e.g. "refactoring exports".'
    },
    cwd: {
      type: 'string',
      description:
        'Optional explicit absolute workspace root used to resolve relative paths; defaults to the calling session cwd.'
    }
  },
  required: ['paths']
};

const CLAIM_FILES_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    sessionId: { type: 'string' },
    registered: { type: 'boolean' },
    expiresAt: { type: 'integer' },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          ownerSessionId: { type: 'string' },
          ownerLabel: { type: 'string' },
          expiresAt: { type: 'integer' },
          note: { type: 'string' }
        },
        required: ['path', 'ownerSessionId', 'ownerLabel', 'expiresAt', 'note']
      }
    },
    hint: { type: 'string' }
  },
  required: ['ok', 'sessionId', 'registered', 'expiresAt', 'conflicts', 'hint']
};

const RELEASE_FILES_PARAMETERS = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      description:
        'Specific paths to release (absolute or relative to this session cwd). Omit to release everything claimed by this session.',
      items: { type: 'string' }
    }
  }
};

const RELEASE_FILES_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    sessionId: { type: 'string' },
    released: { type: 'integer' },
    hint: { type: 'string' }
  },
  required: ['ok', 'sessionId', 'released', 'hint']
};

const SEND_TO_SESSION_PARAMETERS = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      description:
        'Target session id (exact, or a unique id prefix). On failure the tool lists live session candidates.'
    },
    content: {
      type: 'string',
      description:
        'Message body for the target session. Be concrete: what you need, which files, and what you propose.'
    },
    mode: {
      type: 'string',
      description:
        "'queue' (default) = next turn, safe; 'steer' = interject into the target's current step, only while it is running.",
      enum: ['queue', 'steer']
    },
    topic: {
      type: 'string',
      description: 'Optional short topic label, e.g. "claim conflict on src/x.ts".'
    }
  },
  required: ['target', 'content']
};

const SEND_TO_SESSION_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    target: { type: 'string' },
    mode: { type: 'string' },
    delivered: { type: 'boolean' },
    detail: { type: 'string' }
  },
  required: ['ok', 'target', 'mode', 'delivered', 'detail']
};

// --- negotiate（v3）编译后 Schema，由 extract-specs.mjs 用宿主真实 defineTool 生成 ---
const NEGOTIATE_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description:
        'offer/counter = propose resolution terms; accept = accept the pending offer of the peer; decline = refuse to negotiate; escalate = ask for human arbitration; status = read-only view of your open negotiations.',
      enum: ['offer', 'counter', 'accept', 'decline', 'escalate', 'status']
    },
    path: {
      type: 'string',
      description: 'Contested file path (absolute or workspace-relative to this session cwd).'
    },
    corr: {
      type: 'string',
      description:
        'Negotiation id from a [[DSH session-messenger · negotiate]] message; use it when several negotiations are open for the same path.'
    },
    terms: {
      type: 'object',
      description:
        'Resolution terms. Only the current claim holder may offer release-now / release-at; the writer may offer wait-until.',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          description:
            'release-now = holder frees the claim immediately; release-at = holder frees it at terms.at (ISO-8601); wait-until = writer commits to wait until terms.at and is reminded then.',
          enum: ['release-now', 'release-at', 'wait-until']
        },
        at: {
          type: 'string',
          description: 'ISO-8601 timestamp (required for release-at / wait-until, within 60 minutes).'
        }
      },
      required: ['action']
    },
    message: { type: 'string', description: 'Optional free-text note delivered to the peer with this intent.' }
  },
  required: ['action', 'path']
};

const NEGOTIATE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    negId: { type: 'string' },
    path: { type: 'string' },
    state: { type: 'string' },
    rounds: { type: 'integer' },
    deadline: { type: 'integer' },
    released: { type: 'boolean' },
    detail: { type: 'string' }
  },
  required: ['ok', 'negId', 'path', 'state', 'rounds', 'deadline', 'released', 'detail']
};

export function apply(ctx, config) {
  const logger = ctx && ctx.logger;
  if (!ctx || typeof ctx.inject !== 'function' || !ctx.tools || typeof ctx.tools.register !== 'function') {
    logger?.warn?.('[session-messenger] host tool registry unavailable; plugin stays inert');
    return;
  }

  /** @type {Array<() => void>} */
  const disposes = [];
  let activated = false;
  let fallbackTimer = null;

  const disposeAll = () => {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    for (const dispose of disposes.splice(0)) {
      try {
        dispose && dispose();
      } catch {
        /* ignore double-dispose */
      }
    }
  };

  // 幂等激活：先到者生效，后到者直接返回。
  const activate = (sessions, sessionController) => {
    if (activated) return;
    if (!sessions || !sessionController || typeof sessions.list !== 'function') return;
    let registry;
    let negotiations = null;
    try {
      registry = new ClaimRegistry({ dataDir: (config && config.dataDir) || defaultDataDir(), logger });
      // 关键：启动时把落盘 claim 读回内存，否则重启后 all-or-nothing 会跨重启失效
      // （内存空表 → 别的会话可重复占用同一路径）。load() 内部已吞读文件错误，这里只兜意外。
      registry.load(Date.now()).catch((error) => {
        logger?.warn?.(`[session-messenger] claims load failed: ${(error && error.message) || error}`);
      });
    } catch (error) {
      logger?.warn?.(`[session-messenger] registry init failed: ${error.message || error}`);
      return;
    }

    // v3 协商状态（与 claim 同 dataDir，独立文件；失败只降级 v3，不影响 v1/v2）
    if (negotiationEnabled()) {
      try {
        negotiations = new NegotiationStore({
          dataDir: (config && config.dataDir) || defaultDataDir(),
          logger,
          deadlineMs: Number(process.env.DSH_SESSION_MESSENGER_NEG_DEADLINE_MS) || NEG_DEADLINE_MS,
          maxRounds: Number(process.env.DSH_SESSION_MESSENGER_NEG_MAX_ROUNDS) || NEG_MAX_ROUNDS,
          rateMs: Number(process.env.DSH_SESSION_MESSENGER_NEG_RATE_MS) || NEG_RATE_MS
        });
        negotiations.load(Date.now()).catch((error) => {
          logger?.warn?.(`[session-messenger] negotiations load failed: ${(error && error.message) || error}`);
        });
      } catch (error) {
        logger?.warn?.(`[session-messenger] negotiation store init failed (v3 off): ${(error && error.message) || error}`);
        negotiations = null;
      }
    }
    activated = true;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }

    const register = (definition) => {
      try {
        disposes.push(ctx.tools.register(definition));
      } catch (error) {
        logger?.warn?.(`[session-messenger] register ${definition.name} failed: ${error.message || error}`);
      }
    };

    /** 会话 cwd 兜底查询（用于自动通知的 label）。 */
    const sessionCwdOf = (sessionId) => {
      try {
        const session = typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
        return (session && session.header && session.header.cwd) || '';
      } catch {
        return '';
      }
    };

    /** 火速投递：steer 优先、失败自动降级 queue（自动告警不允许丢消息）。fire-and-forget。 */
    const notifySession = (sessionId, text, preferSteer) => {
      const deliver = async (mode) => {
        await sessionController.prompt(
          { requestId: randomUUID(), sessionId, mode, content: [{ type: 'text', text }] },
          AbortSignal.timeout(NOTIFY_TIMEOUT_MS)
        );
      };
      (async () => {
        if (preferSteer) {
          try {
            await deliver('steer');
            return;
          } catch {
            /* fall through to queue */
          }
        }
        await deliver('queue');
      })().catch((error) => {
        logger?.warn?.(`[session-messenger] auto-notify to ${shortId(sessionId)} failed: ${(error && error.message) || error}`);
      });
    };

    const throttle = createThrottle();
    // 去重：同一 fs 事件可能经 internal/dispatch 与直连订阅各到达一次；普通分支幂等无害，
    // 但「孤儿清理」分支不幂等（第一次清掉持有方，第二次写入方就会抢注成功），故按
    // (kind, session, path) 做 1 秒窗口去重（同会话 1 秒内对同一文件的重复意图本就等价）。
    const recentIntents = new Map();
    const isDuplicateIntent = (key) => {
      const now = Date.now();
      const last = recentIntents.get(key) || 0;
      if (now - last < 1000) return true;
      recentIntents.set(key, now);
      if (recentIntents.size > 256) recentIntents.clear();
      return false;
    };
    const metrics = { autoClaims: 0, conflicts: 0, notifies: 0, denies: 0, unattributed: 0, releases: 0, escalations: 0, orphanCleared: 0, negotiationsOpened: 0 };

    // ------------------------------------------------------------ v3 协商辅助
    /** 活跃会话 id 列表；列表为空或查询失败时返回 null（= 未知，绝不用未知做删除决策）。 */
    const liveSessionIds = () => {
      try {
        const list = sessionCandidates(sessions);
        return list.length > 0 ? list.map((entry) => entry.id) : null;
      } catch {
        return null;
      }
    };

    const renderNegotiation = (neg, forSessionId) => {
      const peerId = forSessionId === neg.a ? neg.b : neg.a;
      const peerLabel = (neg.labels && neg.labels[peerId]) || shortId(peerId);
      const you = forSessionId === neg.holder ? 'holder' : forSessionId === neg.writer ? 'writer' : 'party';
      const selfLabel = (neg.labels && neg.labels[forSessionId]) || shortId(forSessionId);
      const offer = neg.lastOffer;
      const offerLine = offer
        ? `${offer.terms.action}${offer.terms.at ? '@' + new Date(offer.terms.at).toISOString() : ''} by ${(neg.labels && neg.labels[offer.by]) || shortId(offer.by)}`
        : 'none';
      const lines = [
        '[[DSH session-messenger · negotiate]]',
        `neg: ${neg.id}`,
        `path: ${neg.path}`,
        `you: ${you} (${selfLabel})`,
        `peer: ${peerLabel} (session ${peerId})`,
        `state: ${neg.state}${neg.resolution ? ` — ${neg.resolution}` : ''}`,
        `round: ${neg.rounds}/${negotiations ? negotiations.maxRounds : NEG_MAX_ROUNDS}`,
        `deadline: ${new Date(neg.deadline).toISOString()}`,
        `lastOffer: ${offerLine}`
      ];
      const ask = [];
      if (neg.state === 'open') {
        const mine = offer && offer.by === forSessionId;
        if (you === 'holder') {
          if (!offer || mine) {
            ask.push('你是该文件的占用方。请给条件或明确拒绝：');
            ask.push(`  negotiate({action:"offer", corr:"${neg.id}", path:"${neg.path}", terms:{action:"release-now"}})  立即让出`);
            ask.push(`  negotiate({action:"offer", corr:"${neg.id}", path:"${neg.path}", terms:{action:"release-at", at:"<ISO 时间>"}})  约定 ≤60 分钟内让出`);
            ask.push(`  negotiate({action:"decline", corr:"${neg.id}", path:"${neg.path}"})  不让出（对方须退让或人工裁决）`);
          } else {
            ask.push('对方提出条件，你可以：');
            ask.push(`  negotiate({action:"accept", corr:"${neg.id}", path:"${neg.path}"})  接受`);
            ask.push(`  negotiate({action:"counter", corr:"${neg.id}", path:"${neg.path}", terms:{action:"release-now"|"release-at", at}})  还价`);
            ask.push(`  negotiate({action:"decline", corr:"${neg.id}", path:"${neg.path}"})  拒绝`);
          }
        } else if (!offer || mine) {
          ask.push('你是写入方，该文件目前由占用方持有。你可以：');
          ask.push(`  negotiate({action:"offer", corr:"${neg.id}", path:"${neg.path}", terms:{action:"wait-until", at:"<ISO 时间>"}})  承诺等到某刻再改`);
          ask.push(`  negotiate({action:"decline", corr:"${neg.id}", path:"${neg.path}"})  放弃该文件，先做别的`);
        } else {
          ask.push('占用方提出条件，你可以：');
          ask.push(`  negotiate({action:"accept", corr:"${neg.id}", path:"${neg.path}"})  接受`);
          ask.push(`  negotiate({action:"counter", corr:"${neg.id}", path:"${neg.path}", terms:{action:"wait-until", at:"<ISO 时间>"}})  还价`);
          ask.push(`  negotiate({action:"decline", corr:"${neg.id}", path:"${neg.path}"})  拒绝（请改别的文件）`);
        }
      } else if (neg.state === 'escalated') {
        ask.push('协商未收敛。默认结论：占用方保留 claim（保守策略，绝不自动判给写入方）。请人工裁决或改做别的文件。');
      } else if (neg.state === 'accepted') {
        if (neg.pendingReleaseAt) ask.push(`已达成：占用方将在 ${new Date(neg.pendingReleaseAt).toISOString()} 自动释放，届时可直接 claim 写入。`);
        else if (neg.pendingWakeAt) ask.push(`已达成：写入方等待至 ${new Date(neg.pendingWakeAt).toISOString()}，到点会收到重试提醒。`);
        else ask.push('已达成：占用已释放，可继续。');
      } else {
        ask.push(`协商已结束（${neg.resolution || neg.state}）。`);
      }
      return [...lines, '', ...ask].join('\n');
    };

    const notifyNegotiation = (neg, sessionId) => {
      notifySession(sessionId, renderNegotiation(neg, sessionId), sessionId === neg.holder);
    };

    const persistNegotiations = () => {
      if (!negotiations) return;
      negotiations.persistCoalesced().catch((error) => {
        logger?.warn?.(`[session-messenger] negotiations persist failed: ${(error && error.message) || error}`);
      });
    };

    const openNegotiation = (filePath, holderId, holderLabel, writerId, writerLabel, now) => {
      if (!negotiations) return null;
      const res = negotiations.open({
        id: randomUUID().slice(0, 8),
        path: filePath,
        a: holderId,
        b: writerId,
        labels: { [holderId]: holderLabel, [writerId]: writerLabel },
        holder: holderId,
        writer: writerId,
        now
      });
      if (res.created) {
        metrics.negotiationsOpened += 1;
        persistNegotiations();
      }
      return res.neg;
    };

    const releaseClaimFor = (sessionId, filePath) => {
      try {
        const count = registry.release(sessionId, [filePath]);
        if (count > 0) {
          metrics.releases += 1;
          registry.persistCoalesced().catch((error) => {
            logger?.warn?.(`[session-messenger] release persist failed: ${(error && error.message) || error}`);
          });
        }
        return count > 0;
      } catch (error) {
        logger?.warn?.(`[session-messenger] release failed: ${(error && error.message) || error}`);
        return false;
      }
    };

    /** 看门狗：超时升级 / 到点自动释放 / 路径已空则收敛协商 / 定期剪枝。单次调用可重入。 */
    const runWatchdogOnce = () => {
      if (!negotiations) return;
      const now = Date.now();
      try {
        const { escalate, dueReleases, dueWakes } = negotiations.scan(now);
        for (const neg of escalate) {
          metrics.escalations += 1;
          logger?.warn?.(`[session-messenger] negotiation ${neg.id} escalated (${neg.resolution}) on ${neg.path}`);
          notifyNegotiation(neg, neg.holder);
          notifyNegotiation(neg, neg.writer);
        }
        for (const neg of dueReleases) {
          releaseClaimFor(neg.holder, neg.path);
          logger?.warn?.(`[session-messenger] negotiation ${neg.id} applied scheduled release for ${neg.path}`);
          notifyNegotiation(neg, neg.holder);
          notifyNegotiation(neg, neg.writer);
        }
        for (const neg of dueWakes) {
          notifyNegotiation(neg, neg.writer);
        }
        const livePaths = new Set(registry.listLive(now).map((claim) => claim.path));
        for (const neg of negotiations.negotiations.values()) {
          if (neg.state !== 'open') continue;
          if (!livePaths.has(neg.path)) {
            negotiations.mark(neg, 'resolved', 'claim no longer held; path is free', now);
            notifyNegotiation(neg, neg.holder);
            notifyNegotiation(neg, neg.writer);
          }
        }
        const removed = negotiations.prune(now, NEG_RETENTION_MS);
        if (escalate.length || dueReleases.length || dueWakes.length || removed) persistNegotiations();
      } catch (error) {
        logger?.warn?.(`[session-messenger] watchdog failed: ${(error && error.message) || error}`);
      }
    };

    if (negotiations) {
      // 定时器不跨重启：先补跑一次（超期→升级、到点→释放），再挂周期看门狗。
      const warmup = setTimeout(() => runWatchdogOnce(), 2000);
      if (typeof warmup.unref === 'function') warmup.unref();
      const watchdog = setInterval(() => runWatchdogOnce(), WATCHDOG_INTERVAL_MS);
      if (typeof watchdog.unref === 'function') watchdog.unref();
      disposes.push(() => {
        clearTimeout(warmup);
        clearInterval(watchdog);
      });
    }

    // ------------------------------------------------------- L0/L1 写入意图观测
    const autoEnvelope = (type, lines) =>
      [
        '[[DSH session-messenger · auto]]',
        `corr: ${randomUUID().slice(0, 8)}`,
        `type: ${type}`,
        ...lines
      ].join('\n');

    const handleWriteIntent = (kind, target, actor) => {
      const info = intentInfo(target, actor);
      if (!info || !info.sessionId) {
        metrics.unattributed += 1;
        return;
      }
      const writerId = info.sessionId;
      const writerCwd = info.cwd || sessionCwdOf(writerId);
      const filePath = info.absPath;
      const writerLabel = labelFor(writerId, writerCwd);
      if (isDuplicateIntent(`${kind}|${writerId}|${filePath}`)) return;
      const result = registry.claim({
        sessionId: writerId,
        label: writerLabel,
        cwd: writerCwd,
        paths: [filePath],
        ttlSeconds: AUTO_CLAIM_TTL_SECONDS,
        note: `auto:${kind}`,
        now: Date.now()
      });
      if (result.registered) {
        metrics.autoClaims += 1;
        registry.persistCoalesced().catch((error) => {
          logger?.warn?.(`[session-messenger] auto-claim persist failed: ${(error && error.message) || error}`);
        });
        return;
      }
      if (!autoNotifyEnabled() || result.conflicts.length === 0) return;
      metrics.conflicts += 1;
      const conflict = result.conflicts[0];
      logger?.warn?.(
        `[session-messenger] CONFLICT(auto): ${writerLabel} writing ${filePath} claimed by ${conflict.ownerLabel} (session ${conflict.ownerSessionId})`
      );
      // 兜底一：孤儿 claim —— 持有方会话已不在活跃列表（子代理已销毁/会话已关闭）时立即清账，
      // 不让写入方白等 TTL。仅在活跃列表非空（= 信息可信）时才据此删除。
      const liveIds = liveSessionIds();
      if (liveIds && !liveIds.includes(conflict.ownerSessionId)) {
        if (releaseClaimFor(conflict.ownerSessionId, filePath)) {
          metrics.orphanCleared += 1;
          logger?.warn?.(
            `[session-messenger] orphan claim cleared: ${conflict.ownerLabel} (session ${conflict.ownerSessionId}) is not live; ${filePath} is free`
          );
          notifySession(
            writerId,
            autoEnvelope('claim-cleared', [
              `path: ${filePath}`,
              `cleared: ${conflict.ownerLabel} (session ${conflict.ownerSessionId}) — that session is no longer live`,
              '',
              '该文件的占用方会话已不在活跃列表，占用已自动清除；你可以直接 claim_files 后写入。'
            ]),
            false
          );
          metrics.notifies += 1;
          return;
        }
      }

      // v3：开多轮协商桌并发结构化协商消息（offer/counter/accept/decline）。
      // 协商不可用（被关闭或初始化失败）时降级为 v2.1 的纯自由文本告警。
      if (negotiations) {
        const neg = openNegotiation(filePath, conflict.ownerSessionId, conflict.ownerLabel, writerId, writerLabel, Date.now());
        if (neg) {
          let notified = false;
          if (throttle(`h:${conflict.ownerSessionId}:${writerId}:${filePath}`, HOLDER_NOTIFY_COOLDOWN_MS)) {
            notifyNegotiation(neg, conflict.ownerSessionId);
            metrics.notifies += 1;
            notified = true;
          }
          if (throttle(`w:${writerId}:${filePath}`, WRITER_NOTIFY_COOLDOWN_MS)) {
            notifyNegotiation(neg, writerId);
            metrics.notifies += 1;
            notified = true;
          }
          if (notified) return;
        }
      }
      // 降级路径（无 v3）：通知持有方（steer 优先，10 分钟冷却）与写入方（queue，60 秒冷却）。
      if (throttle(`h:${conflict.ownerSessionId}:${writerId}:${filePath}`, HOLDER_NOTIFY_COOLDOWN_MS)) {
        notifySession(
          conflict.ownerSessionId,
          autoEnvelope('conflict-alert', [
            `path: ${filePath}`,
            `holder: ${conflict.ownerLabel} (session ${conflict.ownerSessionId}) — this is you`,
            `writer: ${writerLabel} (session ${writerId})`,
            '',
            `会话 ${writerLabel} 正在写入你占用的文件（claim note: ${conflict.note || 'n/a'}）。如需协调，请用 send_to_session 回复写入方（session ${writerId}），或调整你的计划。`
          ]),
          true
        );
        metrics.notifies += 1;
      }
      if (throttle(`w:${writerId}:${filePath}`, WRITER_NOTIFY_COOLDOWN_MS)) {
        notifySession(
          writerId,
          autoEnvelope('conflict-alert', [
            `path: ${filePath}`,
            `holder: ${conflict.ownerLabel} (session ${conflict.ownerSessionId})`,
            `writer: ${writerLabel} — this is you`,
            '',
            `你正在写入的文件已被会话 ${conflict.ownerLabel} claim（note: ${conflict.note || 'n/a'}，未过期）。建议先 send_to_session 与对方协商，或调整改动范围；硬闸门未开启，本次写入未被阻止。`
          ]),
          false
        );
        metrics.notifies += 1;
      }
    };

    const intentHandler = (kind) => async (target, actor, next) => {
      try {
        handleWriteIntent(kind, target, actor);
      } catch (error) {
        logger?.warn?.(`[session-messenger] ${kind} intent handling failed: ${(error && error.message) || error}`);
      }
      // 永不拥有决策权：恒等透传（practices.md 瀑布纪律）。
      return next();
    };

    // 订阅策略（2026-09-30 实测修正，L0 首测失败的根因）：
    // 宿主是在**工具执行时的 agent 作用域 ctx** 上分发瀑布的
    // （dsh-tool-fs/lib/index.js:583 `await ctx.waterfall("fs/write-intent", target, exec, () => void 0)`），
    // 根级插件上的 ctx.on('fs/write-intent') 听不到该作用域的分发。
    // 正解是宿主的进程级旁听通道：ctx.on('internal/dispatch', cb, { global: true })
    // —— 宿主自带的 fs 守卫插件就是这么观察这三个 fs 事件的（dsh-fs/lib/invariant.js:15）。
    // 直连订阅保留为兜底（若有路径在根作用域分发）；两者同时命中无害：
    // claim 是幂等 upsert，通知有冷却节流。
    const dispatchListener = (_mode, eventName, args) => {
      // 高频通道（每个事件都过这里）：非 fs 事件只做两次字符串比较立即返回，绝不抛出。
      if (eventName !== 'fs/write-intent' && eventName !== 'fs/edit-intent') return;
      try {
        const kind = eventName === 'fs/edit-intent' ? 'edit' : 'write';
        handleWriteIntent(kind, args && args[0], args && args[1]);
      } catch (error) {
        logger?.warn?.(`[session-messenger] ${eventName} dispatch handling failed: ${(error && error.message) || error}`);
      }
    };
    try {
      disposes.push(ctx.on('internal/dispatch', dispatchListener, { global: true }));
    } catch (error) {
      logger?.warn?.(`[session-messenger] internal/dispatch subscribe failed (L0/L1 off): ${(error && error.message) || error}`);
    }
    try {
      disposes.push(ctx.on('fs/write-intent', intentHandler('write')));
      disposes.push(ctx.on('fs/edit-intent', intentHandler('edit')));
    } catch (error) {
      logger?.warn?.(`[session-messenger] fs intent direct subscribe failed (fallback off): ${(error && error.message) || error}`);
    }

    // ------------------------------------------------------------- L2 硬闸门（默认关）
    const hardGateDenyReason = (exec) => {
      // 只拦宿主文件工具 write / edit；bash 等其他工具不在硬闸门范围（子进程直写绕过 fs 服务）。
      if (!exec || (exec.name !== 'write' && exec.name !== 'edit')) return '';
      const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
      const rawPath = args.file_path || args.path || args.filePath;
      if (typeof rawPath !== 'string' || !rawPath.trim()) return '';
      if (!path.isAbsolute(rawPath)) return '';
      const abs = path.normalize(rawPath);
      const callerId = (exec.agent && exec.agent.id) || '';
      const hit = registry
        .listLive(Date.now())
        .find((claim) => claim.path === abs && claim.sessionId !== callerId);
      if (!hit) return '';
      return `CONFLICT: "${abs}" is currently claimed by ${hit.label || hit.sessionId} (session ${hit.sessionId}, expires ${new Date(hit.expiresAt).toISOString()}). This write was DENIED by dsh-session-messenger hard gate. Negotiate via send_to_session to that session, or work on other files.`;
    };

    if (hardGateEnabled(config)) {
      logger?.warn?.(
        '[session-messenger] HARD GATE ENABLED — writes hitting another session\'s live claim will be DENIED (switch: env DSH_SESSION_MESSENGER_HARD_GATE=0 or config.hardGate=false)'
      );
      disposes.push(
        ctx.on('tools/pre-execute', async (exec, next) => {
          try {
            const reason = hardGateDenyReason(exec);
            if (reason) {
              metrics.denies += 1;
              logger?.warn?.(`[session-messenger] hard-gate DENIED ${exec && exec.name}: ${reason.slice(0, 160)}`);
              // PreToolDecision 宿主形状未实测；deny 语义按文档（Allow, deny, cancel, or ask）给最常见形状。
              return { action: 'deny', reason };
            }
          } catch (error) {
            logger?.warn?.(`[session-messenger] hard-gate check failed (allowing): ${(error && error.message) || error}`);
          }
          return next();
        })
      );
    }

    // --------------------------------------------------------- v1.5 常驻协作提醒
    try {
      const systemPrompt = safeGet(ctx, 'systemPrompt');
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        disposes.push(
          systemPrompt.section({
            name: 'session-messenger:protocol',
            text:
              'Cross-session collaboration: before modifying files in this workspace, call claim_files to register intent (the claim registry is shared with other live DSH sessions and also auto-updated on writes). If claim_files reports a CONFLICT, do not edit those files: read the [[DSH session-messenger · negotiate]] message and reply with the negotiate tool (offer / counter / accept / decline) to settle it with the holder, or work on other files meanwhile. Call release_files when done with a batch of files.'
          })
        );
      }
    } catch (error) {
      logger?.warn?.(`[session-messenger] systemPrompt section failed (v1.5 off): ${(error && error.message) || error}`);
    }

    // ------------------------------------------------------------------ claim_files
    register({
      name: 'claim_files',
      description:
        'Register a claim on files you are about to modify so other live DSH sessions can detect the conflict before editing. All-or-nothing: when another session already holds a live claim on ANY requested path, nothing is registered and the conflicts are returned (negotiate via send_to_session or pick other files). Claims auto-expire after ttl_seconds (default 1800). Note: the host also auto-registers short-lived claims on actual file writes, so the registry tracks activity even without manual claims — manual claiming declares intent EARLY (before editing). Run release_files when done.',
      parameters: CLAIM_FILES_PARAMETERS,
      output: {
        schema: CLAIM_FILES_OUTPUT,
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `claim_files failed: ${value.hint}` }];
          if (!value.registered) {
            const owners = [...new Set(value.conflicts.map((c) => c.ownerLabel))].join(', ');
            return [
              {
                type: 'text',
                text: `CONFLICT: ${value.conflicts.length} path(s) already claimed by ${owners}. Nothing registered.`
              }
            ];
          }
          return [{ type: 'text', text: `Claim registered until ${new Date(value.expiresAt).toISOString()}.` }];
        }
      },
      execute: async (args, exec) => {
        const now = Date.now();
        try {
          const caller = callerInfo(exec, args && args.cwd);
          const rawPaths = Array.isArray(args && args.paths) ? args.paths : [];
          if (rawPaths.length === 0) {
            return { ok: false, sessionId: caller.sessionId, registered: false, expiresAt: 0, conflicts: [], hint: 'paths must be a non-empty array' };
          }
          if (rawPaths.length > MAX_PATHS) {
            return { ok: false, sessionId: caller.sessionId, registered: false, expiresAt: 0, conflicts: [], hint: `too many paths (${rawPaths.length}); split into chunks of at most ${MAX_PATHS}` };
          }
          const { paths, unresolvable } = normalizePaths(rawPaths, caller.cwd);
          if (paths.length === 0) {
            return { ok: false, sessionId: caller.sessionId, registered: false, expiresAt: 0, conflicts: [], hint: `no resolvable paths (cwd unknown for: ${unresolvable.join(', ')}); pass absolute paths or cwd` };
          }
          const ttlSeconds = clampTtl(args && args.ttl_seconds);
          const note = String((args && args.note) || '').slice(0, 300);
          const result = await registry.serialized(async () => {
            const claimed = registry.claim({
              sessionId: caller.sessionId,
              label: labelFor(caller.sessionId, caller.cwd),
              cwd: caller.cwd,
              paths,
              ttlSeconds,
              note,
              now
            });
            if (claimed.registered) {
              try {
                await registry.persist();
              } catch (error) {
                logger?.warn?.(`[session-messenger] claims persist failed: ${error.message || error}`);
              }
            }
            return claimed;
          });
          if (!result.registered) {
            return {
              ok: true,
              sessionId: caller.sessionId,
              registered: false,
              expiresAt: 0,
              conflicts: result.conflicts,
              hint: 'Nothing was registered. Negotiate with the owner via send_to_session, or work on other files.'
            };
          }
          return {
            ok: true,
            sessionId: caller.sessionId,
            registered: true,
            expiresAt: result.expiresAt,
            conflicts: [],
            hint: `Registered ${paths.length} path(s) until ${new Date(result.expiresAt).toISOString()}. Run release_files when done.`
          };
        } catch (error) {
          return { ok: false, sessionId: '', registered: false, expiresAt: 0, conflicts: [], hint: String((error && error.message) || error) };
        }
      }
    });

    // ---------------------------------------------------------------- release_files
    register({
      name: 'release_files',
      description:
        "Release file claims previously registered by THIS session via claim_files. Omit paths to release all of this session's claims.",
      parameters: RELEASE_FILES_PARAMETERS,
      output: {
        schema: RELEASE_FILES_OUTPUT,
        render: (_args, value) => [
          { type: 'text', text: value.ok ? `Released ${value.released} claim(s).` : `release_files failed: ${value.hint}` }
        ]
      },
      execute: async (args, exec) => {
        try {
          const caller = callerInfo(exec, args && args.cwd);
          const rawPaths = Array.isArray(args && args.paths) ? args.paths : [];
          const { paths } = normalizePaths(rawPaths, caller.cwd);
          const released = await registry.serialized(async () => {
            const count = registry.release(caller.sessionId, rawPaths.length > 0 ? paths : null);
            if (count > 0) {
              try {
                await registry.persist();
              } catch (error) {
                logger?.warn?.(`[session-messenger] claims persist failed: ${error.message || error}`);
              }
            }
            return count;
          });
          return { ok: true, sessionId: caller.sessionId, released, hint: released > 0 ? 'done' : 'no matching claims' };
        } catch (error) {
          return { ok: false, sessionId: '', released: 0, hint: String((error && error.message) || error) };
        }
      }
    });

    // -------------------------------------------------------------- send_to_session
    register({
      name: 'send_to_session',
      description:
        "Send a message to ANOTHER live DSH session in this host. The message enters the target's conversation through the official session prompt channel and is visible in its chat UI. mode 'queue' (default) delivers as a queued user message: the target starts a turn when idle, or the message waits for its next turn when running. mode 'steer' inserts into the target's CURRENT running step and fails when the target is idle (retry with queue). Use it to negotiate claim_files conflicts; the target replies with its own send_to_session call.",
      parameters: SEND_TO_SESSION_PARAMETERS,
      output: {
        schema: SEND_TO_SESSION_OUTPUT,
        render: (_args, value) => [
          {
            type: 'text',
            text: value.ok
              ? `Message ${value.mode === 'steer' ? 'steered into' : 'queued into'} session ${value.target}.`
              : `send_to_session failed: ${value.detail}`
          }
        ]
      },
      execute: async (args, exec) => {
        const mode = args && args.mode === 'steer' ? 'steer' : 'queue';
        const rawTarget = String((args && args.target) || '').trim();
        const respond = (ok, target, delivered, detail) => ({ ok, target, mode, delivered, detail });
        try {
          const caller = callerInfo(exec);
          const content = String((args && args.content) || '').trim();
          if (!rawTarget) return respond(false, '', false, 'target is required');
          if (!content) return respond(false, rawTarget, false, 'content is required');
          if (content.length > MAX_CONTENT_CHARS) {
            return respond(false, rawTarget, false, `content too long (${content.length} > ${MAX_CONTENT_CHARS} chars)`);
          }

          const live = sessionCandidates(sessions);
          const exact = live.find((entry) => entry.id === rawTarget);
          let resolved = exact ? exact.id : '';
          if (!resolved && rawTarget.length >= 4) {
            const prefixMatches = live.filter((entry) => entry.id.startsWith(rawTarget));
            if (prefixMatches.length === 1) resolved = prefixMatches[0].id;
            if (prefixMatches.length > 1) {
              return respond(false, rawTarget, false, `ambiguous id prefix; candidates: ${JSON.stringify(candidateRows(prefixMatches))}`);
            }
          }
          if (!resolved) {
            const rows = candidateRows(live);
            return respond(false, rawTarget, false, `no live session matches "${rawTarget}". Live sessions: ${JSON.stringify(rows)}`);
          }
          if (resolved === caller.sessionId) {
            return respond(false, resolved, false, 'target resolves to the calling session; self-send is a no-op');
          }

          const corr = randomUUID().slice(0, 8);
          const header = [
            '[[DSH session-messenger]]',
            `from: ${labelFor(caller.sessionId, caller.cwd)} (session ${caller.sessionId})`,
            `corr: ${corr}`,
            args && args.topic ? `topic: ${String(args.topic).slice(0, 120)}` : '',
            `mode: ${mode}`
          ]
            .filter(Boolean)
            .join('\n');
          const text = `${header}\n\n${content}`;
          const signal = (exec && exec.signal) || AbortSignal.timeout(20000);
          await sessionController.prompt(
            {
              requestId: randomUUID(),
              sessionId: resolved,
              mode,
              content: [{ type: 'text', text }]
            },
            signal
          );
          return respond(true, resolved, true, `accepted as corr=${corr} (${mode}); the target replies via its own send_to_session`);
        } catch (error) {
          const base = String((error && error.message) || error);
          const hint = mode === 'steer' ? ' — the target may be idle; retry with mode=queue' : '';
          return respond(false, rawTarget, false, base + hint);
        }
      }
    });

    // ---------------------------------------------------------------- negotiate (v3)
    register({
      name: 'negotiate',
      description:
        "Negotiate a file-claim conflict with another session through multi-round structured offers. When you receive a [[DSH session-messenger · negotiate]] message, reply with exactly one action: 'offer'/'counter' propose terms (only the current claim HOLDER may offer release-now / release-at; the writer may offer wait-until), 'accept' accepts the peer's pending offer and the plugin executes it (e.g. releasing the holder's claim immediately or at the agreed time), 'decline' refuses to negotiate, 'escalate' asks for human arbitration, 'status' lists your open negotiations for a path. Silence is NOT consent: if nobody responds before the deadline the plugin escalates to the user and the holder keeps the claim.",
      parameters: NEGOTIATE_PARAMETERS,
      output: {
        schema: NEGOTIATE_OUTPUT,
        // 模型只看得到 render 文本（detail 字段不会直接进上下文）——真机验收抓到的可见性缺陷：
        // 原先只渲染 "state=open round=0"，导致收不到协商消息的会话拿不到 neg id / lastOffer。
        // 现在把 detail（含 neg id、条款、释放时间、拒绝原因）完整带出。
        render: (_args, value) => [
          {
            type: 'text',
            text: value.ok
              ? `negotiate ok${value.negId ? ` [neg ${value.negId}]` : ''}: ${value.detail}`
              : `negotiate rejected${value.negId ? ` [neg ${value.negId}]` : ''}: ${value.detail}`
          }
        ]
      },
      execute: async (args, exec) => {
        const now = Date.now();
        const respond = (ok, neg, released, detail) => ({
          ok,
          negId: neg ? neg.id : '',
          path: neg ? neg.path : String((args && args.path) || ''),
          state: neg ? neg.state : '',
          rounds: neg ? neg.rounds : 0,
          deadline: neg ? neg.deadline : 0,
          released: !!released,
          detail
        });
        if (!negotiations) {
          return respond(false, null, false, 'negotiation layer is disabled (env DSH_SESSION_MESSENGER_NEGOTIATE=0)');
        }
        try {
          const caller = callerInfo(exec);
          const action = String((args && args.action) || '').trim();
          const rawPath = String((args && args.path) || '').trim();
          const { paths } = normalizePaths([rawPath], caller.cwd);
          const filePath = paths[0] || '';
          if (!filePath) return respond(false, null, false, 'path could not be resolved to an absolute path');

          if (action === 'status') {
            const open = negotiations.openForSession(caller.sessionId).filter((neg) => neg.path === filePath);
            let detail;
            if (open.length === 0) {
              const live = registry.listLive(now).find((claim) => claim.path === filePath && claim.sessionId !== caller.sessionId);
              detail = live
                ? `no open negotiation on this path involving you, but ${live.label || shortId(live.sessionId)} (session ${live.sessionId}) holds a live claim until ${new Date(live.expiresAt).toISOString()} — open one as the writer with negotiate({action:"offer", path:"${filePath}", terms:{action:"wait-until", at:"<ISO within 60m>"}})`
                : 'no open negotiation on this path involving you (and no other live claim)';
            } else {
              detail = open
                .map((neg) => {
                  const peerId = neg.a === caller.sessionId ? neg.b : neg.a;
                  const lo = neg.lastOffer
                    ? `${neg.lastOffer.terms.action}${neg.lastOffer.terms.at ? '@' + new Date(neg.lastOffer.terms.at).toISOString() : ''} by ${shortId(neg.lastOffer.by)}`
                    : 'none';
                  const pend = neg.pendingReleaseAt
                    ? ` releases-at=${new Date(neg.pendingReleaseAt).toISOString()}`
                    : neg.pendingWakeAt
                      ? ` wake-at=${new Date(neg.pendingWakeAt).toISOString()}`
                      : '';
                  return `${neg.id} state=${neg.state} round=${neg.rounds}/${negotiations.maxRounds} you=${caller.sessionId === neg.holder ? 'holder' : 'writer'} peer=${shortId(peerId)} deadline=${new Date(neg.deadline).toISOString()} lastOffer=${lo}${pend}`;
                })
                .join(' | ');
            }
            return respond(true, open[0] || null, false, detail);
          }

          let neg = args && args.corr ? negotiations.byId(String(args.corr)) : undefined;
          if (!neg) {
            const candidates = negotiations.openForSession(caller.sessionId).filter((n) => n.path === filePath);
            if (candidates.length === 1) neg = candidates[0];
            else if (candidates.length > 1) {
              return respond(false, null, false, `multiple open negotiations for this path; pass corr (${candidates.map((n) => n.id).join(', ')})`);
            }
          }
          if (!neg && (action === 'offer' || action === 'counter')) {
            const live = registry.listLive(now).find((claim) => claim.path === filePath && claim.sessionId !== caller.sessionId);
            if (!live) {
              return respond(false, null, false, `no live claim by another session on ${filePath}; nothing to negotiate (use claim_files to declare your own intent)`);
            }
            neg = openNegotiation(filePath, live.sessionId, live.label || live.sessionId, caller.sessionId, labelFor(caller.sessionId, caller.cwd), now);
            if (!neg) return respond(false, null, false, 'could not open a negotiation');
          }
          if (!neg) {
            return respond(false, null, false, `no open negotiation found for ${filePath}; wait for a conflict alert or pass a valid corr`);
          }
          if (neg.a !== caller.sessionId && neg.b !== caller.sessionId) {
            return respond(false, neg, false, 'you are not a party of this negotiation');
          }
          const rateKey = `${neg.path}\u0000${[neg.a, neg.b].sort().join('\u0000')}`;
          if (negotiations.rateLimited(rateKey, now)) {
            return respond(false, neg, false, `rate limited: at most one intent per ${negotiations.rateMs}ms per file/pair; wait and retry`);
          }

          const result = negotiations.transition(neg, {
            by: caller.sessionId,
            action,
            terms: args && args.terms,
            message: args && args.message,
            now
          });
          if (!result.ok) {
            // 被拒绝的意图退还限速额度：否则紧随其后的合法意图会被误伤（探针实测）。
            negotiations.refundRate(rateKey);
            persistNegotiations();
            return respond(false, neg, false, result.reason || 'transition rejected');
          }
          const effects = result.effects || {};
          let released = false;
          if (effects.releaseSessionId && effects.releaseAt && effects.releaseAt <= now) {
            released = releaseClaimFor(effects.releaseSessionId, neg.path);
          }
          persistNegotiations();
          const peerId = caller.sessionId === neg.a ? neg.b : neg.a;
          if (peerId) {
            notifyNegotiation(neg, peerId);
            metrics.notifies += 1;
          }
          const termsLine =
            neg.lastOffer && (action === 'offer' || action === 'counter')
              ? ` terms=${neg.lastOffer.terms.action}${neg.lastOffer.terms.at ? '@' + new Date(neg.lastOffer.terms.at).toISOString() : ''}`
              : '';
          const scheduled = neg.pendingReleaseAt
            ? ` scheduled release at ${new Date(neg.pendingReleaseAt).toISOString()}`
            : neg.pendingWakeAt
              ? ` writer wake at ${new Date(neg.pendingWakeAt).toISOString()}`
              : '';
          return respond(true, neg, released, `state=${neg.state} rounds=${neg.rounds}${termsLine}${released ? ' holder claim released now' : ''}${scheduled}`);
        } catch (error) {
          return respond(false, null, false, String((error && error.message) || error));
        }
      }
    });

    logger?.info?.(
      `[session-messenger] activated: 4 tools; L0 auto-register=on; L1 auto-notify=${autoNotifyEnabled() ? 'on' : 'off'}; v3 negotiate=${negotiations ? `on (deadline ${negotiations.deadlineMs / 1000}s, max ${negotiations.maxRounds} rounds)` : 'off'}; L2 hard-gate=${hardGateEnabled(config) ? 'ON (writes on claimed files will be denied)' : 'off'}`
    );
  };

  // 主路径：可选注入（服务缺失时静默 pend，不拖垮 profile）。
  // cordis 契约（@deepseek-ai/cordis src/registry.ts:300）：
  //   ctx.inject(deps, cb) === ctx.plugin({ inject: deps, apply: cb })
  // 回调是插件体，按 (ctx, config) 调用（src/fiber.ts:259 `runtime.callback(this.ctx, this.config)`），
  // 依赖以「作用域 ctx 上的属性」出现，不是位置参数数组。
  // 2026-09-29 修复：早前写成 `(...args) => [sessions, sessionController] = args`，
  // 实际拿到的是 (scopeCtx, config)，于是 sessions 成了 scope ctx 本体，
  // activate() 被 `typeof sessions.list !== 'function'` 静默拒掉 —— 插件从未激活。
  ctx.inject(['sessions', 'sessionController'], (scope) => {
    if (activated) return;
    const sessions = scope && scope.sessions;
    const sessionController = scope && scope.sessionController;
    if (!sessions || !sessionController) {
      logger?.warn?.('[session-messenger] sessions/sessionController not resolvable via inject');
      return;
    }
    activate(sessions, sessionController);
  });

  // 兜底诊断：3 秒后若仍未激活，用非严格 ctx.get(name, false) 探测一次。
  // 绝不再用 ctx.sessions / ctx.sessionController 直取：未在本 ctx 的 inject 里声明该服务时
  // cordis 会抛 `cannot get property "sessions" without inject`，而它是在 setTimeout 里抛的，
  // 会被宿主当成 fatal uncaught exception 直接 exit 1 → 进恢复模式（本次事故元凶）。
  // 兜底只做诊断与最后一次机会，失败即保持惰性。
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    if (activated) return;
    try {
      const probe = typeof ctx.get === 'function' ? (service) => ctx.get(service, false) : () => undefined;
      const sessions = probe('sessions');
      const sessionController = probe('sessionController');
      if (sessions && sessionController) activate(sessions, sessionController);
    } catch (error) {
      logger?.warn?.(`[session-messenger] service probe failed: ${(error && error.message) || error}`);
    }
    if (!activated) {
      logger?.warn?.('[session-messenger] services not resolvable via inject or ctx.get; tools not registered');
    }
  }, SERVICE_FALLBACK_MS);
  if (fallbackTimer && typeof fallbackTimer.unref === 'function') fallbackTimer.unref();

  return disposeAll;
}
