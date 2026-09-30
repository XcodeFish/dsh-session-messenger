/**
 * cordis 装载探针 —— 在 DSH 自带的真实 cordis 上加载本插件，验证激活与「不致命」。
 *
 * 为什么要这个探针（而不是肉眼 review）：
 * 1. cordis 的两套服务可见性不同，最容易写错：
 *    - `ctx.sessions` 属性访问：沿**祖先 fiber** 的 store 查找。`sessions` 由兄弟 fiber
 *      `@deepseek-ai/dsh-session` 提供，对本插件不可见，走到 root fiber 抛
 *      `cannot get property "sessions" without inject`。
 *    - `ctx.inject(['sessions', ...], cb)`：走 ReflectService 的**全局** store，可见。
 *    所以探针必须让假服务由**兄弟插件 fiber** 提供，`app.provide(...)`（root 提供）会
 *    掩盖这个差异 —— 用 root 提供的假 harness 会对 buggy 版本误判为 PASS。
 * 2. 插件 `setTimeout` 里抛出的异常 = 宿主进程级 uncaughtException =
 *    `dsh desktop host exited with 1` = 桌面端进恢复模式。探针把任何 uncaught 记为失败。
 *
 * 用法：
 *   node probe-cordis-load.mjs              # 服务齐全：期望注册 3 个工具、0 uncaught
 *   SKIP_PROVIDER=1 node probe-cordis-load.mjs   # 服务缺失：期望保持惰性、0 uncaught
 *
 * 环境变量：
 *   DSH_APP_DIR  DSH 安装目录（默认 /Applications/DSH NEXT.app/Contents/Resources/app）
 *   SKIP_PROVIDER=1  不注册假服务，验证「服务缺失时保持惰性且不崩」
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.DSH_APP_DIR || '/Applications/DSH NEXT.app/Contents/Resources/app';
const PLUGIN = process.argv[2] || path.join(HERE, 'index.js');

const uncaught = [];
process.on('uncaughtException', (error) => {
  uncaught.push(error);
  console.log('UNCAUGHT ->', (error && error.message) || error);
});

const { Context } = await import(
  pathToFileURL(path.join(APP, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href
);

const registered = [];
const app = new Context();

// tools 由 root 提供（等价于 base 的 tools 服务，属性直取本来就可见）。
app.provide('tools', {
  register: (definition) => {
    registered.push(definition);
    return () => {};
  }
});

// sessions / sessionController 必须由兄弟 fiber 提供，才能还原生产的可见性。
const provider = {
  name: 'session-services-provider',
  apply(ctx) {
    ctx.provide('sessions', { list: () => [] });
    ctx.provide('sessionController', { prompt: async () => ({ ok: true }) });
  }
};
if (process.env.SKIP_PROVIDER) {
  console.log('(SKIP_PROVIDER：sessions/sessionController 缺席，模拟未装这两个服务的 profile)');
} else {
  await app.plugin(provider);
}

const plugin = await import(pathToFileURL(path.resolve(PLUGIN)).href);
await app.plugin(plugin, { dataDir: path.join(process.cwd(), '.probe-claims') });

// 覆盖 SERVICE_FALLBACK_MS(3000) 并留余量。
await new Promise((resolve) => setTimeout(resolve, 3600));

const names = registered.map((d) => d.name);
console.log('plugin under test:', path.resolve(PLUGIN));
console.log('registered tools:', JSON.stringify(names));
console.log('uncaught exceptions:', uncaught.length);

await app.stop?.();

const expectTools = !process.env.SKIP_PROVIDER;
const ok = uncaught.length === 0 && (expectTools ? names.length === 4 : true);
console.log(ok ? 'PROBE PASS' : 'PROBE FAIL');
process.exit(ok ? 0 : 1);
