/**
 * NegotiationStore — 冲突协商的状态机与持久化（纯状态 + 决策，零副作用）。
 *
 * 设计原则：
 * 1. 结构化意图：offer/counter/accept/decline/escalate 是一等字段，message 只是附注。
 * 2. 权限边界：只有 claim 持有方能提出 release-*；写入方只能提 wait-until 或 decline。
 * 3. 沉默不等于同意：无响应只走看门狗升级人工，默认保守结果 = 占用方保留 claim。
 * 4. 每次意图刷新活性 deadline；轮次超限或超时 → escalated。
 * 5. 状态落盘（JsonFile 合并写），重启后可恢复；定时器由调用方在激活时补跑。
 *
 * 审查修复：
 * - M2：带 pending 释放/唤醒的终态记录不参与剪枝，直到 pending 执行完毕。
 * - M3：限速键为 (negId, 发送方)，只限制同一方连发，不误伤对方的及时回应。
 * - L3：终态协商对同 (path, pair) 设冷静期，冷静期内不重复开桌、不重复打扰。
 * - H1 支撑：frozenFor() 暴露「争议中」路径，供写入守卫只冻结真正有争议的单个路径。
 *
 * v0.4.2 同一文件多写入方（移交 + 排队）：
 * - 谈成（accept release-now / release-at 到点）不再「释放后谁抢到算谁的」，而是把占用
 *   **直接移交**给谈成的写入方（effects.handoff）。
 * - 占用方已约定移交后，该文件上其余协商进入 `queued`（非终态、冻结写入、不走超时升级），
 *   新来的写入方也直接排进 `queued`；移交完成后按先来后到**改绑**到新占用方重新 `open`。
 * - 占用方主动释放 / 过期 / 被销毁时，由调用方按队列把占用交给下一位（queueFor）。
 */
import path from 'node:path';
import { JsonFile } from './storage.js';
import { pathKey } from './util.js';

export const TERMINAL_STATES = new Set(['accepted', 'declined', 'escalated', 'resolved']);
/** 非终态：open（可协商）与 queued（排在已约定的移交之后）。 */
export const ACTIVE_STATES = new Set(['open', 'queued']);
const RELEASE_ACTIONS = new Set(['release-now', 'release-at']);
const MAX_AHEAD_MS = 60 * 60 * 1000;

function pairKey(key, a, b) {
  const [x, y] = [String(a), String(b)].sort();
  return `${key}\u0000${x}\u0000${y}`;
}

export function normalizeTerms(terms) {
  if (!terms || typeof terms !== 'object') return undefined;
  const action = String(terms.action || '').trim();
  if (!['release-now', 'release-at', 'wait-until'].includes(action)) return undefined;
  if (action === 'release-now') return { action };
  const at = Date.parse(String(terms.at || ''));
  if (!Number.isFinite(at)) return undefined;
  return { action, at };
}

export class NegotiationStore {
  constructor({ dataDir, logger, deadlineMs, maxRounds, rateMs, cooldownMs = 10 * 60 * 1000, maxHistory = 12 }) {
    this.file = new JsonFile(path.join(dataDir, 'negotiations.json'));
    this.logger = logger;
    this.deadlineMs = deadlineMs;
    this.maxRounds = maxRounds;
    this.rateMs = rateMs;
    this.cooldownMs = cooldownMs;
    this.maxHistory = maxHistory;
    /** @type {Map<string, object>} */
    this.negotiations = new Map();
    this.ready = false;
    /** @type {Map<string, number>} `${negId}\0${by}` -> lastIntentAt */
    this.rate = new Map();
  }

