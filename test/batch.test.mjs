import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporaryDirectory } from './fixtures.mjs';
import { parseAccountLog, formatDashboard, formatSummaryReport } from '../batch-learn.mjs';
import * as batch from '../batch-learn.mjs';

import { resolveProfilePaths } from '../runtime-utils.mjs';
import * as watchdog from '../learning-watchdog.mjs';
import { EventEmitter } from 'node:events';

for (const change of ['scope', 'policy']) test(`bootstrap rejects competing ${change} before arm or child spawn`, async t => {
  const root = temporaryDirectory(t), a = { profile: 'a', user: 'a' }, b = { profile: 'b', user: 'b' };
  const lock = watchdog.acquireMonitorLock(root);
  t.after(() => lock.release());
  watchdog.armLearningRun(root, Date.now(), { accounts: [a], daily: true });
  const file = path.join(root, 'logs/learning-watchdog-arm.json');
  const before = fs.readFileSync(file);
  let spawns = 0;
  assert.equal(typeof batch.startLearningBatch, 'function');
  await assert.rejects(batch.runBatch({ root, identityAccounts: [a, b], args: [`--accounts=${change === 'scope' ? 'b' : 'a'}`, `--daily=${change !== 'policy'}`],
    spawnFn: () => { spawns++; throw new Error('unexpected spawn'); },
    monitorOptions: { tickFn: async () => { assert.fail('conflicting monitor tick'); }, notify: async () => { assert.fail('unexpected notification'); } }
  }), /MONITOR_ALREADY_RUNNING/);
  assert.equal(spawns, 0);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(lock.owned(), true);
});

test('bootstrap holds lock through arm and all spawn acknowledgements before monitoring', async t => {
  const root = temporaryDirectory(t), accounts = [{ profile: 'first', user: 'u' }, { profile: 'second', user: 'v' }];
  const order = [], acknowledgements = [], procs = [];
  const result = batch.startLearningBatch({ root, accounts, daily: false,
    watchdogApi: { ...watchdog,
      startBatchMonitor(options) { order.push('lock'); return watchdog.startBatchMonitor(options); },
      armLearningRun(...args) { assert.equal(watchdog.acquireMonitorLock(root), null); order.push('arm'); return watchdog.armLearningRun(...args); }
    },
    spawnFn(exe, args, options) {
      order.push('spawn');
      assert(!args.includes('--daily'));
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'logs/learning-watchdog-arm.json'))).policy.daily, false);
      assert.equal(watchdog.acquireMonitorLock(root), null);
      const proc = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null, kill() { this.exitCode = 0; this.emit('exit', 0); this.emit('close', 0); } });
      procs.push(proc); acknowledgements.push(() => proc.emit('spawn'));
      return proc;
    },
    monitorOptions: { tickFn: async () => { order.push('monitor'); return { accounts: [{ status: 'active', known: true, learner: true }] }; }, notify: async () => ({ ok: true }) }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['lock', 'arm', 'spawn']);
  acknowledgements.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['lock', 'arm', 'spawn', 'spawn']);
  acknowledgements.shift()();
  const started = await result;
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['lock', 'arm', 'spawn', 'spawn', 'monitor']);
    assert.equal(started.owner.size, 2);
    assert.equal(started.children.length, 2);
  } finally { await batch.stopOwnedBatch(started.owner, started.monitor, started.exits); }
  assert(!fs.existsSync(path.join(root, 'logs/learning-watchdog.lock.json')));
});

