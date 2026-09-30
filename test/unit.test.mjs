// 纯逻辑单元测试（L9）：node --test test/
// 不依赖宿主安装；覆盖 registry / negotiation / util / storage / write-guard 的边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaimRegistry } from '../registry.js';
import { NegotiationStore } from '../negotiation.js';
import { acquireDataDir, JsonFile } from '../storage.js';
import { createThrottle, createWindowLimiter, neutralizeEnvelope, oneLine, pathKey, sameFamily, toAbsolute, isLegacyLabel, originOfHeader } from '../util.js';
import { createWriteGuard, guardMode } from '../write-guard.js';
import { createCoordinator } from '../coordinator.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'msgr-unit-'));
const E = (p) => ({ path: p, key: pathKey(p) });
const T0 = Date.parse('2026-09-30T03:00:00Z');

test('registry: auto claim never downgrades a manual claim (H2)', () => {
  const r = new ClaimRegistry({ dataDir: tmp() });
  r.ready = true;
  const m = r.claim({ sessionId: 'A', entries: [E('/w/a.ts')], ttlSeconds: 1800, note: 'refactor', origin: 'manual', now: T0 });
  r.claim({ sessionId: 'A', entries: [E('/w/a.ts')], ttlSeconds: 600, note: 'auto:write', origin: 'auto', now: T0 + 1000 });
  const c = r.own('A', pathKey('/w/a.ts'));
  assert.equal(c.expiresAt, m.expiresAt);
  assert.equal(c.note, 'refactor');
  assert.equal(c.origin, 'manual');
});

test('registry: auto claim extends an older auto claim', () => {
  const r = new ClaimRegistry({ dataDir: tmp() });
  r.claim({ sessionId: 'A', entries: [E('/w/a.ts')], ttlSeconds: 600, origin: 'auto', note: 'auto:write', now: T0 });
  r.claim({ sessionId: 'A', entries: [E('/w/a.ts')], ttlSeconds: 600, origin: 'auto', note: 'auto:edit', now: T0 + 300000 });
  assert.equal(r.own('A', pathKey('/w/a.ts')).expiresAt, T0 + 900000);
});

test('registry: manual re-claim upgrades auto and keeps claimedAt', () => {
  const r = new ClaimRegistry({ dataDir: tmp() });
  r.claim({ sessionId: 'A', entries: [E('/w/a.ts')], ttlSeconds: 600, origin: 'auto', note: 'auto:write', now: T0 });
  r.claim({ sessionId: 'A', entries: [E('/w/a.ts')], ttlSeconds: 60, origin: 'manual', note: 'mine', now: T0 + 5 });
  const c = r.own('A', pathKey('/w/a.ts'));
  assert.equal(c.origin, 'manual');
  assert.equal(c.claimedAt, T0);
  assert.equal(c.note, 'mine');
});

test('registry: all-or-nothing and family exemption', () => {
  const r = new ClaimRegistry({ dataDir: tmp() });
  r.claim({ sessionId: 'P', entries: [E('/w/a.ts')], ttlSeconds: 60, origin: 'manual', now: T0 });
  const x = r.claim({ sessionId: 'B', entries: [E('/w/b.ts'), E('/w/a.ts')], ttlSeconds: 60, origin: 'manual', now: T0 });
  assert.equal(x.registered, false);
  assert.equal(r.own('B', pathKey('/w/b.ts')), undefined, 'nothing registered on conflict');
  const child = r.claim({ sessionId: 'C', parent: 'P', entries: [E('/w/a.ts')], ttlSeconds: 60, origin: 'auto', now: T0 });
  assert.equal(child.registered, true, 'child of holder is not a conflict');
});