  async load(now) {
    if (this.ready) return;
    try {
      const parsed = await this.file.read();
      const list = parsed && Array.isArray(parsed.negotiations) ? parsed.negotiations : [];
      for (const neg of list) {
        if (!neg || typeof neg.id !== 'string' || typeof neg.path !== 'string' || !neg.a || !neg.b) continue;
        const state = TERMINAL_STATES.has(neg.state) || ACTIVE_STATES.has(neg.state) ? neg.state : 'open';
        this.negotiations.set(neg.id, {
          id: neg.id,
          path: neg.path,
          key: typeof neg.key === 'string' && neg.key ? neg.key : pathKey(neg.path),
          a: String(neg.a),
          b: String(neg.b),
          labels: neg.labels && typeof neg.labels === 'object' ? neg.labels : {},
          holder: String(neg.holder || ''),
          writer: String(neg.writer || ''),
          writerMeta: neg.writerMeta && typeof neg.writerMeta === 'object' ? neg.writerMeta : {},
          handoffTo: typeof neg.handoffTo === 'string' ? neg.handoffTo : '',
          state,
          rounds: Number(neg.rounds) || 0,
          createdAt: Number(neg.createdAt) || now,
          updatedAt: Number(neg.updatedAt) || now,
          deadline: Number(neg.deadline) || now + this.deadlineMs,
          lastOffer: neg.lastOffer && neg.lastOffer.terms ? neg.lastOffer : null,
          pendingReleaseAt: Number(neg.pendingReleaseAt) || 0,
          pendingWakeAt: Number(neg.pendingWakeAt) || 0,
          resolution: typeof neg.resolution === 'string' ? neg.resolution : '',
          escalated: neg.escalated === true,
          history: Array.isArray(neg.history) ? neg.history.slice(-this.maxHistory) : []
        });
      }
    } catch (error) {
      this.logger?.warn?.(`[session-messenger] negotiations load failed, starting empty: ${(error && error.message) || error}`);
    } finally {
      this.ready = true;
    }
  }

  persist() {
    return this.file.write(() => ({ version: 2, savedAt: Date.now(), negotiations: [...this.negotiations.values()] }));
  }

  /** M3：同一方在 rateMs 内只能发一次意图。返回剩余等待毫秒（0 = 放行并记账）。 */
  rateLimited(negId, by, now) {
    const k = `${negId}\u0000${by}`;
    const last = this.rate.get(k) || 0;
    if (now - last < this.rateMs) return this.rateMs - (now - last);
    this.rate.set(k, now);
    if (this.rate.size > 1024) {
      for (const [key, at] of this.rate) if (now - at >= this.rateMs) this.rate.delete(key);
    }
    return 0;
  }

  /** 被状态机拒绝的意图退还额度，否则紧随其后的合法意图会被误伤。 */
  refundRate(negId, by) {
    this.rate.delete(`${negId}\u0000${by}`);
  }

  byId(id) {
    return this.negotiations.get(String(id || '').trim());
  }

  findOpenForPair(key, a, b) {
    const target = pairKey(key, a, b);
    for (const neg of this.negotiations.values()) {
      if (ACTIVE_STATES.has(neg.state) && pairKey(neg.key, neg.a, neg.b) === target) return neg;
    }
    return undefined;
  }

  /** 该文件上已约定、尚未执行的移交（accepted + pendingReleaseAt）。 */
  pendingHandoff(key) {
    for (const neg of this.negotiations.values()) {
      if (neg.key === key && neg.state === 'accepted' && neg.pendingReleaseAt > 0 && neg.handoffTo) return neg;
    }
    return undefined;
  }

  /**
   * 该文件上的等待队列（先来后到）：非终态协商，以及已接受 wait-until、仍在等待的写入方。
   * @param excludeId - 排除的协商（通常是刚完成移交的那一份）
   */
  queueFor(key, now, excludeId = '') {
    return [...this.negotiations.values()]
      .filter(
        (neg) =>
          neg.key === key &&
          neg.id !== excludeId &&
          (ACTIVE_STATES.has(neg.state) || (neg.state === 'accepted' && neg.pendingWakeAt > now && !neg.handoffTo))
      )
      .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
  }

  /** 1-based 排队位次（不在队列中返回 0）。 */
  positionOf(neg, now) {
    return this.queueFor(neg.key, now).findIndex((n) => n.id === neg.id) + 1;
  }

