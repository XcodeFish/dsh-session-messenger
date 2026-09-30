/**
 * 写入守卫（H1 + M1）：用宿主 ctx.tools.guard()（同步、单调、与注册顺序无关）拦截写入，
 * 取代原先返回非契约形状 {action:'deny'} 的 tools/pre-execute 全局闸门。
 *
 * 冻结策略（最小误伤面）：
 * - 默认模式 'dispute'：只冻结「争议中」的单个路径——存在 open 协商，或冷静期内 escalated 的协商；
 *   持有方本人永不被冻结。未发生争议的普通 claim 不拦（第一次撞册仍是 写入+开协商桌）。
 * - 'claims'：额外冻结他人的手动 claim（origin=manual）——更强，适合明确要求「先谈后改」的团队。
 * - 'off'：不拦。
 * - 自动 claim（origin=auto）永不作为拦截依据：写过一次就锁住别人 = 误伤。v0.4.1 起由
 *   registry 保证协商只对手动 claim 开桌，这里再以 holdsManual 兜底（旧版遗留的协商记录也不生效）。
 *
 * 覆盖面：write / edit / str_replace_editor（create/str_replace/insert）。
 * 路径解析：相对路径按调用会话 cwd 解析，统一 realpath 身份键比对（与宿主 targetKey 同算法），
 * 符号链接无法绕过。bash 子进程直写不经文件服务，仍是已知盲区（README 已声明）。
 */
import { callerInfo, pathKey, toAbsolute, iso, sameFamily } from './util.js';

const WRITE_TOOLS = new Set(['write', 'edit']);
const SRE_MUTATING = new Set(['create', 'str_replace', 'insert']);

/** 从一次工具调用里取出将被写入的绝对路径与调用方；非写入调用返回 undefined。 */
export function writeTargetOf(exec) {
  if (!exec || typeof exec.name !== 'string') return undefined;
  const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
  let raw = '';
  if (WRITE_TOOLS.has(exec.name)) raw = args.file_path;
  else if (exec.name === 'str_replace_editor' && SRE_MUTATING.has(args.command)) raw = args.path;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  let caller;
  try {
    caller = callerInfo(exec);
  } catch {
    return undefined; // 无 agent 上下文的调用不归属任何会话，不拦
  }
  const abs = toAbsolute(raw, caller.cwd);
  return abs ? { abs, caller } : undefined;
}

export function createWriteGuard({ registry, negotiations, mode, metrics, logger, onDeny }) {
  return (exec) => {
    try {
      if (mode === 'off') return undefined;
      const target = writeTargetOf(exec);
      if (!target) return undefined;
      const { abs, caller } = target;
      const callerId = caller.sessionId;
      const key = pathKey(abs);
      const now = Date.now();
      // 只有持有方仍持有**手动** claim 时争议才冻结写入：自动 claim 只是「最近写过」，不是占用声明。
      const holderHolds = (holderId, k) => registry.holdsManual(holderId, k, now);
      const found = negotiations ? negotiations.frozenFor(key, callerId, now, holderHolds) : undefined;
      const neg = found && !sameFamily(callerId, caller.parent, found.holder, (registry.own(found.holder, key) || {}).parent) ? found : undefined;
      if (neg) {
        metrics.denies += 1;
        if (onDeny) onDeny();
        const holder = (neg.labels && neg.labels[neg.holder]) || neg.holder;
        return `"${abs}" is FROZEN while a claim dispute is ${neg.state} (neg ${neg.id}, holder ${holder}). Do not write it now: reply with negotiate({action:"status", path:"${abs}"}) to see the terms, or work on other files. The freeze lifts when the holder releases or the negotiation is accepted.`;
      }
      if (mode === 'claims') {
        const hit = registry.othersOn(key, callerId, now, caller.parent).find((c) => c.origin === 'manual');
        if (hit) {
          metrics.denies += 1;
          if (onDeny) onDeny();
          return `"${abs}" is claimed by ${hit.label} (session ${hit.sessionId}, until ${iso(hit.expiresAt)}, note: ${hit.note || 'n/a'}). Negotiate first: negotiate({action:"offer", path:"${abs}", terms:{action:"wait-until", at:"<ISO within 60m>"}}), or work on other files.`;
        }
      }
      return undefined;
    } catch (error) {
      // 守卫绝不能因自身缺陷拦截或打断宿主：任何异常一律放行并记录。
      logger?.warn?.(`[session-messenger] write guard failed (allowing): ${(error && error.message) || error}`);
      return undefined;
    }
  };
}

export function guardMode(config) {
  const env = process.env.DSH_SESSION_MESSENGER_GUARD;
  const legacy = process.env.DSH_SESSION_MESSENGER_HARD_GATE;
  const pick = env || (config && typeof config.guard === 'string' ? config.guard : '') || (legacy === '1' ? 'claims' : legacy === '0' ? 'off' : '');
  return pick === 'off' || pick === 'claims' || pick === 'dispute' ? pick : 'dispute';
}