test('registry: another session\'s AUTO claim is an overlap, not a conflict (v0.4.1)', () => {
  const r = new ClaimRegistry({ dataDir: tmp() });
  r.claim({ sessionId: 'A', entries: [E('/w/pkg.json')], ttlSeconds: 600, origin: 'auto', note: 'auto:write', now: T0 });
  const auto = r.claim({ sessionId: 'B', entries: [E('/w/pkg.json')], ttlSeconds: 600, origin: 'auto', note: 'auto:write', now: T0 + 1000 });
  assert.equal(auto.registered, true, 'writer is not blocked by a recent edit');
  assert.equal(auto.conflicts.length, 0);
  assert.equal(auto.overlaps.length, 1);
  assert.equal(auto.overlaps[0].ownerSessionId, 'A');
  const manual = r.claim({ sessionId: 'C', entries: [E('/w/pkg.json')], ttlSeconds: 600, origin: 'manual', now: T0 + 2000 });
  assert.equal(manual.registered, true, 'manual claim_files is not blocked by others\' auto claims either');
  assert.equal(manual.overlaps.length, 2);
  const late = r.claim({ sessionId: 'D', entries: [E('/w/pkg.json')], ttlSeconds: 600, origin: 'auto', now: T0 + 3000 });
  assert.equal(late.registered, false, 'once C declared a manual claim, others conflict');
  assert.deepEqual(late.conflicts.map((c) => c.ownerSessionId), ['C']);
  assert.equal(r.holdsManual('C', pathKey('/w/pkg.json'), T0 + 3000), true);
  assert.equal(r.holdsManual('A', pathKey('/w/pkg.json'), T0 + 3000), false);
});

test('write-guard: a dispute only freezes while the holder has a MANUAL claim (v0.4.1)', () => {
  const r = new ClaimRegistry({ dataDir: tmp() });
  const n = new NegotiationStore({ dataDir: tmp(), deadlineMs: 600000, maxRounds: 6, rateMs: 0, cooldownMs: 600000 });
  const now = Date.now();
  const P = '/w/package.json';
  const key = pathKey(P);
  r.claim({ sessionId: 'A', entries: [{ path: P, key }], ttlSeconds: 600, origin: 'auto', note: 'auto:write', now: now - 300000 });
  n.open({ id: 'legacy', path: P, key, a: 'A', b: 'B', holder: 'A', writer: 'B', now }); // e.g. opened by v0.4.0 before upgrade
  const g = createWriteGuard({ registry: r, negotiations: n, mode: 'dispute', metrics: { denies: 0 } });
  const ex = { name: 'write', arguments: { file_path: P }, agent: { id: 'B', session: { header: { id: 'B', cwd: '/w' } } } };
  assert.equal(g(ex), undefined, 'recent auto edit by A never freezes B');
  r.claim({ sessionId: 'A', entries: [{ path: P, key }], ttlSeconds: 600, origin: 'manual', note: 'A declares', now });
  assert.match(g(ex), /FROZEN/, 'after A declares a manual claim the dispute freezes');
});

test('registry: expired claims are pruned and do not conflict', () => {
  const r = new ClaimRegistry({ dataDir: tmp() });
  r.claim({ sessionId: 'A', entries: [E('/w/a.ts')], ttlSeconds: 30, origin: 'manual', now: T0 });
  assert.equal(r.claim({ sessionId: 'B', entries: [E('/w/a.ts')], ttlSeconds: 30, origin: 'manual', now: T0 + 31000 }).registered, true);
});

test('registry: persist + load round trip, legacy rows migrate', async () => {
  const dir = tmp();
  writeFileSync(
    path.join(dir, 'claims.json'),
    JSON.stringify({ version: 1, claims: [{ sessionId: 'session-abc', label: 'session- @ x', cwd: '/w', path: '/w/a.ts', claimedAt: T0, expiresAt: Date.now() + 60000, note: 'auto:edit' }, { sessionId: 'z', path: 'relative/bad', expiresAt: Date.now() + 60000 }] })
  );
  const r = new ClaimRegistry({ dataDir: dir });
  await r.load(Date.now());
  const rows = r.listLive(Date.now());
  assert.equal(rows.length, 1, 'relative/garbage row dropped');
  assert.equal(rows[0].origin, 'auto');
  assert.equal(rows[0].label, 'abc @ w');
  await r.persist();
  const again = new ClaimRegistry({ dataDir: dir });
  await again.load(Date.now());
  assert.equal(again.listLive(Date.now())[0].key, rows[0].key);
});