  /** 约定移交后，把同一文件上其余 open 协商转入 queued。返回被转入的协商。 */
  queueOthers(neg, now) {
    const moved = [];
    for (const other of this.negotiations.values()) {
      if (other.id === neg.id || other.key !== neg.key || other.state !== 'open') continue;
      other.state = 'queued';
      other.updatedAt = now;
      other.history.push({ at: now, event: 'queued', behind: neg.writer });
      moved.push(other);
    }
    return moved;
  }

  /** 移交完成后，把协商改绑到新占用方并重新开放（轮次、条款、期限全部重置）。 */
  rebind(neg, holderId, holderLabel, now) {
    const writer = neg.writer;
    neg.holder = String(holderId);
    neg.a = String(holderId);
    neg.b = writer;
    neg.labels = { ...(neg.labels || {}), [holderId]: holderLabel };
    neg.state = 'open';
    neg.rounds = 0;
    neg.lastOffer = null;
    neg.pendingWakeAt = 0;
    neg.resolution = '';
    neg.updatedAt = now;
    neg.deadline = now + this.deadlineMs;
    neg.history.push({ at: now, event: 'holder-changed', to: String(holderId) });
    if (neg.history.length > this.maxHistory) neg.history.splice(0, neg.history.length - this.maxHistory);
  }

  /** L3：最近一次终态协商（冷静期内返回）。 */
  recentTerminalForPair(key, a, b, now) {
    const target = pairKey(key, a, b);
    let best;
    for (const neg of this.negotiations.values()) {
      if (!TERMINAL_STATES.has(neg.state) || pairKey(neg.key, neg.a, neg.b) !== target) continue;
      if (now - neg.updatedAt >= this.cooldownMs) continue;
      if (!best || neg.updatedAt > best.updatedAt) best = neg;
    }
    return best;
  }

  /** 该会话参与的非终态协商（open / queued）。 */
  openForSession(sessionId) {
    return [...this.negotiations.values()].filter(
      (neg) => ACTIVE_STATES.has(neg.state) && (neg.a === sessionId || neg.b === sessionId)
    );
  }

  /**
   * H1：路径对 sessionId 是否处于「争议冻结」。冻结条件（且持有方仍持有该 claim，由调用方
   * 通过 holderHolds 判定——释放/过期后立即解冻，不必等看门狗）：
   *   open / queued；冷静期内 escalated；accepted 且约定的移交/等待时刻未到。
   * 持有方本人永不被冻结。返回冻结它的协商，否则 undefined。
   */
  frozenFor(key, sessionId, now, holderHolds) {
    for (const neg of this.negotiations.values()) {
      if (neg.key !== key || neg.holder === sessionId) continue;
      const frozen =
        ACTIVE_STATES.has(neg.state) ||
        (neg.state === 'escalated' && now - neg.updatedAt < this.cooldownMs) ||
        (neg.state === 'accepted' && (neg.pendingReleaseAt > now || neg.pendingWakeAt > now));
      if (!frozen) continue;
      if (holderHolds && !holderHolds(neg.holder, key)) continue;
      return neg;
    }
    return undefined;
  }

  open({ id, path: filePath, key, a, b, labels, holder, writer, writerMeta, now }) {
    const existing = this.findOpenForPair(key, a, b);
    if (existing) return { neg: existing, created: false };
    // 占用方已约定把该文件移交给别人：新写入方直接排队，不打扰占用方。
    const pending = this.pendingHandoff(key);
    const queued = !!pending && pending.holder === String(holder);
    const neg = {
      id,
      path: filePath,
      key,
      a: String(a),
      b: String(b),
      labels: labels || {},
      holder: String(holder || ''),
      writer: String(writer || ''),
      writerMeta: writerMeta && typeof writerMeta === 'object' ? writerMeta : {},
      handoffTo: '',
      state: queued ? 'queued' : 'open',
      rounds: 0,
      createdAt: now,
      updatedAt: now,
      deadline: now + this.deadlineMs,
      lastOffer: null,
      pendingReleaseAt: 0,
      pendingWakeAt: 0,
      resolution: '',
      escalated: false,
      history: []
    };
    this.negotiations.set(neg.id, neg);
    return { neg, created: true };
  }

