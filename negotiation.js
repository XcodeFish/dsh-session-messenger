/**
 * NegotiationStore — 冲突协商的状态机与持久化（v3）。
 *
 * 设计原则（每一条都对应一类失败模式）：
 * 1. 结构化意图：只有插件能机械判断「谈成」，所以 offer/counter/accept/decline/escalate
 *    必须是一等字段，message 只是附注。
 * 2. 权限边界：只有 claim 持有方能提出 release-*（只有他有东西可让）；写入方只能提
 *    wait-until 或 decline —— 拒绝「慷他人之慨」条款。
 * 3. 沉默不等于同意：无响应只走看门狗升级人工，默认保守结果 = 占用方保留 claim。
 * 4. 每轮消息刷新 deadline（活性信号），轮次超限或超时未响应 → escalated。
 * 5. 状态全部落盘（原子写 + 脏标记合并写，复用 registry 的模式），重启后可恢复；
 *    定时器不跨重启，由调用方在 activate 时按 deadline/pendingReleaseAt 重挂。
 *
 * 本模块只做状态与决策，不做副作用：释放 claim / 发消息 / 挂定时器由调用方执行，
 * 便于单元与探针直接驱动状态机。
 */

const TERMINAL_STATES = new Set(['accepted', 'declined', 'escalated', 'resolved']);

const RELEASE_ACTIONS = new Set(['release-now', 'release-at']);

function pairKey(path, a, b) {
  const [x, y] = [String(a), String(b)].sort();
  return `${path}\u0000${x}\u0000${y}`;
}

function normalizeTerms(terms) {
  if (!terms || typeof terms !== 'object') return undefined;
  const action = String(terms.action || '').trim();
  if (!['release-now', 'release-at', 'wait-until'].includes(action)) return undefined;
  if (action === 'release-now') return { action };
  const at = Date.parse(String(terms.at || ''));
  if (!Number.isFinite(at)) return undefined;
  return { action, at };
}

export class NegotiationStore {
  constructor({ dataDir, logger, deadlineMs, maxRounds, rateMs, maxHistory = 12 }) {
    this.dir = dataDir;
    this.file = `${dataDir}/negotiations.json`;
    this.logger = logger;
    this.deadlineMs = deadlineMs;
    this.maxRounds = maxRounds;
    this.rateMs = rateMs;
    this.maxHistory = maxHistory;
    /** @type {Map<string, object>} */
    this.negotiations = new Map();
    this.loaded = false;
    this.chain = Promise.resolve();
    this.persistRunning = undefined;
    this.persistDirty = false;
    /** @type {Map<string, number>} pairKey -> lastIntentAt（每对限速，防模型互喷） */
    this.rate = new Map();
  }