for (const failure of ['arm', 'spawn-throw', 'spawn-error', 'monitor-null']) test(`bootstrap ${failure} is fail-closed and preserves previous authorization`, async t => {
  const root = temporaryDirectory(t), accounts = [{ profile: 'new-a', user: 'u' }, { profile: 'new-b', user: 'v' }];
  watchdog.armLearningRun(root, Date.now(), { accounts: [{ profile: 'old', user: 'old' }], daily: true });
  const file = path.join(root, 'logs/learning-watchdog-arm.json'), before = fs.readFileSync(file);
  let calls = 0, stopped = 0, ticks = 0;
  const api = { ...watchdog };
  if (failure === 'arm') api.armLearningRun = (...args) => { watchdog.armLearningRun(...args); throw new Error('INIT_FAILED'); };
  if (failure === 'monitor-null') api.startBatchMonitor = () => null;
  await assert.rejects(batch.startLearningBatch({ root, accounts, daily: false, watchdogApi: api,
    spawnFn() {
      calls++;
      if (calls === 2 && failure === 'spawn-throw') throw new Error('SPAWN_FAILED');
      const proc = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() { stopped++; this.exitCode = 0; this.emit('exit', 0); this.emit('close', 0); } });
      queueMicrotask(() => { if (calls === 2 && failure === 'spawn-error') { proc.emit('error', new Error('SPAWN_FAILED')); proc.emit('close', -1); } else proc.emit('spawn'); });
      return proc;
    }, monitorOptions: { tickFn: async () => { ticks++; return { accounts: [] }; }, notify: async () => { assert.fail('failed bootstrap must not notify'); } }
  }), failure === 'monitor-null' ? /MONITOR_ALREADY_RUNNING/ : /INIT_FAILED|SPAWN_FAILED|LEARNER_LAUNCH_FAILED/);
  assert.equal(calls, failure.startsWith('spawn') ? 2 : 0);
  assert.equal(stopped, failure.startsWith('spawn') ? 1 : 0);
  assert.equal(ticks, 0);
  assert.deepEqual(fs.readFileSync(file), before);
  assert(!fs.existsSync(path.join(root, 'logs/learning-watchdog.lock.json')));
  const next = watchdog.acquireMonitorLock(root); assert(next); next.release();
});

test('bootstrap failure retains ownership until its launched child closes', async t => {
  const root = temporaryDirectory(t), accounts = [{ profile: 'a', user: 'a' }, { profile: 'b', user: 'b' }];
  let first, stopped, calls = 0, finished = false;
  const stopping = new Promise(resolve => { stopped = resolve; });
  const startup = batch.startLearningBatch({ root, accounts, watchdogApi: watchdog,
    spawnFn() {
      if (++calls === 2) throw new Error('SPAWN_FAILED');
      first = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() { stopped(); } });
      queueMicrotask(() => first.emit('spawn'));
      return first;
    }, monitorOptions: { tickFn: async () => { assert.fail('early tick'); }, notify: async () => { assert.fail('notification'); } }
  }).then(() => assert.fail('must fail'), error => { finished = true; assert.match(error.message, /SPAWN_FAILED/); });
  await stopping;
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(finished, false);
    assert.equal(watchdog.acquireMonitorLock(root), null, 'failed launch must keep lock until owned children close');
  } finally { first.exitCode = 0; first.emit('exit', 0); first.emit('close', 0); await startup; }
  assert(!fs.existsSync(path.join(root, 'logs/learning-watchdog.lock.json')));
  assert(!fs.existsSync(path.join(root, 'logs/learning-watchdog-arm.json')), 'no prior authorization must remain absent');
});

test('bootstrap rollback never changes a successor authorization or lock', async t => {
  const root = temporaryDirectory(t), accounts = [{ profile: 'a', user: 'a' }];
  const armFile = path.join(root, 'logs/learning-watchdog-arm.json'), lockFile = path.join(root, 'logs/learning-watchdog.lock.json');
  const successorArm = '{"owner":"successor"}\n', successorLock = JSON.stringify({ pid: process.pid, token: 'successor' });
  let stopped = 0;
  await assert.rejects(batch.startLearningBatch({ root, accounts, watchdogApi: watchdog,
    spawnFn() {
      const proc = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() { stopped++; this.exitCode = 0; this.emit('close', 0); } });
      queueMicrotask(() => { fs.writeFileSync(armFile, successorArm); fs.writeFileSync(lockFile, successorLock); proc.emit('spawn'); });
      return proc;
    }, monitorOptions: { tickFn: async () => { assert.fail('lost lock tick'); }, notify: async () => { assert.fail('notification'); } }
  }), /MONITOR_LOCK_LOST/);
  assert.equal(stopped, 1);
  assert.equal(fs.readFileSync(armFile, 'utf8'), successorArm);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), successorLock);
});

