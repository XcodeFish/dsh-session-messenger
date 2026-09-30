/**
 * 真机验收取证脚本（只读）：读取真实会话日志与插件状态，判定 H3 / M5 在运行中宿主上的行为。
 *
 * 场景（由验收者事先布置）：
 *   A = 持有方（先 claim 再空闲；重启宿主后变成「冷」持久会话）
 *   B = 持有方（claim 后空闲、保持在内存）
 *   W = 写入方（写 A、B 各自占用的文件）
 *
 * 用法：node realhost-check.mjs <A-session-id> <B-session-id> <sinceEpochMs> [path-substring]
 * 判定：
 *   H3  A 的 claim 在写入之后仍在（未被当孤儿删除）
 *   M5  写入之后 A、B 都没有新开 turn（通知不唤醒空闲/冷会话）；B 收件箱里有协商消息（inject）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const [A, B, sinceRaw, needle = '__messenger_probe__'] = process.argv.slice(2);
const since = Number(sinceRaw);
if (!A || !B || !Number.isFinite(since)) {
  console.log('usage: node realhost-check.mjs <A> <B> <sinceEpochMs> [pathSubstring]');
  process.exit(2);
}
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

function readLog(id) {
  for (const dir of fs.readdirSync(path.join(HOME, 'sessions'))) {
    const file = path.join(HOME, 'sessions', dir, id, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    const out = [];
    let o = 0;
    while (o + 4 <= buf.length && buf.readUInt32LE(o) === 4247762216) {
      const s = o;
      o += 4;
      const d = buf.readUInt8(o);
      o += 1;
      const csf = d >>> 6;
      const ss = (d & 32) !== 0;
      const df = d & 3;
      o += (ss ? 0 : 1) + (df === 3 ? 4 : df) + (csf === 0 ? (ss ? 1 : 0) : 1 << csf);
      let torn = false;
      for (;;) {
        if (buf.length - o < 3) {
          torn = true;
          break;
        }
        const bh = buf.readUIntLE(o, 3);
        o += 3;
        o += (bh >>> 1) & 3 ? (((bh >>> 1) & 3) === 1 ? 1 : bh >>> 3) : bh >>> 3;
        if (bh & 1) break;
      }
      if ((d & 4) !== 0) o += 4;
      if (torn || o > buf.length) break;
      try {
        out.push(zstdDecompressSync(buf.subarray(s, o)));
      } catch {
        break;
      }
    }
    return Buffer.concat(out).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  return [];
}

function summarize(id) {
  const events = readLog(id);
  const after = events.filter((e) => (e.time || 0) >= since);
  return {
    turnsAfter: after.filter((e) => e.type === 'turn/start').length,
    inbox: after
      .filter((e) => e.type === 'agent/inbox/spliced')
      .flatMap((e) => (e.data.inserted || []).map((m) => ({ target: e.data.target, source: m.source && m.source.kind, text: (m.content || []).map((p) => p.text || '').join('') })))
      .filter((m) => m.text.includes('[[DSH session-messenger'))
  };
}

const dataRoot = path.join(HOME, 'plugin-data', 'dsh-session-messenger');
const claimFiles = [path.join(dataRoot, 'claims.json')];
for (const entry of fs.existsSync(dataRoot) ? fs.readdirSync(dataRoot) : []) {
  const f = path.join(dataRoot, entry, 'claims.json');
  if (fs.existsSync(f)) claimFiles.push(f);
}
const newest = claimFiles.filter(fs.existsSync).sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0];
const claims = newest ? JSON.parse(fs.readFileSync(newest, 'utf8')).claims || [] : [];
const held = (id) => claims.filter((c) => c.sessionId === id && c.path.includes(needle) && c.expiresAt > Date.now());

const a = summarize(A);
const b = summarize(B);
console.log('claims file :', newest);
console.log('A live claims:', held(A).map((c) => path.basename(c.path)));
console.log('B live claims:', held(B).map((c) => path.basename(c.path)));
console.log('A after since: turns=%d inbox=%j', a.turnsAfter, a.inbox.map((m) => `${m.target}/${m.source}`));
console.log('B after since: turns=%d inbox=%j', b.turnsAfter, b.inbox.map((m) => `${m.target}/${m.source}`));

const results = [
  ['H3 冷持有方 A 的 claim 未被删除', held(A).length > 0],
  ['M5 冷持有方 A 未被唤醒', a.turnsAfter === 0],
  ['M5 空闲持有方 B 未被唤醒', b.turnsAfter === 0],
  ['M5 空闲持有方 B 收到收件箱协商消息（不唤醒）', b.inbox.some((m) => m.source === 'session-messenger')]
];
for (const [label, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