  serialized(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async load(now) {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const { promises: fsp } = await import('node:fs');
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed && parsed.negotiations) ? parsed.negotiations : [];
      for (const neg of list) {
        if (!neg || typeof neg.id !== 'string' || typeof neg.path !== 'string') continue;
        if (!neg.a || !neg.b) continue;
        this.negotiations.set(neg.id, {
          id: neg.id,
          path: neg.path,
          a: String(neg.a),
          b: String(neg.b),
          labels: neg.labels && typeof neg.labels === 'object' ? neg.labels : {},
          holder: String(neg.holder || ''),
          writer: String(neg.writer || ''),
          state: TERMINAL_STATES.has(neg.state) ? neg.state : 'open',
          rounds: Number(neg.rounds) || 0,
          createdAt: Number(neg.createdAt) || now,
          updatedAt: Number(neg.updatedAt) || now,
          deadline: Number(neg.deadline) || now + this.deadlineMs,
          lastOffer: neg.lastOffer || null,
          pendingReleaseAt: Number(neg.pendingReleaseAt) || 0,
          pendingWakeAt: Number(neg.pendingWakeAt) || 0,
          resolution: typeof neg.resolution === 'string' ? neg.resolution : '',
          escalated: neg.escalated === true,
          history: Array.isArray(neg.history) ? neg.history.slice(-this.maxHistory) : []
        });
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.logger?.warn?.(`[session-messenger] negotiations load failed, starting empty: ${error.message || error}`);
      }
    }
  }

  async persist() {
    const { promises: fsp } = await import('node:fs');
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(
      { version: 1, savedAt: Date.now(), negotiations: [...this.negotiations.values()] },
      null,
      2
    );
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(tmp, payload, 'utf8');
    await fsp.rename(tmp, this.file);
  }

  persistCoalesced() {
    if (this.persistRunning) {
      this.persistDirty = true;
      return this.persistRunning;
    }
    this.persistRunning = (async () => {
      try {
        do {
          this.persistDirty = false;
          await this.persist();
        } while (this.persistDirty);
      } finally {
        this.persistRunning = undefined;
      }
    })();
    return this.persistRunning;
  }

  /** 每对 (path, 双方) 的意图限速：模型互喷时的第一道闸。 */
  rateLimited(key, now) {
    if (this.rate.size > 512) this.rate.clear();
    const last = this.rate.get(key) || 0;
    if (now - last < this.rateMs) return true;
    this.rate.set(key, now);
    return false;
  }

  /** 退还限速额度：被状态机拒绝的意图（权限/缺前置条件）不该消耗配额，否则紧随其后的合法意图会被误伤。 */
  refundRate(key) {
    this.rate.delete(key);
  }

  byId(id) {
    return this.negotiations.get(String(id || ''));
  }

  /** 同一 (path, pair) 只允许一个未终态的协商：防重复开桌。 */
  findOpenForPair(path, a, b) {
    const key = pairKey(path, a, b);
    for (const neg of this.negotiations.values()) {
      if (TERMINAL_STATES.has(neg.state)) continue;
      if (pairKey(neg.path, neg.a, neg.b) === key) return neg;
    }
    return undefined;
  }

  openForSession(sessionId) {
    return [...this.negotiations.values()].filter(
      (neg) => !TERMINAL_STATES.has(neg.state) && (neg.a === sessionId || neg.b === sessionId)
    );
  }

  open({ id, path, a, b, labels, holder, writer, now }) {
    const existing = this.findOpenForPair(path, a, b);
    if (existing) return { neg: existing, created: false };
    const neg = {
      id,
      path,
      a: String(a),
      b: String(b),
      labels: labels || {},
      holder: String(holder || ''),
      writer: String(writer || ''),
      state: 'open',
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

  /** 记录一条历史（封顶），并刷新活性 deadline。 */
  touch(neg, entry, now) {
    neg.history.push({ at: now, ...entry });
    if (neg.history.length > this.maxHistory) neg.history.splice(0, neg.history.length - this.maxHistory);
    neg.updatedAt = now;
    neg.deadline = now + this.deadlineMs;
  }

  /**
   * 状态机主入口。只返回决策与待执行副作用，不改 claim、不发消息。
   * @returns {{ok:boolean, reason?:string, effects?:object}}
   *   effects: { releaseSessionId?:string, releaseAt?:number, wakeAt?:number }
   */
  transition(neg, { by, action, terms, message, now }) {
    if (!neg) return { ok: false, reason: 'negotiation not found' };
    if (neg.state !== 'open') return { ok: false, reason: `negotiation is ${neg.state}` };
    const peerId = by === neg.a ? neg.b : neg.a;
    const isHolder = by === neg.holder;
    const isWriter = by === neg.writer;
    const label = (neg.labels && neg.labels[by]) || by.slice(0, 8);

    if (action === 'escalate') {
      this.mark(neg, 'escalated', `escalated by ${label}`, now);
      this.touch(neg, { by, action, message: message || '' }, now);
      return { ok: true, effects: { notifyPeer: peerId } };
    }

    if (action === 'decline') {
      this.mark(neg, 'declined', `declined by ${label}`, now);
      this.touch(neg, { by, action, message: message || '' }, now);
      return { ok: true, effects: { notifyPeer: peerId } };
    }

    if (action === 'offer' || action === 'counter') {
      const normalized = normalizeTerms(terms);
      if (!normalized) return { ok: false, reason: 'terms must be {action: release-now|release-at|wait-until, at?}' };
      if (RELEASE_ACTIONS.has(normalized.action) && !isHolder) {
        return {
          ok: false,
          reason: 'only the current claim holder can offer release-now / release-at; as the writer offer {action:"wait-until", at} or decline'
        };
      }
      if (normalized.action === 'wait-until' && !isWriter && !isHolder) {
        return { ok: false, reason: 'unknown party' };
      }
      if (normalized.at !== undefined) {
        const maxAhead = now + 60 * 60 * 1000;
        if (normalized.at <= now) return { ok: false, reason: 'terms.at must be in the future' };
        if (normalized.at > maxAhead) return { ok: false, reason: 'terms.at must be within 60 minutes' };
      }
      neg.rounds += 1;
      if (neg.rounds > this.maxRounds) {
        this.mark(neg, 'escalated', `round limit (${this.maxRounds}) reached`, now);
        return { ok: true, effects: { notifyPeer: peerId, escalated: true } };
      }
      neg.lastOffer = { by, terms: normalized, message: message || '' };
      this.touch(neg, { by, action, terms: normalized, message: message || '' }, now);
      return { ok: true, effects: { notifyPeer: peerId } };
    }

    if (action === 'accept') {
      const offer = neg.lastOffer;
      if (!offer || !offer.terms) return { ok: false, reason: 'there is no pending offer to accept' };
      if (offer.by === by) return { ok: false, reason: 'you cannot accept your own offer; the other party must accept' };
      const t = offer.terms;
      this.touch(neg, { by, action, message: message || '' }, now);
      if (t.action === 'release-now') {
        this.mark(neg, 'accepted', `holder releases now (accepted by ${label})`, now);
        return { ok: true, effects: { releaseSessionId: neg.holder, releaseAt: now, notifyPeer: peerId } };
      }
      if (t.action === 'release-at') {
        this.mark(neg, 'accepted', `holder releases at ${new Date(t.at).toISOString()} (accepted by ${label})`, now);
        neg.pendingReleaseAt = t.at;
        return { ok: true, effects: { releaseSessionId: neg.holder, releaseAt: t.at, notifyPeer: peerId } };
      }
      // wait-until：写入方承诺等待，到点提醒其可以重试（claim 不变）
      this.mark(neg, 'accepted', `writer waits until ${new Date(t.at).toISOString()} (accepted by ${label})`, now);
      neg.pendingWakeAt = t.at;
      return { ok: true, effects: { wakeAt: t.at, notifyPeer: peerId } };
    }

    return { ok: false, reason: `unknown action "${action}"` };
  }

  mark(neg, state, resolution, now) {
    neg.state = state;
    neg.resolution = resolution || '';
    neg.updatedAt = now;
    if (state === 'escalated') neg.escalated = true;
  }

  /** 看门狗扫描：超时/超轮次 → 升级；到点的 pending 释放/唤醒交回调用方执行。 */
  scan(now) {
    const escalate = [];
    const dueReleases = [];
    const dueWakes = [];
    for (const neg of this.negotiations.values()) {
      if (neg.state === 'open' && now >= neg.deadline) {
        this.mark(neg, 'escalated', 'no response before deadline', now);
        escalate.push(neg);
        continue;
      }
      if (neg.state === 'accepted' && neg.pendingReleaseAt && now >= neg.pendingReleaseAt) {
        neg.pendingReleaseAt = 0;
        dueReleases.push(neg);
      }
      if (neg.state === 'accepted' && neg.pendingWakeAt && now >= neg.pendingWakeAt) {
        neg.pendingWakeAt = 0;
        dueWakes.push(neg);
      }
    }
    return { escalate, dueReleases, dueWakes };
  }

  /** 回收终态且静置超过 retentionMs 的记录，防文件无限增长。 */
  prune(now, retentionMs = 30 * 60 * 1000) {
    let removed = 0;
    for (const [id, neg] of [...this.negotiations.entries()]) {
      if (TERMINAL_STATES.has(neg.state) && now - neg.updatedAt > retentionMs) {
        this.negotiations.delete(id);
        removed += 1;
      }
    }
    // 硬上限兜底：超过 200 条时清掉最老的终态记录
    if (this.negotiations.size > 200) {
      const terminal = [...this.negotiations.values()]
        .filter((neg) => TERMINAL_STATES.has(neg.state))
        .sort((x, y) => x.updatedAt - y.updatedAt);
      for (const neg of terminal.slice(0, this.negotiations.size - 200)) {
        this.negotiations.delete(neg.id);
        removed += 1;
      }
    }
    return removed;
  }
}
