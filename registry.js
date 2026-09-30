/**
 * ClaimRegistry — 插件自有存储的文件占用登记表。
 *
 * 设计要点（对应方案评审结论）：
 * - 绝不写 session event（practices.md 明文：自定义事件类型会让 Session 拒绝重开），
 *   状态落在插件自有 JSON 文件（~/.dsh/plugin-data/dsh-session-messenger/claims.json）。
 * - 单 Host 进程内存真相 + 落盘持久（跨重启保留未过期 claim），原子写（tmp + rename）。
 * - 键 = (sessionId, 绝对路径)；每条 claim 必带 TTL，过期即剪枝（防死锁的兜底）。
 * - 所有变更经进程内串行队列，避免并发读写交错。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const keyOf = (sessionId, absPath) => `${sessionId}\u0000${absPath}`;

export class ClaimRegistry {
  constructor({ dataDir, logger }) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'claims.json');
    this.logger = logger;
    /** @type {Map<string, {sessionId:string,label:string,cwd:string,path:string,claimedAt:number,expiresAt:number,note:string}>} */
    this.claims = new Map();
    this.loaded = false;
    /** @type {Promise<void>} */
    this.chain = Promise.resolve();
  }

  /** Serialize every mutation/read-modify-write through one in-process queue. */
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
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed && parsed.claims) ? parsed.claims : [];
      for (const c of list) {
        if (!c || typeof c.path !== 'string' || typeof c.sessionId !== 'string') continue;
        const expiresAt = Number(c.expiresAt) || 0;
        if (expiresAt <= now) continue;
        this.claims.set(keyOf(c.sessionId, c.path), {
          sessionId: c.sessionId,
          label: typeof c.label === 'string' ? c.label : c.sessionId,
          cwd: typeof c.cwd === 'string' ? c.cwd : '',
          path: c.path,
          claimedAt: Number(c.claimedAt) || now,
          expiresAt,
          note: typeof c.note === 'string' ? c.note : ''
        });
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.logger?.warn?.(`[session-messenger] claims load failed, starting empty: ${error.message || error}`);
      }
    }
  }

  prune(now) {
    for (const [key, claim] of this.claims) {
      if (claim.expiresAt <= now) this.claims.delete(key);
    }
  }

  /** 快照全部活 claim（先剪枝）；供硬闸门等只读消费方使用。 */
  listLive(now) {
    this.prune(now);
    return [...this.claims.values()];
  }

  async persist() {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(
      { version: 1, savedAt: Date.now(), claims: [...this.claims.values()] },
      null,
      2
    );
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, this.file);
  }

  /**
   * 合并写：L0 自动登记是 fire-and-forget，多个写入意图可能在毫秒内连续触发
   * （同一工具的 write 紧接 edit）。naive 的并发 persist 会让后 rename 的旧快照
   * 覆盖新快照（2026-09-30 L0 探针实测：auto:edit 消失、只剩 auto:write）。
   * 这里用「飞行中再脏就跑第二轮」的合并写，保证最终落盘的是最后一次内存状态。
   */
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

  /**
   * All-or-nothing claim: if ANY requested path is live-claimed by ANOTHER session,
   * nothing is registered and the conflict list is returned.
   */
  claim({ sessionId, label, cwd, paths, ttlSeconds, note, now }) {
    this.prune(now);
    const conflicts = [];
    for (const absPath of paths) {
      for (const claim of this.claims.values()) {
        if (claim.path === absPath && claim.sessionId !== sessionId && claim.expiresAt > now) {
          conflicts.push({
            path: absPath,
            ownerSessionId: claim.sessionId,
            ownerLabel: claim.label || claim.sessionId,
            expiresAt: claim.expiresAt,
            note: claim.note || ''
          });
        }
      }
    }
    if (conflicts.length > 0) return { registered: false, conflicts, expiresAt: 0 };
    const expiresAt = now + ttlSeconds * 1000;
    for (const absPath of paths) {
      // Re-claim by the same session refreshes the TTL instead of failing.
      this.claims.delete(keyOf(sessionId, absPath));
      this.claims.set(keyOf(sessionId, absPath), {
        sessionId,
        label: label || sessionId,
        cwd: cwd || '',
        path: absPath,
        claimedAt: now,
        expiresAt,
        note: note || ''
      });
    }
    return { registered: true, conflicts: [], expiresAt };
  }

  /** Release this session's claims: all of them when paths is null, else only the listed ones. */
  release(sessionId, paths) {
    let count = 0;
    for (const [key, claim] of [...this.claims.entries()]) {
      if (claim.sessionId !== sessionId) continue;
      if (paths && !paths.includes(claim.path)) continue;
      this.claims.delete(key);
      count += 1;
    }
    return count;
  }
}