test('late recordExit retries delivery after monitor completion and preserves account health on failure', async t => {
  const root = temporaryDirectory(t), account = { profile: 'late-close', user: 'fixture' };
  const health = { timestamp: 'fixture-time', accounts: [{ profile: 'fixture', status: 'finished', known: true }], notifier: { ok: true } };
  const healthFile = path.join(root, 'logs', 'learning-watchdog-health.json');
  fs.mkdirSync(path.dirname(healthFile));
  fs.writeFileSync(healthFile, JSON.stringify(health));
  const monitor = { done: true, health, finished: Promise.resolve(), wake() { assert.fail('must not restart completed monitor'); } };
  let attempts = 0;
  assert.equal(typeof batch.createBatchExitRecorder, 'function');
  const exits = batch.createBatchExitRecorder({
    root, watchdogApi: watchdog, identityAccounts: [account], getMonitor: () => monitor,
    notify: async () => { attempts++; return { ok: false }; },
    drainOptions: { retryDelayMs: 0, deliveryAttempts: 3 }
  });
  exits.recordExit(account);
  await exits.finished;
  assert.equal(attempts, 3, 'late child close must use bounded retry, not fire-and-forget');
  const saved = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
  assert.deepEqual(saved.accounts, health.accounts);
  assert.equal(saved.timestamp, 'fixture-time');
  assert.equal(saved.notifier.ok, false);
  assert.equal(saved.notifier.error, 'UNDELIVERED_LOCAL');
  assert.equal(saved.notifier.attempts, 3);
  assert(saved.notifier.pending >= 2, 'child exit and notifier failure remain durable');
  assert.deepEqual(monitor.health.notifier, saved.notifier);
});

test('late closes serialize successful drains and block batch completion until delivery settles', async t => {
  const root = temporaryDirectory(t), accounts = [{ profile: 'late-a', user: 'a' }, { profile: 'late-b', user: 'b' }];
  const monitor = { done: true, finished: Promise.resolve(), health: { accounts: [{ status: 'finished' }] } };
  let release, entered, active = 0, maximumActive = 0, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const directory = path.join(root, 'logs', 'learning-alerts');
  const exits = batch.createBatchExitRecorder({
    root, watchdogApi: watchdog, identityAccounts: accounts, getMonitor: () => monitor,
    notify: async () => {
      calls++; active++; maximumActive = Math.max(maximumActive, active);
      const files = fs.readdirSync(directory).filter(f => f.endsWith('.json'));
      if (calls === 1) { entered(); await held; }
      for (const file of files) fs.unlinkSync(path.join(directory, file));
      active--;
      return { ok: true };
    }, drainOptions: { retryDelayMs: 0 }
  });
  try {
    exits.recordExit(accounts[0]);
    await started;
    exits.recordExit(accounts[1]);
    const children = accounts.map(acc => ({ acc, closed: true, proc: { exitCode: 0 } }));
    assert.equal(exits.pending, 2);
    assert.equal(batch.shouldFinishBatch(children, monitor, { size: 0 }, exits), false, 'summary must wait for pending close delivery');
    let completed = false;
    const completion = batch.stopOwnedBatch({ stop() {} }, { ...monitor, stop() {} }, exits).then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false, 'SIGINT completion must also wait for pending delivery');
    release();
    await completion;
    assert.equal(exits.pending, 0);
    assert.equal(maximumActive, 1, 'simultaneous close events must not race notifier drains');
    assert(calls >= 2, 'an event arriving during a drain must also be delivered');
    assert.equal(fs.readdirSync(directory).filter(f => f.endsWith('.json')).length, 0);
    assert.equal(batch.shouldFinishBatch(children, monitor, { size: 0 }, exits), true);
    const health = JSON.parse(fs.readFileSync(path.join(root, 'logs', 'learning-watchdog-health.json'), 'utf8'));
    assert.equal(health.notifier.ok, true);
    assert.equal(health.notifier.pending, 0);
  } finally { release(); await exits.finished; }
});

test('batch waits for child close even when exitCode is already available', () => {
  const child = { proc: { exitCode: 0 }, closed: false };
  const monitor = { done: true }, owner = { size: 0 }, exits = { pending: 0 };
  assert.equal(batch.shouldFinishBatch([child], monitor, owner, exits), false, 'exit precedes close and its durable notification');
  child.closed = true;
  assert.equal(batch.shouldFinishBatch([child], monitor, owner, exits), true);
});

