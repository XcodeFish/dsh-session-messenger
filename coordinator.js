/**
 * 协调核心：写入意图观测（L0 自动登记）→ 冲突处理（孤儿清理 / 开协商桌 / 通知）→ 看门狗。
 *
 * 审查修复：
 * - H2：自动登记走 registry.claim(origin:'auto')，只延长不降级手动 claim。
 * - H3：孤儿清理只针对「可证明已销毁」的会话——子代理会话（宿主 subagent 路由所有）在
 *   session/disposed 时清理；持久会话不在内存 ≠ 已死（可冷恢复），一律只靠 TTL / 协商 / 人工。
 *   冲突时若持有方是不在内存的子代理，也视为已销毁（子代理不可冷恢复被外部驱动）。
 * - L3：同 (path, pair) 终态协商冷静期内不重开桌、不重复通知。
 * - L4：只登记会话工作区根（含 git 根）内的写入，/tmp、~/.dsh 等工具性写入不进台账。
 * - 自动通知不唤醒空闲/冷会话（M5，见 delivery.notify）。
 * - v0.4.1：只有他人的**手动** claim 才构成冲突（开协商 + 争议冻结）；他人的自动 claim
 *   只是「最近写过」，写入照常登记，只给写入方一条节流的重叠提示。
 */
import { randomUUID } from 'node:crypto';
import { ENVELOPE_TAG, createThrottle, intentInfo, isWithin, iso, labelFor, shortId } from './util.js';
import { PEER_NOTICE, workspaceRoot } from './delivery.js';

