/**
 * 纯工具函数：身份/标签、路径归一化与身份键、调用方解析、节流、信封转义。
 * 本文件零副作用、零宿主依赖，便于单测直接覆盖。
 */
import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';

export const ENVELOPE_TAG = '[[DSH session-messenger';

/** 会话 id 形如 "session-<uuid>"（持久会话）或裸 "<uuid>"（子代理会话）；剥前缀再截。 */
export function shortId(id) {
  return String(id || '')
    .replace(/^session-/, '')
    .slice(0, 8);
}

export function labelFor(id, cwd) {
  const base = cwd ? path.basename(String(cwd)) : '';
  return base ? `${shortId(id)} @ ${base}` : shortId(id);
}

/** 旧版 label 的已知坏形状（"session- @ x"）需要按当前规则重算。 */
export function isLegacyLabel(label) {
  return typeof label !== 'string' || !label || /^session-(\s|$)/.test(label);
}

/**
 * 路径身份键：与宿主 dsh-fs-local 的 targetKey 同算法——存在则 realpath，
 * 不存在则「最近存在祖先的 realpath + 缺失后缀」。用于跨符号链接（如 /tmp → /private/tmp）
 * 识别同一文件。任何异常都回退为规范化的绝对路径，绝不抛出。
 */
export function pathKey(absPath) {
  const normalized = path.normalize(String(absPath || ''));
  if (!path.isAbsolute(normalized)) return normalized;
  try {
    return realpathSync.native(normalized);
  } catch {
    /* fall through to ancestor walk */
  }
  const missing = [path.basename(normalized)];
  let ancestor = path.dirname(normalized);
  for (let guard = 0; guard < 256; guard += 1) {
    try {
      return path.join(realpathSync.native(ancestor), ...missing);
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return normalized;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  return normalized;
}

/** 把用户给的路径（绝对 / ~/ / 相对 cwd）解析为绝对路径；无法解析返回 ''。 */
export function toAbsolute(raw, cwd) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value === '~' || value.startsWith('~/')) return path.normalize(path.join(os.homedir(), value.slice(1)));
  if (path.isAbsolute(value)) return path.normalize(value);
  if (cwd && path.isAbsolute(String(cwd))) return path.resolve(String(cwd), value);
  return '';
}

/** 批量归一化并去重（按身份键去重）。 */
export function normalizePaths(rawPaths, cwd) {
  const out = [];
  const seen = new Set();
  const unresolvable = [];
  for (const raw of rawPaths || []) {
    const abs = toAbsolute(raw, cwd);
    if (!abs) {
      if (String(raw || '').trim()) unresolvable.push(String(raw));
      continue;
    }
    const key = pathKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: abs, key });
  }
  return { entries: out, unresolvable };
}

