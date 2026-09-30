/**
 * v3 协商状态机探针 —— 在真实 cordis 上驱动完整的冲突协商闭环（无需真实宿主/重启）。
 *
 * 覆盖：
 *  A. 冲突自动开桌：A 手动 claim → B 写入意图 → 双方收到 negotiate 消息（含 neg id）
 *  B. 多轮：A（持有方）offer release-at → B accept → 定时释放由看门狗到点执行
 *  C. 沉默不升级错误结果：无人响应 → deadline → escalated，且 claim 保留（保守默认）
 *  D. 孤儿清理：持有方会话不在活跃列表 → 立即清 claim + 通知写入方，不开协商
 *  E. 限速/权限：写入方提 release-* 被拒（只有持有方能释放）
 *
 * 环境变量（探针自己设置，加快时序）：
 *   DSH_SESSION_MESSENGER_WATCHDOG_MS=500  DSH_SESSION_MESSENGER_NEG_DEADLINE_MS=1200
 *   DSH_SESSION_MESSENGER_NEG_MAX_ROUNDS=4 DSH_SESSION_MESSENGER_NEG_RATE_MS=50
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.DSH_SESSION_MESSENGER_WATCHDOG_MS = '500';
process.env.DSH_SESSION_MESSENGER_NEG_DEADLINE_MS = '1200';
process.env.DSH_SESSION_MESSENGER_NEG_MAX_ROUNDS = '4';
process.env.DSH_SESSION_MESSENGER_NEG_RATE_MS = '50';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.DSH_APP_DIR || '/Applications/DSH NEXT.app/Contents/Resources/app';
const PLUGIN = process.argv[2] || path.join(HERE, 'index.js');
const DATA_DIR = path.join(HERE, '.probe-neg-state');
const WORKSPACE = '/tmp/messenger-neg-ws';

const uncaught = [];
process.on('uncaughtException', (error) => {
  uncaught.push(error);
  console.log('UNCAUGHT ->', (error && error.message) || error);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await fs.rm(DATA_DIR, { recursive: true, force: true });

const { Context } = await import(pathToFileURL(path.join(APP, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href);

const registered = [];
const prompts = []; // {sessionId, mode, text}
const pluginLogs = [];
const app = new Context();
app.provide('tools', { register: (definition) => (registered.push(definition), () => {}) });
app.provide('logger', {
  info: (...args) => pluginLogs.push(['info', args.join(' ')]),
  warn: (...args) => pluginLogs.push(['warn', args.join(' ')])
});

const LIVE = ['session-A', 'session-B']; // session-C 故意不在活跃列表（孤儿场景）
await app.plugin({
  name: 'fake-services',
  apply(ctx) {
    ctx.provide('sessions', {
      list: () => LIVE.map((id) => ({ id, header: { id, cwd: WORKSPACE } })),
      get: (id) => (LIVE.includes(id) ? { header: { id, cwd: WORKSPACE } } : undefined)
    });
    ctx.provide('sessionController', {
      prompt: async (request) => {
        prompts.push({ sessionId: request.sessionId, mode: request.mode, text: request.content?.[0]?.text || '' });
        return { ok: true };
      }
    });
  }
});

const plugin = await import(pathToFileURL(path.resolve(PLUGIN)).href);
await app.plugin(plugin, { dataDir: DATA_DIR });
await sleep(900); // 等激活（inject 主路径即时）

if (registered.length !== 4) {
  console.log('ACTIVATION INCOMPLETE — registered:', JSON.stringify(registered.map((d) => d.name)));
  console.log('plugin logs:', JSON.stringify(pluginLogs, null, 2));
  await app.stop?.();
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  process.exit(1);
}
console.log('plugin logs:', JSON.stringify(pluginLogs.map((l) => l[1])));

const tool = (name) => registered.find((d) => d.name === name);
const fakeExec = (sessionId) => ({ agent: { id: sessionId, session: { header: { id: sessionId, cwd: WORKSPACE } } } });
const callTool = (name, args, sessionId) => tool(name).execute(args, fakeExec(sessionId));
const readJson = async (file) => JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
const claimsOf = async (p) => (await readJson('claims.json')).claims.filter((c) => c.path === p);
const negsOf = async (p) => (await readJson('negotiations.json')).negotiations.filter((n) => n.path === p);
const promptsTo = (sessionId, needle) => prompts.filter((x) => x.sessionId === sessionId && x.text.includes(needle));
const negIdFromPrompts = () => {
  const hit = prompts.map((x) => /^neg: (\w+)$/m.exec(x.text)).find(Boolean);
  return hit ? hit[1] : '';
};

let seq = 0;
async function emitWriteIntent(sessionId, absPath) {
  seq += 1;
  await app.plugin({
    name: `emit-${seq}`,
    async apply(ctx) {
      await ctx.waterfall('fs/write-intent', { targetKey: absPath, displayPath: absPath }, fakeExec(sessionId), () => undefined);
    }
  });
}

const checks = [];
const check = (label, ok, extra = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  [' + extra + ']' : ''}`);
};

// ---------------------------------------------------------------- A/B: 多轮 + 定时释放
const P1 = `${WORKSPACE}/src/share.ts`;
await callTool('claim_files', { paths: [P1], ttl_seconds: 300, note: 'A holds' }, 'session-A');
prompts.length = 0;
await emitWriteIntent('session-B', P1);
await sleep(250);
check('A1 冲突后双方收到 negotiate 消息', promptsTo('session-A', 'negotiate').length >= 1 && promptsTo('session-B', 'negotiate').length >= 1);
check('A2 持有方通知用 steer 插话', prompts.some((x) => x.sessionId === 'session-A' && x.mode === 'steer'));
const neg1 = negIdFromPrompts();
check('A3 协商已开桌并落盘', /^[0-9a-f]{8}$/.test(neg1) && (await negsOf(P1)).length === 1, neg1);
check('A4 写入方未抢注 claim（all-or-nothing）', (await claimsOf(P1)).length === 1 && (await claimsOf(P1))[0].sessionId === 'session-A');

// A5 可见性回归：模型只看得到 render 文本，status 回执必须自带 neg id / lastOffer / deadline
// （真机验收实测缺陷：信息只在 detail 字段里，模型看到的是空壳一行 "state=open round=0"）。
const statusRes = await callTool('negotiate', { action: 'status', path: P1 }, 'session-A');
const statusRender = tool('negotiate').output.render({ action: 'status' }, statusRes)[0].text;
check(
  'A5 status 可见性：render 带 neg id / lastOffer / deadline',
  statusRender.includes(neg1) && /lastOffer=/.test(statusRender) && /deadline=/.test(statusRender),
  statusRender.slice(0, 120)
);

const badOffer = await callTool('negotiate', { action: 'offer', corr: neg1, path: P1, terms: { action: 'release-now' } }, 'session-B');
check('E1 写入方无权提 release-*（权限边界）', badOffer.ok === false && /only the current claim holder/.test(badOffer.detail));

await sleep(150); // 真实节奏：每次意图之间留出秒级间隔（限速窗口 50ms）
const at1 = new Date(Date.now() + 1500).toISOString();
const offer = await callTool('negotiate', { action: 'offer', corr: neg1, path: P1, terms: { action: 'release-at', at: at1 } }, 'session-A');
check('B1 持有方 offer release-at 被接受', offer.ok === true && offer.rounds === 1, offer.detail);
await sleep(150);
const accept = await callTool('negotiate', { action: 'accept', corr: neg1, path: P1 }, 'session-B');
check('B2 写入方 accept → 协商 accepted 且排定释放', accept.ok === true && accept.state === 'accepted', accept.detail);
check('B3 释放尚未执行（等到点）', (await claimsOf(P1)).length === 1);
await sleep(2600);
check('B4 到点由看门狗执行释放（claim 消失）', (await claimsOf(P1)).length === 0);
check('B5 释放后双方收到终局通知', promptsTo('session-A', 'negotiate').length >= 2 && promptsTo('session-B', 'negotiate').length >= 2);

// ------------------------------------------------------- C: 沉默 → 超时升级（保守默认）
const P2 = `${WORKSPACE}/src/silent.ts`;
await callTool('claim_files', { paths: [P2], ttl_seconds: 300, note: 'A holds P2' }, 'session-A');
await emitWriteIntent('session-B', P2);
await sleep(300);
check('C1 第二个冲突独立开桌', (await negsOf(P2)).length === 1);
await sleep(2200); // 超过 deadline(1200ms) + 看门狗周期
const neg2 = (await negsOf(P2))[0];
check('C2 无人响应 → 升级 escalated', neg2 && neg2.state === 'escalated', neg2 && neg2.resolution);
check('C3 保守默认：占用方 claim 保留（绝不自动判给写入方）', (await claimsOf(P2)).length === 1);
check('C4 升级消息送达双方', prompts.some((x) => x.sessionId === 'session-A' && x.text.includes('escalated')) && prompts.some((x) => x.sessionId === 'session-B' && x.text.includes('escalated')));

// ------------------------------------------------------------- D: 孤儿 claim 立即清理
const P3 = `${WORKSPACE}/src/orphan.ts`;
await callTool('claim_files', { paths: [P3], ttl_seconds: 300, note: 'C (dead) holds' }, 'session-C');
prompts.length = 0;
await emitWriteIntent('session-B', P3);
await sleep(300);
check('D1 孤儿 claim 被立即清除（不等 TTL）', (await claimsOf(P3)).length === 0);
check('D2 写入方收到 claim-cleared 通知', promptsTo('session-B', 'claim-cleared').length >= 1);
check('D3 孤儿场景不再开协商桌', (await negsOf(P3)).length === 0);

const nameList = registered.map((d) => d.name);
console.log('\nregistered tools:', JSON.stringify(nameList));
console.log('uncaught exceptions:', uncaught.length);
await app.stop?.();
await fs.rm(DATA_DIR, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
const ok = failed.length === 0 && uncaught.length === 0 && nameList.length === 4;
console.log(ok ? 'PROBE PASS' : `PROBE FAIL (${failed.length} checks failed)`);
process.exit(ok ? 0 : 1);
