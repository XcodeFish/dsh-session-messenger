/**
 * ClaimRegistry — 文件占用登记表（内存真相 + 原子落盘）。
 *
 * 数据模型：键 = (sessionId, 路径身份键 key)。每条 claim：
 *   { sessionId, parent(父会话 id，子代理才有), label, cwd, path(展示用绝对路径), key(realpath 身份键),
 *     origin:'manual'|'auto', sessionOrigin:'session'|'subagent', claimedAt, expiresAt, note }
 * - 同一家族（父会话与其子代理）之间不构成冲突，见 util.sameFamily。
 *
 * 语义要点（逐条对应审查结论）：
 * - H2：自动登记（写入意图）绝不削弱手动 claim——同会话已有 claim 时只把 expiresAt 延长到
 *   max(现有, now+autoTtl)，保留原 note / origin / claimedAt；手动再 claim 同路径则升级为 manual。
 * - All-or-nothing：任一路径被他人活 claim 占用 → 一条都不登记，返回冲突列表。
 * - M4：唯一落盘入口 persist()（JsonFile 合并写），不存在两条互不感知的写路径。
 * - M7：load() 完成前 ready=false；调用方必须在 ready 之后才对外提供工具。
 * - 同步 API：所有变更在单 tick 内完成（Node 单线程），天然无交错；落盘异步合并。
 */
import path from 'node:path';
import { JsonFile } from './storage.js';
import { pathKey, labelFor, isLegacyLabel, originOfHeader, sameFamily } from './util.js';

const FORMAT_VERSION = 2;
const keyOf = (sessionId, key) => `${sessionId}\u0000${key}`;

export class ClaimRegistry {
  constructor({ dataDir, logger }) {
    this.file = new JsonFile(path.join(dataDir, 'claims.json'));
    this.logger = logger;
    /** @type {Map<string, object>} */
    this.claims = new Map();
    this.ready = false;
  }

  async load(now) {
    if (this.ready) return;
    try {
      const parsed = await this.file.read();
      const list = parsed && Array.isArray(parsed.claims) ? parsed.claims : [];
      for (const c of list) {
        if (!c || typeof c.path !== 'string' || typeof c.sessionId !== 'string' || !path.isAbsolute(c.path)) continue;
        const expiresAt = Number(c.expiresAt) || 0;
        if (expiresAt <= now) continue;
        const key = typeof c.key === 'string' && c.key ? c.key : pathKey(c.path);
        const legacyAuto = String(c.note || '').startsWith('auto:');
        const origin = c.origin === 'manual' || c.origin === 'auto' ? c.origin : legacyAuto ? 'auto' : 'manual';
        this.claims.set(keyOf(c.sessionId, key), {
          sessionId: c.sessionId,
          parent: typeof c.parent === 'string' ? c.parent : '',
          label: isLegacyLabel(c.label) ? labelFor(c.sessionId, c.cwd) : c.label,
          cwd: typeof c.cwd === 'string' ? c.cwd : '',
          path: c.path,
          key,
          origin,
          sessionOrigin:
            c.sessionOrigin === 'subagent' || c.sessionOrigin === 'session' ? c.sessionOrigin : originOfHeader(undefined, c.sessionId),
          claimedAt: Number(c.claimedAt) || now,
          expiresAt,
          note: typeof c.note === 'string' ? c.note : ''
        });
      }
    } catch (error) {
      this.logger?.warn?.(`[session-messenger] claims load failed, starting empty: ${(error && error.message) || error}`);
    } finally {
      this.ready = true;
    }
  }

  persist() {
    return this.file.write(() => ({ version: FORMAT_VERSION, savedAt: Date.now(), claims: [...this.claims.values()] }));
  }

  prune(now) {
    let removed = 0;
    for (const [k, claim] of this.claims) {
      if (claim.expiresAt <= now) {
        this.claims.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  listLive(now) {
    this.prune(now);
    return [...this.claims.values()];
  }

  /** 他人（非本会话、非同家族）在该身份键上的活 claim；manual 优先、到期晚者优先。 */
  othersOn(key, sessionId, now, parent = '') {
    return this.listLive(now)
      .filter((c) => c.key === key && !sameFamily(sessionId, parent, c.sessionId, c.parent))
      .sort((x, y) => (x.origin === y.origin ? y.expiresAt - x.expiresAt : x.origin === 'manual' ? -1 : 1));
  }

  own(sessionId, key) {
    return this.claims.get(keyOf(sessionId, key));
  }

  /**
   * All-or-nothing 登记。
   * @param entries - [{ path, key }]
   * @param origin - 'manual'（claim_files）| 'auto'（写入意图）
   */
  claim({ sessionId, parent = '', label, cwd, sessionOrigin, entries, ttlSeconds, note, origin, now }) {
    this.prune(now);
    const conflicts = [];
    for (const entry of entries) {
      for (const c of this.othersOn(entry.key, sessionId, now, parent)) {
        conflicts.push({
          path: entry.path,
          ownerSessionId: c.sessionId,
          ownerLabel: c.label || c.sessionId,
          ownerOrigin: c.origin,
          expiresAt: c.expiresAt,
          note: c.note || ''
        });
      }
    }
    if (conflicts.length > 0) return { registered: false, conflicts, expiresAt: 0 };
    const target = now + ttlSeconds * 1000;
    let expiresAt = target;
    for (const entry of entries) {
      const k = keyOf(sessionId, entry.key);
      const existing = this.claims.get(k);
      if (existing && origin === 'auto') {
        // H2：自动登记只延长，不降级、不覆盖 note/origin。
        existing.expiresAt = Math.max(existing.expiresAt, target);
        if (isLegacyLabel(existing.label) && label) existing.label = label;
        expiresAt = Math.min(expiresAt, existing.expiresAt);
        continue;
      }
      this.claims.set(k, {
        sessionId,
        parent: parent || '',
        label: label || sessionId,
        cwd: cwd || '',
        path: entry.path,
        key: entry.key,
        origin,
        sessionOrigin: sessionOrigin === 'subagent' ? 'subagent' : 'session',
        claimedAt: existing ? existing.claimedAt : now,
        expiresAt: target,
        note: note || (existing && existing.origin === 'manual' ? existing.note : '') || ''
      });
    }
    return { registered: true, conflicts: [], expiresAt };
  }

  /** 释放本会话的 claim：keys 为 null 时全部释放。返回释放条数。 */
  release(sessionId, keys) {
    let count = 0;
    const wanted = keys ? new Set(keys) : null;
    for (const [k, claim] of [...this.claims.entries()]) {
      if (claim.sessionId !== sessionId) continue;
      if (wanted && !wanted.has(claim.key)) continue;
      this.claims.delete(k);
      count += 1;
    }
    return count;
  }
}
