/**
 * 插件自有存储：数据目录解析、单宿主进程所有权锁、原子 JSON 合并写。
 *
 * - 绝不写 session event（自定义事件类型会让 Session 拒绝重开），状态落在
 *   ~/.dsh/plugin-data/dsh-session-messenger/<profile>/。
 * - 每个宿主进程的内存是真相；多个宿主进程（如 desktop 与 dsh web）若共享同一目录会
 *   互相覆盖，因此用 owner.lock（O_EXCL + pid 存活检查）确保同一目录只有一个写入进程；
 *   抢不到锁的进程退到 host-<pid>/ 隔离子目录并告警（它本来也看不到对方宿主的会话）。
 * - 所有落盘统一走 JsonFile.write()：tmp（随机名）+ rename 原子替换，飞行中再脏则
 *   跑第二轮（合并写），保证最终落盘的是最后一次内存状态。
 */
import { promises as fsp, openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export function defaultDataDir(config) {
  if (config && typeof config.dataDir === 'string' && config.dataDir) return config.dataDir;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profile = String(process.env.DSH_PROFILE || (config && config.profile) || 'default').replace(/[^\w.-]/g, '_');
  return path.join(home, 'plugin-data', 'dsh-session-messenger', profile);
}

/**
 * v0.3 把状态放在 plugin-data/dsh-session-messenger/ 根目录；v0.4 按 profile 分目录。
 * 首次激活时把旧文件**复制**（不移动，便于回滚）到新目录，已存在则不覆盖。
 */
export function migrateLegacyData(baseDir, logger) {
  try {
    const legacyDir = path.dirname(baseDir);
    if (path.basename(legacyDir) !== 'dsh-session-messenger') return;
    mkdirSync(baseDir, { recursive: true });
    for (const file of ['claims.json', 'negotiations.json']) {
      const from = path.join(legacyDir, file);
      const to = path.join(baseDir, file);
      if (existsSync(from) && !existsSync(to)) {
        copyFileSync(from, to);
        logger?.info?.(`[session-messenger] migrated legacy ${file} into ${baseDir}`);
      }
    }
  } catch (error) {
    logger?.warn?.(`[session-messenger] legacy data migration skipped: ${(error && error.message) || error}`);
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!(error && error.code === 'EPERM');
  }
}

/**
 * 取得目录所有权。返回 { dir, release }：dir 是本进程实际使用的数据目录。
 * 同步实现：激活路径只调用一次，且必须在任何读写之前确定目录。
 */
export function acquireDataDir(baseDir, logger) {
  mkdirSync(baseDir, { recursive: true });
  const lockFile = path.join(baseDir, 'owner.lock');
  const body = JSON.stringify({ pid: process.pid, at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockFile, 'wx');
      writeSync(fd, body);
      closeSync(fd);
      return { dir: baseDir, release: () => releaseLock(lockFile) };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    let owner = 0;
    try {
      owner = Number(JSON.parse(readFileSync(lockFile, 'utf8')).pid) || 0;
    } catch {
      owner = 0;
    }
    if (owner === process.pid || !pidAlive(owner)) {
      // 自己（HMR 重新激活）或已死进程留下的锁：接管。
      try {
        unlinkSync(lockFile);
      } catch {
        /* raced; retry once */
      }
      continue;
    }
    const isolated = path.join(baseDir, `host-${process.pid}`);
    mkdirSync(isolated, { recursive: true });
    logger?.warn?.(
      `[session-messenger] data dir ${baseDir} is owned by live host pid ${owner}; this host uses isolated ${isolated} (claims are not shared across host processes)`
    );
    return { dir: isolated, release: () => undefined };
  }
  throw new Error(`could not acquire ${lockFile}`);
}

function releaseLock(lockFile) {
  try {
    const owner = Number(JSON.parse(readFileSync(lockFile, 'utf8')).pid) || 0;
    if (owner === process.pid) unlinkSync(lockFile);
  } catch {
    /* already gone */
  }
}

export class JsonFile {
  constructor(file) {
    this.file = file;
    this.running = undefined;
    this.dirty = false;
  }

  async read() {
    try {
      return JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async writeOnce(snapshot) {
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    try {
      await fsp.writeFile(tmp, JSON.stringify(snapshot(), null, 2), 'utf8');
      await fsp.rename(tmp, this.file);
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 合并写：snapshot 在每一轮写入时才求值，因此返回的 Promise 兑现时，
   * 磁盘上已是「调用时刻或更新」的内存状态。
   */
  write(snapshot) {
    if (this.running) {
      this.dirty = true;
      this.pendingSnapshot = snapshot;
      return this.running;
    }
    this.pendingSnapshot = snapshot;
    this.running = (async () => {
      try {
        do {
          this.dirty = false;
          await this.writeOnce(this.pendingSnapshot);
        } while (this.dirty);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }
}