export function createCoordinator({ registry, negotiations, delivery, logger, metrics, settings }) {
  const recentIntents = new Map();
  const isDuplicateIntent = (key) => {
    const now = Date.now();
    const last = recentIntents.get(key) || 0;
    if (now - last < 1000) return true;
    recentIntents.set(key, now);
    if (recentIntents.size > 512) {
      for (const [k, at] of recentIntents) if (now - at >= 1000) recentIntents.delete(k);
    }
    return false;
  };

  const persistClaims = () =>
    registry.persist().catch((error) => logger?.warn?.(`[session-messenger] claims persist failed: ${(error && error.message) || error}`));
  const persistNegotiations = () => {
    if (!negotiations) return;
    negotiations.persist().catch((error) => logger?.warn?.(`[session-messenger] negotiations persist failed: ${(error && error.message) || error}`));
  };

  // ------------------------------------------------------------------ 渲染
  const labelOf = (neg, id) => (neg.labels && neg.labels[id]) || shortId(id);
  const offerLine = (neg) => {
    const o = neg.lastOffer;
    if (!o || !o.terms) return 'none';
    return `${o.terms.action}${o.terms.at ? '@' + iso(o.terms.at) : ''} by ${labelOf(neg, o.by)}${o.message ? ` — "${o.message.slice(0, 200)}"` : ''}`;
  };

  const renderNegotiation = (neg, forId) => {
    const peerId = forId === neg.a ? neg.b : neg.a;
    const you = forId === neg.holder ? 'holder' : forId === neg.writer ? 'writer' : 'party';
    const lines = [
      `${ENVELOPE_TAG} · negotiate]]`,
      `notice: ${PEER_NOTICE}`,
      `neg: ${neg.id}`,
      `path: ${neg.path}`,
      `you: ${you} (${labelOf(neg, forId)})`,
      `peer: ${labelOf(neg, peerId)} (session ${peerId})`,
      `state: ${neg.state}${neg.resolution ? ` — ${neg.resolution}` : ''}`,
      `round: ${neg.rounds}/${negotiations ? negotiations.maxRounds : '?'}`,
      `deadline: ${iso(neg.deadline)}`,
      `lastOffer: ${offerLine(neg)}`
    ];
    const call = (action, extra = '') => `  negotiate({action:"${action}", corr:"${neg.id}", path:${JSON.stringify(neg.path)}${extra}})`;
    const ask = [];
    if (neg.state === 'open') {
      const offer = neg.lastOffer;
      const mine = offer && offer.by === forId;
      if (you === 'holder' && (!offer || mine)) {
        ask.push('你是该文件的占用方，写入方的后续写入已被冻结。请给条件或明确拒绝：');
        ask.push(`${call('offer', ', terms:{action:"release-now"}')}  立即让出`);
        ask.push(`${call('offer', ', terms:{action:"release-at", at:"<ISO，60 分钟内>"}')}  约定时刻让出`);
        ask.push(`${call('decline')}  不让出（对方须退让或人工裁决）`);
      } else if (you === 'holder') {
        ask.push('写入方提出条件，你可以：');
        ask.push(`${call('accept')}  接受`);
        ask.push(`${call('counter', ', terms:{action:"release-at", at:"<ISO>"}')}  还价`);
        ask.push(`${call('decline')}  拒绝`);
      } else if (!offer || mine) {
        ask.push('你是写入方：该文件由占用方持有，在协商结束前你对它的写入会被拒绝。你可以：');
        ask.push(`${call('offer', ', terms:{action:"wait-until", at:"<ISO，60 分钟内>"}')}  承诺等到某刻再改`);
        ask.push(`${call('decline')}  放弃该文件，先做别的`);
      } else {
        ask.push('占用方提出条件，你可以：');
        ask.push(`${call('accept')}  接受`);
        ask.push(`${call('counter', ', terms:{action:"wait-until", at:"<ISO>"}')}  还价`);
        ask.push(`${call('decline')}  拒绝（请改别的文件）`);
      }
    } else if (neg.state === 'escalated') {
      ask.push('协商未收敛，已请求人工裁决。默认结论：占用方保留 claim（写入方在冷静期内对该文件的写入仍被冻结）。请向用户说明情况，或改做别的文件。');
    } else if (neg.state === 'accepted') {
      if (neg.pendingReleaseAt) ask.push(`已达成：占用方将在 ${iso(neg.pendingReleaseAt)} 自动释放，届时可直接写入。`);
      else if (neg.pendingWakeAt) ask.push(`已达成：写入方等待至 ${iso(neg.pendingWakeAt)}，到点会收到重试提醒。`);
      else ask.push('已达成：占用已释放，可继续。');
    } else {
      ask.push(`协商已结束（${neg.resolution || neg.state}）。`);
    }
    return [...lines, '', ...ask].join('\n');
  };

  const notifyNegotiation = (neg, sessionId) => {
    if (!sessionId) return;
    const outcome = delivery.notify(sessionId, renderNegotiation(neg, sessionId));
    metrics.notifies += 1;
    if (outcome === 'skipped-cold') metrics.notifySkippedCold += 1;
  };

  const autoEnvelope = (type, lines) =>
    [`${ENVELOPE_TAG} · auto]]`, `notice: ${PEER_NOTICE}`, `corr: ${randomUUID().slice(0, 8)}`, `type: ${type}`, ...lines].join('\n');

  // --------------------------------------------------------------- 协商动作
  const openNegotiation = (entry, holderId, holderLabel, writerId, writerLabel, now) => {
    if (!negotiations) return { neg: null, created: false };
    const res = negotiations.open({
      id: randomUUID().slice(0, 8),
      path: entry.path,
      key: entry.key,
      a: holderId,
      b: writerId,
      labels: { [holderId]: holderLabel, [writerId]: writerLabel },
      holder: holderId,
      writer: writerId,
      now
    });
    if (res.created) {
      metrics.negotiationsOpened += 1;
      persistNegotiations();
    }
    return res;
  };

  const releaseClaim = (sessionId, key) => {
    const count = registry.release(sessionId, [key]);
    if (count > 0) {
      metrics.releases += 1;
      persistClaims();
    }
    return count > 0;
  };

  /** 协商副作用执行（释放）。供 negotiate 工具与看门狗共用。 */
  const applyEffects = (neg, effects, now) => {
    if (effects && effects.releaseSessionId && effects.releaseAt && effects.releaseAt <= now) {
      return releaseClaim(effects.releaseSessionId, neg.key);
    }
    return false;
  };

  // ------------------------------------------------------------------ L0/L1
  const inScope = (info) => {
    if (!settings.scopeToWorkspace) return true;
    const root = workspaceRoot(info.cwd);
    return !!root && isWithin(info.absPath, root);
  };

  const handleWriteIntent = (kind, target, actor) => {
    const info = intentInfo(target, actor);
    if (!info || !info.sessionId) {
      metrics.unattributed += 1;
      return;
    }
    if (!inScope(info)) {
      metrics.outOfScope += 1;
      return;
    }
    if (isDuplicateIntent(`${kind}|${info.sessionId}|${info.key}`)) return;
    const writerId = info.sessionId;
    const writerCwd = info.cwd || delivery.sessionCwd(writerId);
    const writerLabel = labelFor(writerId, writerCwd);
    const entry = { path: info.absPath, key: info.key };
    const now = Date.now();
    const result = registry.claim({
      sessionId: writerId,
      parent: info.parent,
      label: writerLabel,
      cwd: writerCwd,
      sessionOrigin: info.origin,
      entries: [entry],
      ttlSeconds: settings.autoClaimTtlSeconds,
      note: `auto:${kind}`,
      origin: 'auto',
      now
    });
    if (result.registered) {
      metrics.autoClaims += 1;
      persistClaims();
      if (result.overlaps && result.overlaps.length > 0) notifyOverlap(entry, result.overlaps[0], writerId, writerLabel);
      return;
    }
    const conflict = result.conflicts[0];
    if (!conflict) return;
    metrics.conflicts += 1;
    significant();
    logger?.warn?.(
      `[session-messenger] CONFLICT(auto): ${writerLabel} writing ${entry.path} claimed by ${conflict.ownerLabel} (session ${conflict.ownerSessionId}, ${conflict.ownerOrigin})`
    );

    // H3：只有「可证明已销毁」的持有方才清理——子代理会话且已不在内存。
    const holderClaim = registry.own(conflict.ownerSessionId, entry.key);
    const holderIsSubagent = holderClaim && holderClaim.sessionOrigin === 'subagent';
    if (holderIsSubagent && !delivery.liveAgent(conflict.ownerSessionId) && !safeSessionLive(conflict.ownerSessionId)) {
      if (releaseClaim(conflict.ownerSessionId, entry.key)) {
        metrics.orphanCleared += 1;
        logger?.warn?.(`[session-messenger] orphan claim cleared: subagent ${conflict.ownerLabel} is disposed; ${entry.path} is free`);
        // 被清的是已销毁子代理的 claim：写入方本次写入已放行，补登记它的自动 claim。
        registry.claim({ sessionId: writerId, parent: info.parent, label: writerLabel, cwd: writerCwd, sessionOrigin: info.origin, entries: [entry], ttlSeconds: settings.autoClaimTtlSeconds, note: `auto:${kind}`, origin: 'auto', now });
        persistClaims();
        return;
      }
    }

    if (!settings.autoNotify) return;
    if (negotiations) {
      // L3：冷静期内对同一对不重开桌（沉默/拒绝后反复打扰持有方是这类协议的经典死法）。
      if (negotiations.recentTerminalForPair(entry.key, conflict.ownerSessionId, writerId, now)) {
        metrics.cooldownSuppressed += 1;
        return;
      }
      const { neg, created } = openNegotiation(entry, conflict.ownerSessionId, conflict.ownerLabel, writerId, writerLabel, now);
      if (neg && created) {
        notifyNegotiation(neg, neg.holder);
        notifyNegotiation(neg, neg.writer);
      }
      return;
    }
    // 协商层关闭时的降级：纯告警（同样不唤醒空闲/冷会话）。
    delivery.notify(
      conflict.ownerSessionId,
      autoEnvelope('conflict-alert', [
        `path: ${entry.path}`,
        `holder: ${conflict.ownerLabel} (session ${conflict.ownerSessionId}) — this is you`,
        `writer: ${writerLabel} (session ${writerId})`,
        '',
        `会话 ${writerLabel} 正在写入你占用的文件（claim note: ${conflict.note || 'n/a'}）。如需协调，请用 send_to_session 回复写入方。`
      ])
    );
    delivery.notify(
      writerId,
      autoEnvelope('conflict-alert', [
        `path: ${entry.path}`,
        `holder: ${conflict.ownerLabel} (session ${conflict.ownerSessionId})`,
        `writer: ${writerLabel} — this is you`,
        '',
        `你正在写入的文件已被会话 ${conflict.ownerLabel} claim（note: ${conflict.note || 'n/a'}，至 ${iso(conflict.expiresAt)}）。请先与对方协商，或调整改动范围。`
      ])
    );
    metrics.notifies += 2;
  };

  /**
   * 重叠提示（v0.4.1）：对方只是最近写过同一文件（自动 claim，无占用声明）。
   * 不开协商、不冻结，只给写入方一条低优先级提示，让它知道有人刚动过这个文件；
   * 每 (写入方, 路径, 对方) 冷却窗口内最多一次，且不唤醒空闲/冷会话（delivery.notify）。
   */
  const overlapThrottle = createThrottle();
  const significant = () => {
    try {
      if (typeof api.onSignificant === 'function') api.onSignificant();
    } catch {
      /* status is best-effort */
    }
  };
  const notifyOverlap = (entry, other, writerId, writerLabel) => {
    metrics.overlaps += 1;
    significant();
    if (!settings.autoNotify) return;
    if (!overlapThrottle(`${writerId}|${entry.key}|${other.ownerSessionId}`, settings.overlapCooldownMs)) return;
    delivery.notify(
      writerId,
      autoEnvelope('recent-edit', [
        `path: ${entry.path}`,
        `other: ${other.ownerLabel} (session ${other.ownerSessionId}) — edited it recently (no claim), until ${iso(other.expiresAt)}`,
        `writer: ${writerLabel} — this is you`,
        '',
        '提示：另一个会话最近改过这个文件（它没有声明占用，你的写入已正常完成、不会被拦）。如果你们可能在改同一处逻辑，可用 send_to_session 知会对方，或先 claim_files 声明意图。无需回复。'
      ])
    );
    metrics.notifies += 1;
  };

  const safeSessionLive = (sessionId) => {
    try {
      return delivery.liveSessions().some((s) => s.id === sessionId);
    } catch {
      return true; // 未知 = 视为存活，绝不据未知做删除
    }
  };

  /** H3：子代理会话被宿主销毁时，其 claim 与开放协商立即收尾。持久会话的 disposed 只是卸载，不清理。 */
  const handleSessionDisposed = (session) => {
    const header = (session && session.header) || {};
    const id = (session && session.id) || header.id;
    if (!id || !(header.origin === 'subagent' || header.parentSession !== undefined)) return;
    const count = registry.release(String(id), null);
    if (count > 0) {
      metrics.orphanCleared += count;
      persistClaims();
      logger?.info?.(`[session-messenger] subagent ${shortId(id)} disposed; released ${count} claim(s)`);
    }
    if (!negotiations) return;
    const now = Date.now();
    for (const neg of negotiations.openForSession(String(id))) {
      negotiations.mark(neg, 'resolved', `party ${labelOf(neg, id)} was disposed`, now);
      notifyNegotiation(neg, neg.a === id ? neg.b : neg.a);
    }
    persistNegotiations();
  };

  // ------------------------------------------------------------------ 看门狗
  const runWatchdogOnce = () => {
    if (!negotiations || !negotiations.ready || !registry.ready) return;
    const now = Date.now();
    try {
      const { escalate, dueReleases, dueWakes } = negotiations.scan(now);
      for (const neg of escalate) {
        metrics.escalations += 1;
        logger?.warn?.(`[session-messenger] negotiation ${neg.id} escalated (${neg.resolution}) on ${neg.path}`);
        notifyNegotiation(neg, neg.holder);
        notifyNegotiation(neg, neg.writer);
      }
      for (const neg of dueReleases) {
        releaseClaim(neg.holder, neg.key);
        logger?.info?.(`[session-messenger] negotiation ${neg.id} applied scheduled release for ${neg.path}`);
        notifyNegotiation(neg, neg.holder);
        notifyNegotiation(neg, neg.writer);
      }
      for (const neg of dueWakes) notifyNegotiation(neg, neg.writer);
      // 持有方已不再持有**手动** claim（释放/过期/只剩自动登记）的开放协商收敛为 resolved——冻结随之解除。
      const heldKeys = new Set(
        registry
          .listLive(now)
          .filter((c) => c.origin === 'manual')
          .map((c) => `${c.sessionId}\u0000${c.key}`)
      );
      let resolved = 0;
      for (const neg of negotiations.negotiations.values()) {
        if (neg.state !== 'open' || heldKeys.has(`${neg.holder}\u0000${neg.key}`)) continue;
        negotiations.mark(neg, 'resolved', 'holder no longer holds the claim; path is free', now);
        resolved += 1;
        notifyNegotiation(neg, neg.holder);
        notifyNegotiation(neg, neg.writer);
      }
      const removed = negotiations.prune(now, settings.negRetentionMs);
      if (escalate.length || dueReleases.length || dueWakes.length || resolved || removed) persistNegotiations();
    } catch (error) {
      logger?.warn?.(`[session-messenger] watchdog failed: ${(error && error.message) || error}`);
    }
  };

  const api = { handleWriteIntent, handleSessionDisposed, runWatchdogOnce, renderNegotiation, notifyNegotiation, openNegotiation, applyEffects, persistClaims, persistNegotiations, onSignificant: undefined, statusText: undefined };
  return api;
}