  touch(neg, entry, now) {
    neg.history.push({ at: now, ...entry });
    if (neg.history.length > this.maxHistory) neg.history.splice(0, neg.history.length - this.maxHistory);
    neg.updatedAt = now;
    neg.deadline = now + this.deadlineMs;
  }

  mark(neg, state, resolution, now) {
    neg.state = state;
    neg.resolution = resolution || '';
    neg.updatedAt = now;
    if (state === 'escalated') neg.escalated = true;
  }

  /** 状态机主入口：只返回决策与待执行副作用。 */
  transition(neg, { by, action, terms, message, now }) {
    if (!neg) return { ok: false, reason: 'negotiation not found' };
    if (!ACTIVE_STATES.has(neg.state)) return { ok: false, reason: `negotiation is ${neg.state}` };
    if (by !== neg.a && by !== neg.b) return { ok: false, reason: 'you are not a party of this negotiation' };
    if (neg.state === 'queued' && action !== 'decline' && action !== 'escalate') {
      const pending = this.pendingHandoff(neg.key);
      const to = pending ? (pending.labels && pending.labels[pending.handoffTo]) || pending.handoffTo : 'the next holder';
      return {
        ok: false,
        reason: `this negotiation is queued: the holder already agreed to hand the file to ${to}${pending ? ` at ${new Date(pending.pendingReleaseAt).toISOString()}` : ''}. Wait for the handoff notice (you will then negotiate with the new holder), or decline to leave the queue.`
      };
    }
    const peerId = by === neg.a ? neg.b : neg.a;
    const isHolder = by === neg.holder;
    const label = (neg.labels && neg.labels[by]) || String(by).slice(0, 8);
    const note = String(message || '').slice(0, 2000);

    if (action === 'escalate' || action === 'decline') {
      const state = action === 'escalate' ? 'escalated' : 'declined';
      this.mark(neg, state, `${state} by ${label}`, now);
      this.touch(neg, { by, action, message: note }, now);
      return { ok: true, effects: { notifyPeer: peerId } };
    }

    if (action === 'offer' || action === 'counter') {
      const normalized = normalizeTerms(terms);
      if (!normalized) return { ok: false, reason: 'terms must be {action: release-now|release-at|wait-until, at?: ISO-8601}' };
      if (RELEASE_ACTIONS.has(normalized.action) && !isHolder) {
        return {
          ok: false,
          reason: 'only the current claim holder can offer release-now / release-at; as the writer offer {action:"wait-until", at} or decline'
        };
      }
      if (RELEASE_ACTIONS.has(normalized.action) && this.pendingHandoff(neg.key)) {
        return { ok: false, reason: 'you already agreed to hand this file to another session; it cannot be promised twice' };
      }
      if (normalized.action === 'wait-until' && isHolder) {
        return { ok: false, reason: 'wait-until is the writer\'s commitment; as the holder offer release-now / release-at or decline' };
      }
      if (normalized.at !== undefined) {
        if (normalized.at <= now) return { ok: false, reason: 'terms.at must be in the future' };
        if (normalized.at > now + MAX_AHEAD_MS) return { ok: false, reason: 'terms.at must be within 60 minutes' };
      }
      if (neg.rounds + 1 > this.maxRounds) {
        this.mark(neg, 'escalated', `round limit (${this.maxRounds}) reached`, now);
        this.touch(neg, { by, action, terms: normalized, message: note }, now);
        return { ok: true, effects: { notifyPeer: peerId, notifySelf: true, escalated: true } };
      }
      neg.rounds += 1;
      neg.lastOffer = { by, terms: normalized, message: note };
      this.touch(neg, { by, action, terms: normalized, message: note }, now);
      return { ok: true, effects: { notifyPeer: peerId } };
    }

    if (action === 'accept') {
      const offer = neg.lastOffer;
      if (!offer || !offer.terms) return { ok: false, reason: 'there is no pending offer to accept' };
      if (offer.by === by) return { ok: false, reason: 'you cannot accept your own offer; the other party must accept' };
      const t = offer.terms;
      if (t.at !== undefined && t.at <= now && t.action === 'wait-until') {
        return { ok: false, reason: 'the offered wait-until time has already passed; ask for a new offer' };
      }
      if ((t.action === 'release-now' || t.action === 'release-at') && this.pendingHandoff(neg.key)) {
        return { ok: false, reason: 'the holder already agreed to hand this file to another session' };
      }
      this.touch(neg, { by, action, message: note }, now);
      const writerLabel = (neg.labels && neg.labels[neg.writer]) || String(neg.writer).slice(0, 8);
      if (t.action === 'release-now' || (t.action === 'release-at' && t.at <= now)) {
        this.mark(neg, 'accepted', `holder hands the file to ${writerLabel} now (accepted by ${label})`, now);
        neg.handoffTo = neg.writer;
        return { ok: true, effects: { handoff: true, releaseSessionId: neg.holder, releaseAt: now, notifyPeer: peerId } };
      }
      if (t.action === 'release-at') {
        this.mark(neg, 'accepted', `holder hands the file to ${writerLabel} at ${new Date(t.at).toISOString()} (accepted by ${label})`, now);
        neg.pendingReleaseAt = t.at;
        neg.handoffTo = neg.writer;
        return { ok: true, effects: { handoff: true, releaseSessionId: neg.holder, releaseAt: t.at, notifyPeer: peerId } };
      }
      this.mark(neg, 'accepted', `writer waits until ${new Date(t.at).toISOString()} (accepted by ${label})`, now);
      neg.pendingWakeAt = t.at;
      return { ok: true, effects: { wakeAt: t.at, notifyPeer: peerId } };
    }

    return { ok: false, reason: `unknown action "${action}"` };
  }