test('dashboard combines injected observation with same-local-day restart totals and keeps round gain separate', async t => {
  const root = temporaryDirectory(t), accounts = [{ profile: 'dash', user: 'u' }];
  const key = resolveProfilePaths(root, 'dash', 'u').key;
  fs.mkdirSync(path.join(root, 'logs'));
  const now = new Date(2026, 9, 2, 12).getTime();
  const filename = date => `run-${key}-${date.toISOString().slice(0, 19).replaceAll(':', '-')}.log`;
  const write = (hour, text) => fs.writeFileSync(path.join(root, 'logs', filename(new Date(2026, 9, 2, hour))), text);
  write(9, '[09:00:00 +00:00:00] 当前进度: 学时/学分 10\n[09:01:00 +00:01:00] 《课一》 id=1\n[09:02:00 +00:02:00] ✔ 该课程已学完,学分已到账\n[09:03:00 +00:03:00] 当前学时/学分: 11\n');
  write(11, '[11:00:00 +00:00:00] 当前进度: 学时/学分 11\n[11:01:00 +00:01:00] 《课二》 id=2\n[11:02:00 +00:02:00] ✔ 该课程已学完,学分已到账\n[11:03:00 +00:03:00] 当前学时/学分: 12\n[11:04:00 +00:04:00] 《课三》 id=3\n[11:05:00 +00:05:00] …播放中 01:00 / 10:00 (10.0%)\n');
  const options = { root, now, observe: async () => ({ [key]: { known: true, learner: false, browser: false, mtime: now } }) };
  const [row] = await batch.generateDashboard(accounts, options);
  assert.equal(row.gain, '+2.00');
  assert.equal(row.runGain, '+1.00');
  assert.equal(row.finished, 2);
  assert.match(row.status, /已退出/);
  assert.equal(row.course, '');
  const [unknown] = await batch.generateDashboard(accounts, { ...options, observe: async () => ({}) });
  assert.match(unknown.status, /未知/);
});

test('dashboard keeps the pre-reset quota cap and flags cross-midnight credit intervals unknown', async t => {
  const root = temporaryDirectory(t), accounts = [{ profile: 'midnight', user: 'u' }];
  const paths = resolveProfilePaths(root, 'midnight', 'u');
  fs.mkdirSync(path.join(root, 'logs'));
  const start = new Date(2026, 9, 1, 23, 50);
  const file = path.join(root, 'logs', `run-${paths.key}-${start.toISOString().slice(0, 19).replaceAll(':', '-')}.log`);
  fs.writeFileSync(file, '[23:50:00 +00:00:00] 当前进度: 学时/学分 10\n[23:51:00 +00:01:00] 已达站点【每日学时上限】\n');
  const { observeAccounts } = await import('../learning-watchdog.mjs');
  const options = { root, now: new Date(2026, 9, 2, 1).getTime(), observe: o => observeAccounts({ ...o, enumerate: async () => ({ known: true, processes: [] }) }) };
  let [row] = await batch.generateDashboard(accounts, options);
  // 01:00 has not crossed the site's estimated reset window; midnight alone is not a reset.
  assert.equal(row.status, '已达今日上限');
  const [daytime] = await batch.generateDashboard(accounts, { ...options, now: new Date(2026, 9, 2, 6).getTime() });
  assert.match(daytime.status, /历史达限 2026-10-01/);
  assert(!daytime.status.includes('已达今日上限'));
  fs.appendFileSync(file, '[00:10:00 +00:20:00] ✔ 该课程已学完,学分已到账\n[00:11:00 +00:21:00] 当前学时/学分: 11\n');
  [row] = await batch.generateDashboard(accounts, options);
  assert.match(row.gain, /不可归因/);
  assert.equal(row.finished, 1);
  assert.equal(row.runGain, '+1.00');
});

test('summary filenames use local date and never overwrite another same-time run', t => {
  const root = temporaryDirectory(t);
  assert.equal(typeof batch.saveSummaryReport, 'function');
  const now = new Date(2026, 9, 2, 0, 5).getTime();
  const first = batch.saveSummaryReport(root, 'first', now);
  const second = batch.saveSummaryReport(root, 'second', now);
  assert.match(path.basename(first), /^summary-2026-10-02-/);
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(first, 'utf8'), 'first');
  assert.equal(fs.readFileSync(second, 'utf8'), 'second');
});