test('registry: corrupt file starts empty and stays usable', async () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'claims.json'), '{not json');
  const r = new ClaimRegistry({ dataDir: dir, logger: { warn: () => {} } });
  await r.load(Date.now());
  assert.equal(r.ready, true);
  assert.equal(r.listLive(Date.now()).length, 0);
});

test('pathKey: symlinked and missing paths share identity', () => {
  const dir = tmp();
  mkdirSync(path.join(dir, 'real'));
  symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  assert.equal(pathKey(path.join(dir, 'link', 'new.ts')), pathKey(path.join(dir, 'real', 'new.ts')));
  assert.equal(pathKey('/definitely/missing/x.ts'), '/definitely/missing/x.ts');
});

test('toAbsolute: relative needs cwd, ~ expands', () => {
  assert.equal(toAbsolute('src/a.ts', ''), '');
  assert.equal(toAbsolute('src/a.ts', 'relative/cwd'), '');
  assert.equal(toAbsolute('src/a.ts', '/w'), '/w/src/a.ts');
  assert.equal(toAbsolute('~/x', '/w'), path.join(os.homedir(), 'x'));
  assert.equal(toAbsolute('   ', '/w'), '');
});

test('negotiation: per-sender rate limit does not block the peer (M3)', () => {
  const n = new NegotiationStore({ dataDir: tmp(), deadlineMs: 60000, maxRounds: 6, rateMs: 5000 });
  assert.equal(n.rateLimited('n1', 'H', T0), 0);
  assert.equal(n.rateLimited('n1', 'W', T0 + 100), 0);
  assert.ok(n.rateLimited('n1', 'H', T0 + 200) > 0);
  n.refundRate('n1', 'H');
  assert.equal(n.rateLimited('n1', 'H', T0 + 300), 0);
});

function openNeg(n, now = T0) {
  return n.open({ id: 'n1', path: '/w/a.ts', key: '/w/a.ts', a: 'H', b: 'W', holder: 'H', writer: 'W', now }).neg;
}

test('negotiation: permission boundaries', () => {
  const n = new NegotiationStore({ dataDir: tmp(), deadlineMs: 60000, maxRounds: 6, rateMs: 0 });
  const neg = openNeg(n);
  assert.equal(n.transition(neg, { by: 'W', action: 'offer', terms: { action: 'release-now' }, now: T0 }).ok, false);
  assert.equal(n.transition(neg, { by: 'H', action: 'offer', terms: { action: 'wait-until', at: new Date(T0 + 60000).toISOString() }, now: T0 }).ok, false);
  assert.equal(n.transition(neg, { by: 'Q', action: 'decline', now: T0 }).ok, false);
  assert.equal(n.transition(neg, { by: 'W', action: 'accept', now: T0 }).ok, false, 'nothing to accept');
  assert.equal(n.transition(neg, { by: 'H', action: 'offer', terms: { action: 'release-at', at: new Date(T0 + 61 * 60000).toISOString() }, now: T0 }).ok, false);
  assert.equal(n.transition(neg, { by: 'H', action: 'offer', terms: { action: 'release-at', at: 'garbage' }, now: T0 }).ok, false);
  assert.equal(neg.rounds, 0, 'rejected intents do not consume rounds');
});

test('negotiation: accept executes and self-accept is rejected', () => {
  const n = new NegotiationStore({ dataDir: tmp(), deadlineMs: 60000, maxRounds: 6, rateMs: 0 });
  const neg = openNeg(n);
  n.transition(neg, { by: 'H', action: 'offer', terms: { action: 'release-at', at: new Date(T0 + 60000).toISOString() }, now: T0 });
  assert.equal(n.transition(neg, { by: 'H', action: 'accept', now: T0 }).ok, false);
  const r = n.transition(neg, { by: 'W', action: 'accept', now: T0 + 1 });
  assert.equal(r.ok, true);
  assert.equal(neg.pendingReleaseAt, T0 + 60000);
});