  /** 看门狗扫描：超时 → 升级；到点的 pending 释放/唤醒交回调用方执行。 */
  scan(now) {
    const escalate = [];
    const dueReleases = [];
    const dueWakes = [];
    for (const neg of this.negotiations.values()) {
      // queued 不走超时升级：它在等一次已约定的移交，而不是等对方回应。
      if (neg.state === 'open' && now >= neg.deadline) {
        this.mark(neg, 'escalated', 'no response before deadline', now);
        escalate.push(neg);
        continue;
      }
      if (neg.state !== 'accepted') continue;
      if (neg.pendingReleaseAt && now >= neg.pendingReleaseAt) {
        neg.pendingReleaseAt = 0;
        neg.updatedAt = now;
        dueReleases.push(neg);
      }
      if (neg.pendingWakeAt && now >= neg.pendingWakeAt) {
        neg.pendingWakeAt = 0;
        neg.updatedAt = now;
        dueWakes.push(neg);
      }
    }
    return { escalate, dueReleases, dueWakes };
  }

  /** M2：回收终态且静置超过 retentionMs、且没有待执行 pending 的记录。 */
  prune(now, retentionMs = 30 * 60 * 1000) {
    const removable = (neg) => TERMINAL_STATES.has(neg.state) && !neg.pendingReleaseAt && !neg.pendingWakeAt;
    let removed = 0;
    for (const [id, neg] of [...this.negotiations.entries()]) {
      if (removable(neg) && now - neg.updatedAt > Math.max(retentionMs, this.cooldownMs)) {
        this.negotiations.delete(id);
        removed += 1;
      }
    }
    if (this.negotiations.size > 200) {
      const terminal = [...this.negotiations.values()].filter(removable).sort((x, y) => x.updatedAt - y.updatedAt);
      for (const neg of terminal.slice(0, this.negotiations.size - 200)) {
        this.negotiations.delete(neg.id);
        removed += 1;
      }
    }
    return removed;
  }
}