test('batch selection fails closed and forwards non-daily policy', () => {
  assert.equal(typeof batch.selectBatchAccounts, 'function');
  const accounts = [{ profile: 'a', user: 'a' }, { profile: 'b', user: 'b' }];
  const options = batch.parseBatchOptions(['--accounts=b', '--daily=false', '--max-accounts=1']);
  assert.deepEqual(batch.selectBatchAccounts(accounts, options), [accounts[1]]);
  assert.equal(options.daily, false);
  assert.throws(() => batch.selectBatchAccounts(accounts, batch.parseBatchOptions(['--accounts=absent'])), /NO_MATCHING_ACCOUNTS/);
  assert.throws(() => batch.selectBatchAccounts(accounts, batch.parseBatchOptions(['--max-accounts=1'])), /MAX_ACCOUNTS_EXCEEDED/);
});

test('parseAccountLog correctly parses credit, progress, and daily limit status', t => {
  const dir = temporaryDirectory(t);
  const logFile = path.join(dir, 'run-test.log');

  const content = `
[08:00:00]   当前学时/学分: 50.0 (来源 MyStudyStat.CreditSum)
[08:00:01] ──────── 第 1 门 ────────
[08:00:01] 《高素质干部队伍建设》 id=1234 学分=1 进度=-1
[08:05:00]     …播放中 10:00 / 20:00 (50.0%)
[08:10:00]   ✔ 播放完毕(20:00 / 20:00)
[08:10:05]   ✔ 进度已入账: BrowseScore 100
[08:10:06]   ✔ 该课程已学完,学分已到账
[08:10:07]   当前学时/学分: 51.0 (来源 MyStudyStat.CreditSum)
[08:10:10] ──────── 第 2 门 ────────
[08:10:10] 《新时代党的建设》 id=5678 学分=1 进度=-1
[08:10:12]   🛑 已达站点【每日学时上限】
[08:10:15]  结束。本次处理 2 门,学时/学分 51.0
[08:10:16] 浏览器已关闭
`;

  fs.writeFileSync(logFile, content, 'utf8');
  const res = parseAccountLog(logFile);

  assert.equal(res.initialCredit, 50.0);
  assert.equal(res.currentCredit, 51.0);
  assert.equal(res.status, '已达今日上限');
  assert.equal(res.finishedCount, 1);
});

test('parseAccountLog captures initial credit from startup progress line', t => {
  const dir = temporaryDirectory(t);
  const logFile = path.join(dir, 'run-startup.log');
  const content = `
[08:00:00] 当前进度: 学时/学分 48.25 (来源 MyStudyStat.CreditSum) | 已完成 10 门,未完成 2 门,累计 12 门
[08:00:01] ──────── 第 1 门 ────────
[08:00:01] 《课程一》 id=101 学分=1 进度=-1
[08:10:05]   ✔ 该课程已学完,学分已到账
[08:10:06]   当前学时/学分: 49.25 (来源 MyStudyStat.CreditSum)
[08:10:10] 结束。本次处理 1 门,学时/学分 49.25
`;
  fs.writeFileSync(logFile, content, 'utf8');
  const res = parseAccountLog(logFile);
  assert.equal(res.initialCredit, 48.25);
  assert.equal(res.currentCredit, 49.25);
  assert.equal(res.finishedCount, 1);
});

test('formatDashboard and formatSummaryReport produce clean formatted output', () => {
  const rows = [
    {
      user: '138＊＊＊＊1234',
      initial: '50.00',
      current: '55.00',
      gain: '+5.00',
      finished: 5,
      status: '已达今日上限',
      course: '',
    },
  ];

  const dashboard = formatDashboard(rows);
  assert.ok(dashboard.includes('138＊＊＊＊1234'));
  assert.ok(dashboard.includes('学分: 55.00'));
  assert.ok(dashboard.includes('完成: 5门'));

  const report = formatSummaryReport(rows, 3600);
  assert.ok(report.includes('# 干部网络学院学习总结报告'));
  assert.ok(report.includes('| **138＊＊＊＊1234** | 50.00 | **55.00** | **+5.00** | 5 门 | 已达今日上限 |'));
});