test('negotiation: accepting a release-at whose time already passed releases now', () => {
  const n = new NegotiationStore({ dataDir: tmp(), deadlineMs: 600000, maxRounds: 6, rateMs: 0 });
  const neg = openNeg(n);
  n.transition(neg, { by: 'H', action: 'offer', terms: { action: 'release-at', at: new Date(T0 + 1000).toISOString() }, now: T0 });
  const r = n.transition(neg, { by: 'W', action: 'accept', now: T0 + 5000 });
  assert.equal(r.effects.releaseAt, T0 + 5000);
  assert.equal(neg.pendingReleaseAt, 0);
});

test('negotiation: round limit escalates and is persisted in history', () => {
  const n = new NegotiationStore({ dataDir: tmp(), deadlineMs: 600000, maxRounds: 2, rateMs: 0 });
  const neg = openNeg(n);
  const at = (m) => new Date(T0 + m * 60000).toISOString();
  n.transition(neg, { by: 'H', action: 'offer', terms: { action: 'release-at', at: at(30) }, now: T0 });
  n.transition(neg, { by: 'W', action: 'counter', terms: { action: 'wait-until', at: at(5) }, now: T0 });
  const r = n.transition(neg, { by: 'H', action: 'counter', terms: { action: 'release-at', at: at(20) }, now: T0 });
  assert.equal(r.effects.escalated, true);
  assert.equal(neg.state, 'escalated');
  assert.equal(neg.rounds, 2);
});

test('negotiation: pending long release survives prune (M2)', () => {
  const n = new NegotiationStore({ dataDir: tmp(), deadlineMs: 600000, maxRounds: 6, rateMs: 0, cooldownMs: 0 });
  const neg = openNeg(n);
  n.transition(neg, { by: 'H', action: 'offer', terms: { action: 'release-at', at: new Date(T0 + 50 * 60000).toISOString() }, now: T0 });
  n.transition(neg, { by: 'W', action: 'accept', now: T0 });
  n.scan(T0 + 31 * 60000);
  assert.equal(n.prune(T0 + 31 * 60000, 30 * 60000), 0);
  assert.equal(n.scan(T0 + 50 * 60000).dueReleases.length, 1);
  assert.equal(n.prune(T0 + 90 * 60000, 30 * 60000), 1);
});

test('negotiation: freeze semantics (H1)', () => {
  const n = new NegotiationStore({ dataDir: tmp(), deadlineMs: 1000, maxRounds: 6, rateMs: 0, cooldownMs: 5000 });
  const neg = openNeg(n);
  const holds = () => true;
  assert.equal(n.frozenFor('/w/a.ts', 'W', T0, holds), neg);
  assert.equal(n.frozenFor('/w/a.ts', 'H', T0, holds), undefined, 'holder never frozen');
  assert.equal(n.frozenFor('/w/a.ts', 'W', T0, () => false), undefined, 'released claim unfreezes immediately');
  n.scan(T0 + 2000);
  assert.equal(neg.state, 'escalated');
  assert.equal(n.frozenFor('/w/a.ts', 'W', T0 + 3000, holds), neg, 'escalated freezes during cooldown');
  assert.equal(n.frozenFor('/w/a.ts', 'W', T0 + 8000, holds), undefined, 'cooldown elapsed');
  assert.ok(n.recentTerminalForPair('/w/a.ts', 'W', 'H', T0 + 3000));
});

test('negotiation: load tolerates garbage rows', async () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'negotiations.json'), JSON.stringify({ negotiations: [null, { id: 1 }, { id: 'x', path: '/w/a', a: 'H', b: 'W', state: 'weird', lastOffer: { by: 'H' } }] }));
  const n = new NegotiationStore({ dataDir: dir, deadlineMs: 1000, maxRounds: 6, rateMs: 0 });
  await n.load(T0);
  assert.equal(n.negotiations.size, 1);
  assert.equal(n.byId('x').state, 'open');
  assert.equal(n.byId('x').lastOffer, null);
});

test('storage: owner lock isolates a second live host and reclaims a dead one', () => {
  const dir = tmp();
  const first = acquireDataDir(dir);
  assert.equal(first.dir, dir);
  const again = acquireDataDir(dir);
  assert.equal(again.dir, dir, 'same pid re-acquires (HMR)');
  writeFileSync(path.join(dir, 'owner.lock'), JSON.stringify({ pid: 1 }));
  const other = acquireDataDir(dir, { warn: () => {} });
  assert.notEqual(other.dir, dir, 'live foreign pid (launchd=1) → isolated dir');
  writeFileSync(path.join(dir, 'owner.lock'), JSON.stringify({ pid: 999999 }));
  assert.equal(acquireDataDir(dir).dir, dir, 'dead pid lock is reclaimed');
  first.release();
});