/** abs 是否位于 root 之内（含 root 本身）。 */
export function isWithin(abs, root) {
  if (!abs || !root) return false;
  const rel = path.relative(String(root), String(abs));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 从会话对象读 header。 */
export function headerOf(session) {
  return (session && session.header) || {};
}

/** 会话来源：'subagent'（宿主子代理路由所有，可被证明已销毁）或 'session'（持久会话）。 */
export function originOfHeader(header, id) {
  if (header && (header.origin === 'subagent' || header.parentSession !== undefined)) return 'subagent';
  if (header && (header.origin !== undefined || header.cwd !== undefined)) return 'session';
  // 无 header 时按 id 形状推断：持久会话带 "session-" 前缀，子代理为裸 uuid（本机实测）。
  return /^session-/.test(String(id || '')) ? 'session' : 'subagent';
}

/** 调用方身份：sessionId 必须可解析，否则明确报错（不静默猜）。 */
export function callerInfo(exec, cwdOverride) {
  const agent = exec && exec.agent;
  const header = headerOf(agent && agent.session);
  const sessionId = (agent && agent.id) || header.id || (exec && exec.sessionId);
  if (!sessionId) throw new Error('caller session id unavailable (tool executed without an agent context)');
  const override = cwdOverride ? String(cwdOverride) : '';
  const cwd =
    (override && path.isAbsolute(override) ? override : '') ||
    header.cwd ||
    (agent && agent.options && agent.options.cwd) ||
    '';
  return {
    sessionId: String(sessionId),
    cwd: cwd ? String(cwd) : '',
    origin: originOfHeader(header, sessionId),
    parent: header.parentSession ? String(header.parentSession) : ''
  };
}

/**
 * 父子会话视为同一协作单元：父会话占用的文件委派给子代理改（或反之、或兄弟子代理之间）
 * 都不算冲突——否则争议冻结会把被委派的子代理挡在自己的任务之外。
 */
export function sameFamily(aId, aParent, bId, bParent) {
  if (!aId || !bId) return false;
  if (aId === bId) return true;
  if (aParent && aParent === bId) return true;
  if (bParent && bParent === aId) return true;
  return !!aParent && aParent === bParent;
}

/**
 * fs 意图事件信息（形状依据宿主源码）：target = FsTarget { targetKey, displayPath }，
 * displayPath 相对 cwd 优先（工作区内 posix 相对 / "~/" / 绝对）；actor = ToolExecution（.agent）。
 */
export function intentInfo(target, actor) {
  if (!target || typeof target !== 'object') return undefined;
  const display = typeof target.displayPath === 'string' ? target.displayPath.trim() : '';
  if (!display) return undefined;
  const agent = actor && typeof actor === 'object' ? actor.agent : undefined;
  const sessionId = agent && typeof agent.id === 'string' ? agent.id : '';
  const header = headerOf(agent && agent.session);
  const cwd = header.cwd || '';
  const abs = toAbsolute(display, cwd);
  if (!abs) return undefined; // 无 cwd 无法定位：宁缺毋滥
  return {
    absPath: abs,
    key: pathKey(abs),
    sessionId,
    cwd,
    origin: originOfHeader(header, sessionId),
    parent: header.parentSession ? String(header.parentSession) : ''
  };
}

/**
 * 时间窗节流：同一 key 在 windowMs 内只放行第一次。
 * 容量超限时淘汰过期项（而非整表清空——整表清空会让去重/冷却在突发时失效）。
 */
export function createThrottle({ max = 1024, now = Date.now } = {}) {
  const map = new Map();
  const evict = (t) => {
    for (const [key, entry] of map) {
      if (t - entry.at >= entry.window) map.delete(key);
    }
    while (map.size >= max) map.delete(map.keys().next().value);
  };
  const allow = (key, windowMs) => {
    const t = now();
    const entry = map.get(key);
    if (entry && t - entry.at < windowMs) return false;
    if (map.size >= max) evict(t);
    map.delete(key);
    map.set(key, { at: t, window: windowMs });
    return true;
  };
  allow.size = () => map.size;
  return allow;
}

/** 滑动窗口计数限速：windowMs 内最多 limit 次。返回 { ok, retryInMs }。 */
export function createWindowLimiter({ max = 1024, now = Date.now } = {}) {
  const map = new Map();
  return (key, limit, windowMs) => {
    const t = now();
    const hits = (map.get(key) || []).filter((at) => t - at < windowMs);
    if (hits.length >= limit) {
      map.set(key, hits);
      return { ok: false, retryInMs: windowMs - (t - hits[0]) };
    }
    hits.push(t);
    map.delete(key);
    map.set(key, hits);
    if (map.size > max) map.delete(map.keys().next().value);
    return { ok: true, retryInMs: 0 };
  };
}

/**
 * 中和正文里的信封标记：对方可能在正文伪造 "[[DSH session-messenger · auto]]"
 * 冒充插件自动告警。任何出现都改写为不可混淆的引用形态。
 */
export function neutralizeEnvelope(text) {
  return String(text || '').replace(/\[\[\s*DSH\s+session-messenger/gi, '[quoted: DSH session-messenger');
}

/** 单行化：topic/label 等头部字段禁止换行（否则可伪造头部行）。 */
export function oneLine(text, maxLen) {
  const flat = neutralizeEnvelope(String(text || '')).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  return maxLen ? flat.slice(0, maxLen) : flat;
}

export function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : 'n/a';
}

export function envNumber(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
