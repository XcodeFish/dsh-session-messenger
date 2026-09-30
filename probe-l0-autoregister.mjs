/**
 * L0 自动登记回归探针 —— 在真实 cordis 上复现「根级插件旁听子作用域瀑布」的生产拓扑。
 *
 * 为什么需要它（2026-09-30 实测教训）：
 * 1. 宿主是在**工具执行时的 agent 作用域 ctx** 上分发 fs 瀑布的
 *    （dsh-tool-fs/lib/index.js:583 `await ctx.waterfall("fs/write-intent", target, exec, () => void 0)`）；
 *    根级插件直接 ctx.on('fs/write-intent') **听不到**该作用域的分发 —— L0 首测失败的根因。
 *    正解：ctx.on('internal/dispatch', cb, { global: true })（宿主 fs 守卫插件同款）。
 * 2. FsTarget 实形 { targetKey, displayPath }，displayPath 相对 cwd 优先 —— 需归一化回绝对路径。
 * 3. fire-and-forget persist 会并发竞态，必须走 persistCoalesced()（本探针两段式断言可捕获回归）。
 *
 * 用法：node probe-l0-autoregister.mjs
 * 退出码 0 = PASS（0 uncaught 且 write/edit 两个事件各自的自动登记都正确落盘）
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.DSH_APP_DIR || '/Applications/DSH NEXT.app/Contents/Resources/app';
const PLUGIN = process.argv[2] || path.join(HERE, 'index.js');
const DATA_DIR = path.join(HERE, '.probe-l0-claims');
const CLAIMS_FILE = path.join(DATA_DIR, 'claims.json');

const uncaught = [];
process.on('uncaughtException', (error) => {
  uncaught.push(error);
  console.log('UNCAUGHT ->', (error && error.message) || error);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await fs.rm(DATA_DIR, { recursive: true, force: true });

const { Context } = await import(
  pathToFileURL(path.join(APP, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href
);

const registered = [];
const app = new Context();
app.provide('tools', {
  register: (definition) => {
    registered.push(definition);
    return () => {};
  }
});

// sessions / sessionController 由兄弟 fiber 提供（还原生产可见性）。
await app.plugin({
  name: 'session-services-provider',
  apply(ctx) {
    ctx.provide('sessions', { list: () => [] });
    ctx.provide('sessionController', { prompt: async () => ({ ok: true }) });
  }
});

// 被测插件（根级，与生产同层级）。
const plugin = await import(pathToFileURL(path.resolve(PLUGIN)).href);
await app.plugin(plugin, { dataDir: DATA_DIR });
await sleep(1200); // 等激活（inject 主路径即时；余量覆盖兜底定时器）

// 关键：在**子 fiber** 里分发 fs 瀑布，模拟工具在 agent 作用域内的写入意图。
const WORKSPACE = '/tmp/messenger-l0-ws';
const TARGET = { targetKey: `${WORKSPACE}/src/probe.ts`, displayPath: 'src/probe.ts' };
const EXEC = { name: 'write', agent: { id: 'session-l0-probe', session: { header: { cwd: WORKSPACE } } } };

let emitSeq = 0;
async function emitIntent(eventName) {
  emitSeq += 1;
  await app.plugin({
    name: `scoped-fs-emitter-${emitSeq}-${eventName.replace('/', '-')}`,
    async apply(ctx) {
      await ctx.waterfall(eventName, TARGET, EXEC, () => undefined);
    }
  });
}

async function readClaims() {
  try {
    const parsed = JSON.parse(await fs.readFile(CLAIMS_FILE, 'utf8'));
    return Array.isArray(parsed.claims) ? parsed.claims : [];
  } catch {
    return [];
  }
}

const expectedPath = path.normalize(path.join(WORKSPACE, 'src/probe.ts'));

// 两段式：同一 (session,path) 的记录会被后一次操作 upsert，故必须分步断言，
// 否则无法区分「edit 事件没到」与「两事件都到但都写同一条」。
await emitIntent('fs/write-intent');
await sleep(500);
const afterWrite = await readClaims();
const writeOk = afterWrite.some(
  (c) => c.path === expectedPath && c.note === 'auto:write' && c.sessionId === 'session-l0-probe'
);

await emitIntent('fs/edit-intent');
await sleep(500);
const afterEdit = await readClaims();
const editOk = afterEdit.some(
  (c) => c.path === expectedPath && c.note === 'auto:edit' && c.sessionId === 'session-l0-probe'
);

console.log('plugin under test:', path.resolve(PLUGIN));
console.log('registered tools:', JSON.stringify(registered.map((d) => d.name)));
console.log('after write:', JSON.stringify(afterWrite.map((c) => ({ path: c.path, note: c.note, sessionId: c.sessionId }))));
console.log('after edit :', JSON.stringify(afterEdit.map((c) => ({ path: c.path, note: c.note, sessionId: c.sessionId }))));
console.log('uncaught exceptions:', uncaught.length);

await app.stop?.();
await fs.rm(DATA_DIR, { recursive: true, force: true });

const ok = uncaught.length === 0 && writeOk && editOk;
console.log(ok ? 'PROBE PASS' : `PROBE FAIL (write=${writeOk} edit=${editOk})`);
process.exit(ok ? 0 : 1);