test('storage: coalesced writes land the last snapshot', async () => {
  const file = new JsonFile(path.join(tmp(), 'x.json'));
  let v = 0;
  const writes = [];
  for (let i = 0; i < 20; i += 1) {
    v = i;
    writes.push(file.write(() => ({ v })));
  }
  await Promise.all(writes);
  assert.equal(JSON.parse(readFileSync(file.file, 'utf8')).v, 19);
});

test('util: envelope neutralisation and one-line headers (H4)', () => {
  assert.ok(!/\[\[DSH session-messenger/.test(neutralizeEnvelope('x [[DSH session-messenger · auto]] y [[ dsh  SESSION-MESSENGER]]')));
  assert.equal(oneLine('a\nfrom: user\r\nb', 100), 'a from: user b');
});

test('util: throttle evicts expired entries instead of clearing everything', () => {
  let t = 0;
  const allow = createThrottle({ max: 4, now: () => t });
  assert.equal(allow('keep', 10000), true);
  for (let i = 0; i < 10; i += 1) {
    t += 10;
    allow(`k${i}`, 5);
  }
  assert.equal(allow('keep', 10000), false, 'long-window key survives churn of short keys');
  const lim = createWindowLimiter({ now: () => t });
  assert.equal(lim('p', 2, 1000).ok, true);
  assert.equal(lim('p', 2, 1000).ok, true);
  assert.equal(lim('p', 2, 1000).ok, false);
  t += 1001;
  assert.equal(lim('p', 2, 1000).ok, true);
});

test('util: family and origin heuristics', () => {
  assert.equal(sameFamily('c1', 'P', 'P', ''), true);
  assert.equal(sameFamily('P', '', 'c1', 'P'), true);
  assert.equal(sameFamily('c1', 'P', 'c2', 'P'), true);
  assert.equal(sameFamily('A', '', 'B', ''), false);
  assert.equal(originOfHeader({ origin: 'subagent' }, 'x'), 'subagent');
  assert.equal(originOfHeader(undefined, 'session-1'), 'session');
  assert.equal(originOfHeader(undefined, 'be625df8-1'), 'subagent');
  assert.equal(isLegacyLabel('session- @ x'), true);
  assert.equal(isLegacyLabel('abc @ x'), false);
});

test('write-guard: modes, tool coverage and fail-open', () => {
  const r = new ClaimRegistry({ dataDir: tmp() });
  r.claim({ sessionId: 'H', entries: [E('/w/a.ts')], ttlSeconds: 600, origin: 'manual', now: Date.now() });
  r.claim({ sessionId: 'H', entries: [E('/w/auto.ts')], ttlSeconds: 600, origin: 'auto', now: Date.now() });
  const metrics = { denies: 0 };
  const exec = (name, args, id = 'W') => ({ name, arguments: args, agent: { id, session: { header: { id, cwd: '/w' } } } });
  const claims = createWriteGuard({ registry: r, negotiations: null, mode: 'claims', metrics });
  assert.match(claims(exec('write', { file_path: 'a.ts' })), /claimed by/);
  assert.equal(claims(exec('write', { file_path: '/w/auto.ts' })), undefined, 'auto claims never block');
  assert.equal(claims(exec('write', { file_path: '/w/a.ts' }, 'H')), undefined);
  assert.equal(claims({ name: 'write', arguments: { file_path: '/w/a.ts' } }), undefined, 'no agent → allow');
  const dispute = createWriteGuard({ registry: r, negotiations: null, mode: 'dispute', metrics });
  assert.equal(dispute(exec('write', { file_path: '/w/a.ts' })), undefined, 'dispute mode ignores plain claims');
  const broken = createWriteGuard({ registry: { othersOn: () => { throw new Error('boom'); }, own: () => undefined }, negotiations: null, mode: 'claims', metrics, logger: { warn: () => {} } });
  assert.equal(broken(exec('write', { file_path: '/w/a.ts' })), undefined, 'guard fails open');
  const env = process.env.DSH_SESSION_MESSENGER_HARD_GATE;
  process.env.DSH_SESSION_MESSENGER_HARD_GATE = '1';
  assert.equal(guardMode({}), 'claims', 'legacy HARD_GATE=1 maps to claims');
  if (env === undefined) delete process.env.DSH_SESSION_MESSENGER_HARD_GATE;
  else process.env.DSH_SESSION_MESSENGER_HARD_GATE = env;
  assert.equal(guardMode({ guard: 'nonsense' }), 'dispute');
});

// ------------------------------------------------ v0.4.2 同一文件多写入方
function multi() {
  const n = new NegotiationStore({ dataDir: tmp(), deadlineMs: 1000, maxRounds: 6, rateMs: 0, cooldownMs: 600000 });
  const mk = (id, w, at) => n.open({ id, path: '/w/h.ts', key: '/w/h.ts', a: 'H', b: w, holder: 'H', writer: w, now: at }).neg;
  return { n, b: mk('nb', 'B', T0), c: mk('nc', 'C', T0 + 10) };
}

test('queue: agreed handoff queues the other writers and blocks double promises', () => {
  const { n, b, c } = multi();
  n.transition(b, { by: 'H', action: 'offer', terms: { action: 'release-at', at: new Date(T0 + 60000).toISOString() }, now: T0 });
  const r = n.transition(b, { by: 'B', action: 'accept', now: T0 });
  assert.equal(r.effects.handoff, true);
  assert.equal(b.handoffTo, 'B');
  assert.deepEqual(n.queueOthers(b, T0).map((x) => x.id), ['nc']);
  assert.equal(c.state, 'queued');
  assert.equal(n.transition(c, { by: 'H', action: 'offer', terms: { action: 'release-now' }, now: T0 }).ok, false, 'holder cannot promise the file twice');
  assert.equal(n.transition(c, { by: 'C', action: 'offer', terms: { action: 'wait-until', at: new Date(T0 + 5000).toISOString() }, now: T0 }).ok, false, 'queued writer cannot negotiate');
  assert.equal(n.transition(c, { by: 'C', action: 'decline', now: T0 }).ok, true, 'queued writer can leave');
});

test('queue: queued negotiations never escalate by deadline and keep freezing', () => {
  const { n, b, c } = multi();
  n.transition(b, { by: 'H', action: 'offer', terms: { action: 'release-at', at: new Date(T0 + 60000).toISOString() }, now: T0 });
  n.transition(b, { by: 'B', action: 'accept', now: T0 });
  n.queueOthers(b, T0);
  n.scan(T0 + 5000); // far beyond the 1s deadline
  assert.equal(c.state, 'queued');
  assert.ok(n.frozenFor('/w/h.ts', 'C', T0 + 5000, () => true), 'queued writer stays frozen');
  assert.ok(n.frozenFor('/w/h.ts', 'B', T0 + 5000, () => true), 'agreed recipient waits until the handoff time');
  assert.equal(n.frozenFor('/w/h.ts', 'H', T0 + 5000, () => true), undefined, 'holder keeps working until the handoff');
});

test('queue: newcomer after an agreed handoff is queued directly; order is first-come', () => {
  const { n, b } = multi();
  n.transition(b, { by: 'H', action: 'offer', terms: { action: 'release-at', at: new Date(T0 + 60000).toISOString() }, now: T0 });
  n.transition(b, { by: 'B', action: 'accept', now: T0 });
  n.queueOthers(b, T0);
  const d = n.open({ id: 'nd', path: '/w/h.ts', key: '/w/h.ts', a: 'H', b: 'D', holder: 'H', writer: 'D', now: T0 + 20 }).neg;
  assert.equal(d.state, 'queued');
  assert.deepEqual(n.queueFor('/w/h.ts', T0).map((x) => x.writer), ['C', 'D']);
  assert.equal(n.positionOf(d, T0), 2);
});

test('queue: rebind resets terms and reopens against the new holder', () => {
  const { n, c } = multi();
  n.transition(c, { by: 'C', action: 'offer', terms: { action: 'wait-until', at: new Date(T0 + 50000).toISOString() }, now: T0 });
  c.state = 'queued';
  n.rebind(c, 'B', 'B @ w', T0 + 100);
  assert.equal(c.holder, 'B');
  assert.equal(c.a, 'B');
  assert.equal(c.b, 'C');
  assert.equal(c.state, 'open');
  assert.equal(c.rounds, 0);
  assert.equal(c.lastOffer, null);
  assert.equal(c.deadline, T0 + 100 + 1000);
});

test('queue: queued state and handoff target survive restart', async () => {
  const dir = tmp();
  const n = new NegotiationStore({ dataDir: dir, deadlineMs: 1000, maxRounds: 6, rateMs: 0 });
  const b = n.open({ id: 'nb', path: '/w/h.ts', key: '/w/h.ts', a: 'H', b: 'B', holder: 'H', writer: 'B', writerMeta: { cwd: '/w' }, now: T0 }).neg;
  n.open({ id: 'nc', path: '/w/h.ts', key: '/w/h.ts', a: 'H', b: 'C', holder: 'H', writer: 'C', now: T0 + 1 });
  n.transition(b, { by: 'H', action: 'offer', terms: { action: 'release-at', at: new Date(Date.now() + 60000).toISOString() }, now: Date.now() });
  n.transition(b, { by: 'B', action: 'accept', now: Date.now() });
  n.queueOthers(b, Date.now());
  await n.persist();
  const again = new NegotiationStore({ dataDir: dir, deadlineMs: 1000, maxRounds: 6, rateMs: 0 });
  await again.load(Date.now());
  assert.equal(again.byId('nc').state, 'queued');
  assert.equal(again.byId('nb').handoffTo, 'B');
  assert.equal(again.byId('nb').writerMeta.cwd, '/w');
  assert.ok(again.pendingHandoff('/w/h.ts'));
});

test('registry: transfer is atomic and keeps the longer lifetime', () => {
  const r = new ClaimRegistry({ dataDir: tmp() });
  r.claim({ sessionId: 'H', entries: [E('/w/h.ts')], ttlSeconds: 3600, origin: 'manual', note: 'refactor', now: T0 });
  r.claim({ sessionId: 'B', entries: [E('/w/h.ts')], ttlSeconds: 600, origin: 'auto', now: T0 }); // B's auto row is an overlap
  const moved = r.transfer('H', pathKey('/w/h.ts'), { sessionId: 'B', label: 'B @ w' }, T0 + 1000, 1800);
  assert.equal(moved.sessionId, 'B');
  assert.equal(moved.origin, 'manual');
  assert.equal(moved.expiresAt, T0 + 3600 * 1000);
  assert.match(moved.note, /handed over by/);
  assert.equal(r.own('H', pathKey('/w/h.ts')), undefined);
  assert.equal(r.listLive(T0 + 1000).filter((c) => c.key === pathKey('/w/h.ts')).length, 1, 'no duplicate rows');
  assert.equal(r.transfer('H', pathKey('/w/h.ts'), { sessionId: 'C' }, T0 + 2000), undefined, 'nothing to transfer twice');
});

function coord(extra = {}) {
  const dir = tmp();
  const r = new ClaimRegistry({ dataDir: dir });
  r.ready = true;
  const n = new NegotiationStore({ dataDir: dir, deadlineMs: 600000, maxRounds: 6, rateMs: 0, cooldownMs: 600000 });
  n.ready = true;
  const sent = [];
  const metrics = new Proxy({}, { get: (t, k) => t[k] || 0, set: (t, k, v) => ((t[k] = v), true) });
  const delivery = { notify: (id, text) => (sent.push({ id, text }), 'injected'), liveAgent: () => ({}), liveSessions: () => [], sessionCwd: () => '/w', ...extra };
  const c = createCoordinator({ registry: r, negotiations: n, delivery, logger: {}, metrics, settings: { autoClaimTtlSeconds: 600, negRetentionMs: 1800000, autoNotify: true, scopeToWorkspace: false, overlapCooldownMs: 0 } });
  return { r, n, c, sent, metrics };
}

test('coordinator: holder claim EXPIRES while a writer waits → the writer takes over (persisted)', async () => {
  const { r, n, c, sent } = coord();
  const P = '/w/e.ts';
  const key = pathKey(P);
  r.claim({ sessionId: 'A', entries: [{ path: P, key }], ttlSeconds: 30, origin: 'manual', now: Date.now() });
  n.open({ id: 'x', path: P, key, a: 'A', b: 'B', holder: 'A', writer: 'B', writerMeta: { cwd: '/w' }, now: Date.now() });
  for (const cl of r.claims.values()) cl.expiresAt = Date.now() - 1;
  c.runWatchdogOnce();
  assert.equal(n.byId('x').state, 'accepted');
  assert.deepEqual(r.listLive(Date.now()).map((x) => `${x.sessionId}:${x.origin}`), ['B:manual']);
  assert.ok(sent.some((m) => m.id === 'B' && /已移交给你/.test(m.text)));
  await r.persist();
  const again = new ClaimRegistry({ dataDir: r.file.file.replace(/\/claims\.json$/, '') });
  await again.load(Date.now());
  assert.equal(again.listLive(Date.now())[0].sessionId, 'B', 'takeover survives restart');
});

test('coordinator: a disposed subagent in the queue is skipped', () => {
  const { r, n, c } = coord({ liveAgent: (id) => (id === 'sub' ? undefined : {}) });
  const P = '/w/q.ts';
  const key = pathKey(P);
  r.claim({ sessionId: 'A', entries: [{ path: P, key }], ttlSeconds: 600, origin: 'manual', now: Date.now() });
  n.open({ id: 's', path: P, key, a: 'A', b: 'sub', holder: 'A', writer: 'sub', writerMeta: { origin: 'subagent' }, now: Date.now() });
  n.open({ id: 'd', path: P, key, a: 'A', b: 'D', holder: 'A', writer: 'D', now: Date.now() + 1 });
  r.release('A', [key]);
  c.handleReleased('A', [key], Date.now());
  assert.deepEqual(r.listLive(Date.now()).map((x) => x.sessionId), ['D']);
  assert.equal(n.byId('s').state, 'resolved');
});

test('coordinator: the holder\'s own child does not queue behind the holder', () => {
  const { r, n, c } = coord();
  const P = '/w/f.ts';
  const key = pathKey(P);
  r.claim({ sessionId: 'A', entries: [{ path: P, key }], ttlSeconds: 600, origin: 'manual', now: Date.now() });
  c.handleWriteIntent('write', { targetKey: P, displayPath: P }, { agent: { id: 'kid', session: { header: { id: 'kid', cwd: '/w', origin: 'subagent', parentSession: 'A' } } } });
  assert.equal(n.negotiations.size, 0, 'no negotiation inside one family');
});

test('coordinator: holder claim expires during the post-escalation cooldown → writer is unfrozen and told', () => {
  const { r, n, c, sent } = coord();
  const P = '/w/x.ts';
  const key = pathKey(P);
  const now = Date.now();
  r.claim({ sessionId: 'A', entries: [{ path: P, key }], ttlSeconds: 30, origin: 'manual', now });
  const neg = n.open({ id: 'e', path: P, key, a: 'A', b: 'B', holder: 'A', writer: 'B', now }).neg;
  n.mark(neg, 'escalated', 'no response before deadline', now);
  const g = createWriteGuard({ registry: r, negotiations: n, mode: 'dispute', metrics: { denies: 0 } });
  const ex = { name: 'write', arguments: { file_path: P }, agent: { id: 'B', session: { header: { id: 'B', cwd: '/w' } } } };
  assert.match(g(ex), /FROZEN/, 'frozen during cooldown while A holds');
  for (const cl of r.claims.values()) cl.expiresAt = Date.now() - 1;
  assert.equal(g(ex), undefined, 'guard lifts immediately once A no longer holds');
  c.runWatchdogOnce();
  assert.equal(neg.state, 'resolved');
  assert.ok(sent.some((m) => m.id === 'B' && /path is free/.test(m.text)), 'writer is told the path is free');
});
