/**
 * 四个 agent 工具的定义（裸定义对象 + 生成的 JSON Schema，零外部导入）。
 * 所有 execute 永不抛出：错误以结构化结果返回；render 把模型需要的信息全部带出
 * （模型只看得到 render 文本，detail 字段本身不进上下文——v0.3.1 真机验收教训）。
 */
import { randomUUID } from 'node:crypto';
import * as S from './schemas.generated.js';
import { callerInfo, iso, labelFor, normalizePaths, oneLine, shortId } from './util.js';
import { Delivery, isDirectory } from './delivery.js';

const MAX_PATHS = 50;
const MAX_CONTENT_CHARS = 20000;
const DEFAULT_TTL_SECONDS = 1800;

function clampTtl(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(Math.round(n), 30), 86400);
}

export function buildTools({ registry, negotiations, delivery, coordinator, metrics }) {
  const notReady = () => !registry.ready || (negotiations && !negotiations.ready);
  const NOT_READY = 'session-messenger is still loading its state; retry in a moment';

  const claimFiles = {
    name: 'claim_files',
    description:
      'Register a claim on files you are about to modify so other live DSH sessions in this workspace can see it before editing. All-or-nothing: when another session already holds a live claim on ANY requested path, nothing is registered and the conflicts are returned (then use negotiate, or pick other files). Claims auto-expire after ttl_seconds (default 1800). Writes also auto-register short claims, but only a manual claim declares intent early and survives your own writes. Run release_files when done.',
    parameters: S.CLAIM_FILES_PARAMETERS,
    output: {
      schema: S.CLAIM_FILES_OUTPUT,
      render: (_args, v) => {
        if (!v.ok) return [{ type: 'text', text: `claim_files failed: ${v.hint}` }];
        if (!v.registered) {
          const rows = v.conflicts.map((c) => `- ${c.path} ← ${c.ownerLabel} (session ${c.ownerSessionId}, ${c.ownerOrigin}, until ${iso(c.expiresAt)}, note: ${c.note || 'n/a'})`);
          return [{ type: 'text', text: `CONFLICT: nothing registered.\n${rows.join('\n')}\n${v.hint}` }];
        }
        return [{ type: 'text', text: v.hint }];
      }
    },
    execute: async (args, exec) => {
      const now = Date.now();
      const fail = (sessionId, hint) => ({ ok: false, sessionId, registered: false, expiresAt: 0, conflicts: [], hint });
      try {
        const caller = callerInfo(exec, args && args.cwd);
        if (notReady()) return fail(caller.sessionId, NOT_READY);
        const rawPaths = Array.isArray(args && args.paths) ? args.paths : [];
        if (rawPaths.length === 0) return fail(caller.sessionId, 'paths must be a non-empty array');
        if (rawPaths.length > MAX_PATHS) return fail(caller.sessionId, `too many paths (${rawPaths.length}); split into chunks of at most ${MAX_PATHS}`);
        const { entries, unresolvable } = normalizePaths(rawPaths, caller.cwd);
        if (unresolvable.length > 0) {
          return fail(caller.sessionId, `cannot resolve relative path(s) without a cwd: ${unresolvable.slice(0, 5).join(', ')}; pass absolute paths or cwd`);
        }
        const dirs = entries.filter((e) => isDirectory(e.path)).map((e) => e.path);
        if (dirs.length > 0) return fail(caller.sessionId, `claims are per file; these are directories: ${dirs.slice(0, 5).join(', ')}`);
        const result = registry.claim({
          sessionId: caller.sessionId,
          parent: caller.parent,
          label: labelFor(caller.sessionId, caller.cwd),
          cwd: caller.cwd,
          sessionOrigin: caller.origin,
          entries,
          ttlSeconds: clampTtl(args && args.ttl_seconds),
          note: oneLine(args && args.note, 300),
          origin: 'manual',
          now
        });
        if (!result.registered) {
          return {
            ok: true,
            sessionId: caller.sessionId,
            registered: false,
            expiresAt: 0,
            conflicts: result.conflicts,
            hint: 'Do not edit these files now. Open a negotiation as the writer, e.g. negotiate({action:"offer", path:"<path>", terms:{action:"wait-until", at:"<ISO within 60m>"}}), or work on other files.'
          };
        }
        await coordinator.persistClaims();
        return {
          ok: true,
          sessionId: caller.sessionId,
          registered: true,
          expiresAt: result.expiresAt,
          conflicts: [],
          hint: `Claim registered for ${entries.length} path(s) until ${iso(result.expiresAt)}. Run release_files when done.`
        };
      } catch (error) {
        return fail('', String((error && error.message) || error));
      }
    }
  };

  const releaseFiles = {
    name: 'release_files',
    description: "Release file claims held by THIS session. Omit paths to release all of this session's claims.",
    parameters: S.RELEASE_FILES_PARAMETERS,
    output: {
      schema: S.RELEASE_FILES_OUTPUT,
      render: (_args, v) => [{ type: 'text', text: v.ok ? `Released ${v.released} claim(s). ${v.hint}` : `release_files failed: ${v.hint}` }]
    },
    execute: async (args, exec) => {
      try {
        const caller = callerInfo(exec, args && args.cwd);
        if (notReady()) return { ok: false, sessionId: caller.sessionId, released: 0, hint: NOT_READY };
        const hasPaths = Array.isArray(args && args.paths) && args.paths.length > 0;
        const { entries, unresolvable } = normalizePaths(hasPaths ? args.paths : [], caller.cwd);
        if (hasPaths && entries.length === 0) {
          return { ok: false, sessionId: caller.sessionId, released: 0, hint: `no resolvable paths: ${unresolvable.slice(0, 5).join(', ')}` };
        }
        const released = registry.release(caller.sessionId, hasPaths ? entries.map((e) => e.key) : null);
        if (released > 0) await coordinator.persistClaims();
        return { ok: true, sessionId: caller.sessionId, released, hint: released > 0 ? 'Open negotiations on these paths resolve at the next watchdog tick.' : 'no matching claims' };
      } catch (error) {
        return { ok: false, sessionId: '', released: 0, hint: String((error && error.message) || error) };
      }
    }
  };

  const sendToSession = {
    name: 'send_to_session',
    description:
      "Send a message to ANOTHER live DSH session working in the same workspace. It arrives as a peer message (not a user instruction) in the target's chat. mode 'queue' (default) waits for the target's current turn to end; 'steer' inserts it into the target's current step. Either mode starts a turn when the target is idle, so send only when you need a reply. Rate limited. Use negotiate (not this tool) to settle a claim conflict.",
    parameters: S.SEND_TO_SESSION_PARAMETERS,
    output: {
      schema: S.SEND_TO_SESSION_OUTPUT,
      render: (_args, v) => [
        { type: 'text', text: v.ok ? `Message ${v.mode === 'steer' ? 'steered into' : 'queued into'} session ${v.target} (${v.detail}).` : `send_to_session failed: ${v.detail}` }
      ]
    },
    execute: async (args, exec) => {
      const mode = args && args.mode === 'steer' ? 'steer' : 'queue';
      const rawTarget = String((args && args.target) || '').trim();
      const respond = (ok, target, delivered, detail) => ({ ok, target, mode, delivered, detail });
      try {
        const caller = callerInfo(exec);
        const content = String((args && args.content) || '').trim();
        if (!rawTarget) return respond(false, '', false, 'target is required');
        if (!content) return respond(false, rawTarget, false, 'content is required');
        if (content.length > MAX_CONTENT_CHARS) return respond(false, rawTarget, false, `content too long (${content.length} > ${MAX_CONTENT_CHARS} chars)`);
        const live = delivery.liveSessions();
        let match = live.find((s) => s.id === rawTarget);
        if (!match && rawTarget.length >= 4) {
          const prefixed = live.filter((s) => s.id.startsWith(rawTarget) || s.id.replace(/^session-/, '').startsWith(rawTarget));
          if (prefixed.length > 1) {
            return respond(false, rawTarget, false, `ambiguous id prefix; candidates: ${JSON.stringify(delivery.candidates(caller.sessionId, caller.cwd).filter((c) => prefixed.some((p) => p.id === c.sessionId)))}`);
          }
          match = prefixed[0];
        }
        if (!match || !delivery.reachable(caller.cwd, match.cwd)) {
          return respond(false, rawTarget, false, `no reachable live session matches "${rawTarget}". Reachable sessions: ${JSON.stringify(delivery.candidates(caller.sessionId, caller.cwd))}`);
        }
        if (match.id === caller.sessionId) return respond(false, match.id, false, 'target resolves to the calling session; self-send is a no-op');
        const limited = delivery.checkRate(caller.sessionId, match.id);
        if (limited) return respond(false, match.id, false, limited);
        const corr = randomUUID().slice(0, 8);
        const text = Delivery.manualEnvelope({ fromId: caller.sessionId, fromCwd: caller.cwd, corr, topic: args && args.topic, mode, content });
        await delivery.prompt(match.id, mode, text, exec && exec.signal);
        return respond(true, match.id, true, `corr=${corr}; the target replies via its own send_to_session`);
      } catch (error) {
        return respond(false, rawTarget, false, String((error && error.message) || error));
      }
    }
  };

  const negotiate = {
    name: 'negotiate',
    description:
      "Settle a file-claim conflict with another session through structured, multi-round offers. While a negotiation is open the writer's writes to that file are frozen. 'offer'/'counter' propose terms (only the current claim HOLDER may offer release-now / release-at; the WRITER may offer wait-until); 'accept' accepts the peer's pending offer and the plugin executes it; 'decline' ends it; 'escalate' asks for human arbitration; 'status' shows the negotiations on a path. Silence is NOT consent: without a reply before the deadline it escalates to the user and the holder keeps the claim.",
    parameters: S.NEGOTIATE_PARAMETERS,
    output: {
      schema: S.NEGOTIATE_OUTPUT,
      render: (_args, v) => [
        { type: 'text', text: `negotiate ${v.ok ? 'ok' : 'rejected'}${v.negId ? ` [neg ${v.negId}]` : ''}: ${v.detail}` }
      ]
    },
    execute: async (args, exec) => {
      const now = Date.now();
      const respond = (ok, neg, released, detail) => ({
        ok,
        negId: neg ? neg.id : '',
        path: neg ? neg.path : String((args && args.path) || ''),
        state: neg ? neg.state : '',
        rounds: neg ? neg.rounds : 0,
        deadline: neg ? neg.deadline : 0,
        released: !!released,
        detail
      });
      if (!negotiations) return respond(false, null, false, 'negotiation layer is disabled (env DSH_SESSION_MESSENGER_NEGOTIATE=0)');
      try {
        const caller = callerInfo(exec);
        if (notReady()) return respond(false, null, false, NOT_READY);
        const action = String((args && args.action) || '').trim();
        const { entries } = normalizePaths([args && args.path], caller.cwd);
        const entry = entries[0];
        if (!entry) return respond(false, null, false, 'path could not be resolved to an absolute path');

        if (action === 'status') return respond(true, null, false, statusDetail(caller, entry, now));

        let neg;
        const corr = String((args && args.corr) || '').trim();
        if (corr) {
          neg = negotiations.byId(corr);
          if (!neg) return respond(false, null, false, `unknown corr "${corr}"`);
          if (neg.key !== entry.key) return respond(false, neg, false, `corr ${neg.id} belongs to ${neg.path}, not ${entry.path}`);
        } else {
          const open = negotiations.openForSession(caller.sessionId).filter((n) => n.key === entry.key);
          if (open.length > 1) return respond(false, null, false, `multiple open negotiations for this path; pass corr (${open.map((n) => n.id).join(', ')})`);
          neg = open[0];
        }
        if (!neg && (action === 'offer' || action === 'counter')) {
          const holder = registry.othersOn(entry.key, caller.sessionId, now, caller.parent)[0];
          if (!holder) return respond(false, null, false, `no live claim by another session on ${entry.path}; nothing to negotiate (claim_files it yourself)`);
          neg = coordinator.openNegotiation(entry, holder.sessionId, holder.label, caller.sessionId, labelFor(caller.sessionId, caller.cwd), now).neg;
          if (!neg) return respond(false, null, false, 'could not open a negotiation');
          // 不在此处单独通知持有方：下面的 offer 转移会带着条款通知一次，避免重复打扰。
        }
        if (!neg) return respond(false, null, false, `no open negotiation for ${entry.path}; use status, or wait for a conflict notice`);
        if (neg.a !== caller.sessionId && neg.b !== caller.sessionId) return respond(false, neg, false, 'you are not a party of this negotiation');

        const waitMs = negotiations.rateLimited(neg.id, caller.sessionId, now);
        if (waitMs > 0) return respond(false, neg, false, `rate limited: one intent per ${negotiations.rateMs}ms per party; retry in ${Math.ceil(waitMs / 1000)}s`);
        const result = negotiations.transition(neg, { by: caller.sessionId, action, terms: args && args.terms, message: args && args.message, now });
        if (!result.ok) {
          negotiations.refundRate(neg.id, caller.sessionId);
          return respond(false, neg, false, result.reason || 'transition rejected');
        }
        const effects = result.effects || {};
        const released = coordinator.applyEffects(neg, effects, now);
        coordinator.persistNegotiations();
        if (effects.notifyPeer) coordinator.notifyNegotiation(neg, effects.notifyPeer);
        return respond(true, neg, released, summaryOf(neg, released));
      } catch (error) {
        return respond(false, null, false, String((error && error.message) || error));
      }
    }
  };

  const summaryOf = (neg, released) => {
    const offer = neg.lastOffer && neg.lastOffer.terms ? ` lastOffer=${neg.lastOffer.terms.action}${neg.lastOffer.terms.at ? '@' + iso(neg.lastOffer.terms.at) : ''} by ${shortId(neg.lastOffer.by)}` : '';
    const pending = neg.pendingReleaseAt ? ` scheduled-release=${iso(neg.pendingReleaseAt)}` : neg.pendingWakeAt ? ` writer-wake=${iso(neg.pendingWakeAt)}` : '';
    return `state=${neg.state} round=${neg.rounds}/${negotiations.maxRounds}${neg.resolution ? ` (${neg.resolution})` : ''}${offer}${released ? ' holder-claim-released' : ''}${pending} deadline=${iso(neg.deadline)}`;
  };

  const statusDetail = (caller, entry, now) => {
    const mine = [...negotiations.negotiations.values()].filter((n) => n.key === entry.key && (n.a === caller.sessionId || n.b === caller.sessionId));
    const rows = mine
      .sort((x, y) => y.updatedAt - x.updatedAt)
      .slice(0, 5)
      .map((n) => {
        const peer = n.a === caller.sessionId ? n.b : n.a;
        const you = caller.sessionId === n.holder ? 'holder' : 'writer';
        return `${n.id} you=${you} peer=${(n.labels && n.labels[peer]) || shortId(peer)} (session ${peer}) ${summaryOf(n, false)}`;
      });
    const others = registry.othersOn(entry.key, caller.sessionId, now, caller.parent);
    const claimLine = others.length
      ? `live claims by others: ${others.map((c) => `${c.label} (session ${c.sessionId}, ${c.origin}, until ${iso(c.expiresAt)})`).join('; ')}`
      : 'no live claim by another session';
    return `${rows.length ? rows.join(' | ') : 'no negotiation on this path involving you'}; ${claimLine}`;
  };

  void metrics;
  return [claimFiles, releaseFiles, sendToSession, negotiate];
}
