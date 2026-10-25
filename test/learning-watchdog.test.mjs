import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporaryDirectory } from './fixtures.mjs';
import { resolveProfilePaths } from '../runtime-utils.mjs';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
const { shouldFinishBatch } = await import('../batch-learn.mjs');

const watchdog = await import('../learning-watchdog.mjs').catch(() => ({}));
const { evaluateAccount } = watchdog;
const now = new Date(2026, 9, 2, 12).getTime();
const missing = { known: true, learner: false, browser: false, mtime: now - 200_000, completedDay: null };

test('deferred monitor reserves ownership without ticking until explicitly started', async t => {
  const root = temporaryDirectory(t);
  let ticks = 0;
  const monitor = watchdog.startBatchMonitor({ root, accounts: [], deferStart: true,
    tickFn: async () => { ticks++; return { accounts: [] }; }, notify: async () => ({ ok: true }) });
  t.after(async () => { monitor.stop(); await monitor.finished; });
  monitor.wake();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ticks, 0, 'pre-launch monitor must never observe missing original children');
  assert.equal(watchdog.acquireMonitorLock(root), null);
  assert.equal(monitor.ownsLock, true);
  monitor.start(); monitor.start();
  await monitor.finished;
  assert.equal(ticks, 1);
  assert.equal(monitor.ownsLock, false);
});

test('deferred monitor never releases a replacement owners lock', async t => {
  const root = temporaryDirectory(t);
  const monitor = watchdog.startBatchMonitor({ root, accounts: [], deferStart: true,
    tickFn: async () => { assert.fail('lost owner must not tick'); }, notify: async () => { assert.fail('unexpected notify'); } });
  const file = path.join(root, 'logs/learning-watchdog.lock.json');
  const replacement = JSON.stringify({ pid: process.pid, token: 'replacement-owner' });
  fs.writeFileSync(file, replacement);
  assert.equal(monitor.ownsLock, false);
  assert.throws(() => monitor.start(), /MONITOR_LOCK_LOST/);
  monitor.stop(false); await monitor.finished;
  assert.equal(fs.readFileSync(file, 'utf8'), replacement);
});

test('recovery persists only selected keys and preserves non-daily launch policy', async t => {
  const root = temporaryDirectory(t);
  const accounts = [{ profile: 'selected', user: 'u', pass: 'private' }, { profile: 'outside', user: 'v', pass: 'private' }];
  const arm = watchdog.armLearningRun(root, now, { accounts: [accounts[0]], daily: false });
  assert.deepEqual(arm.accountKeys, [resolveProfilePaths(root, 'selected', 'u').key]);
  let calls = [];
  const health = await watchdog.tick({ root, accounts, now, observe: async () => Object.fromEntries(accounts.map(a => [resolveProfilePaths(root, a.profile, a.user).key, missing])), launch: async (a, r, spawn, policy) => calls.push([a.profile, policy.daily]) });
  assert.deepEqual(calls, [['selected', false]]);
  assert.equal(health.accounts[1].status, 'disarmed');
  assert(!JSON.stringify(arm).includes('private'));
});

test('key logs isolate colliding masks and ambiguous legacy logs are never claimed', async t => {
  const root = temporaryDirectory(t);
  const accounts = [{ profile: ['138', '1111', '1234'].join(''), user: ['138', '1111', '1234'].join('') }, { profile: ['138', '2222', '1234'].join(''), user: ['138', '2222', '1234'].join('') }];
  const keys = accounts.map(a => resolveProfilePaths(root, a.profile, a.user));
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(root, 'logs', `run-${keys[0].name}-2026-10-02T03-00-00.log`), '[11:00:00 +00:00:00] 已达站点【每日学时上限】\n');
  fs.writeFileSync(path.join(root, 'logs', `run-${keys[0].key}-2026-10-02T04-00-00.log`), '[12:00:00 +00:00:00] 当前进度: 学时/学分 12\n');
  const result = await watchdog.observeAccounts({ root, accounts, now, enumerate: async () => ({ known: true, processes: [] }) });
  assert.equal(result[keys[0].key].currentCredit, 12);
  assert.equal(result[keys[1].key].completedDay, null);
  assert.equal(result[keys[1].key].logFile, null);
});

test('owned child registry stops only live handles including recovery children and rejects late launches', async t => {
  const batch = await import('../batch-learn.mjs');
  assert.equal(typeof batch.createChildOwner, 'function');
  const owner = batch.createChildOwner();
  let killed = [];
  const child = id => Object.assign(new EventEmitter(), { pid: id, exitCode: null, signalCode: null, kill() { killed.push(id); } });
  const old = child(1), recovery = child(2), external = child(3);
  owner.add(old); owner.add(recovery);
  old.exitCode = 0; old.emit('exit', 0);
  owner.stop(); owner.stop();
  assert.deepEqual(killed, [2]);
  owner.add(child(4));
  assert.deepEqual(killed, [2, 4]);
  const root = temporaryDirectory(t), accounts = [{ profile: 'owned', user: 'u' }];
  watchdog.armLearningRun(root, now, { accounts });
  const key = resolveProfilePaths(root, 'owned', 'u').key;
  let launched = 0;
  await watchdog.tick({ root, accounts, now, owner, observe: async () => ({ [key]: missing }), launch: async () => { launched++; return { proc: external }; } });
  assert.equal(launched, 0);
});

test('explicit safety stops and normal completion do not recover or misreport suspected caps', async t => {
  const root = temporaryDirectory(t), accounts = [{ profile: 'stop', user: 'u' }];
  const paths = resolveProfilePaths(root, 'stop', 'u');
  fs.mkdirSync(path.join(root, 'logs'));
  const file = path.join(root, 'logs', `run-${paths.key}-2026-10-02T03-00-00.log`);
  for (const [text, status] of [
    ['LEARNING_STOP_REASON=manual-required', 'protected'], ['LEARNING_STOP_REASON=no-gain', 'protected'],
    ['播放页拒绝拖拽验证 —— 多半是已达【每日学时上限】', 'protected'],
    ['连续 2 门课都没有新增学时,疑似已达每日上限', 'protected'],
    ['LEARNING_STOP_REASON=completed', 'finished'], ['没有需要继续学习的视频课程了。', 'finished'],
    ['🎉 已达到目标: 50 ≥ 50', 'finished'], ['结束。本次处理 2 门,学时/学分 3', 'finished'],
    ['LEARNING_STOP_REASON=daily-limit', 'complete']
  ]) {
    fs.writeFileSync(file, `[11:00:00 +00:00:00] ${text}\n`);
    const observation = (await watchdog.observeAccounts({ root, accounts, now, enumerate: async () => ({ known: true, processes: [] }) }))[paths.key];
    const decision = evaluateAccount({ now, armed: true, observation });
    assert.equal(decision.status, status, text);
    assert.equal(decision.action, 'none');
    if (status === 'protected') assert.equal(observation.completedDay, null);
  }
});

test('terminal monitor retries failed delivery and drains its new alert before finishing', async t => {
  const root = temporaryDirectory(t);
  let calls = 0;
  const monitor = watchdog.startBatchMonitor({ root, accounts: [], retryDelayMs: 0,
    tickFn: async () => ({ accounts: [{ status: 'complete', learner: false }] }),
    notify: async () => {
      calls++;
      if (calls === 1) return { ok: false };
      const directory = path.join(root, 'logs/learning-alerts');
      assert(fs.readdirSync(directory).some(f => f.endsWith('.json')), 'retry must include notifier failure event');
      fs.mkdirSync(path.join(directory, 'sent'), { recursive: true });
      for (const f of fs.readdirSync(directory).filter(f => f.endsWith('.json'))) fs.renameSync(path.join(directory, f), path.join(directory, 'sent', f));
      return { ok: true };
    } });
  await monitor.finished;
  assert.equal(calls, 2);
  assert.equal(monitor.health.notifier.ok, true);
  assert.equal(monitor.health.notifier.pending, 0);
});

test('each monitor exception attempts bounded notification and exposes local undelivered health', async t => {
  const root = temporaryDirectory(t);
  let ticks = 0, deliveries = 0;
  const monitor = watchdog.startBatchMonitor({ root, accounts: [], retryDelayMs: 0,
    tickFn: async () => { ticks++; queueMicrotask(() => monitor.wake()); throw new Error('private-details'); },
    notify: async () => { deliveries++; return { ok: false }; } });
  await monitor.finished;
  assert.equal(ticks, 3);
  assert.equal(deliveries, 9);
  const health = JSON.parse(fs.readFileSync(path.join(root, 'logs/learning-watchdog-health.json')));
  assert.equal(health.notifier.error, 'UNDELIVERED_LOCAL');
  assert(health.notifier.pending > 0);
  assert(!JSON.stringify(health).includes('private-details'));
});

test('monitor owns newly recovered children but never attached existing processes; stopping fences in-flight observation', async t => {
  const root = temporaryDirectory(t), accounts = [{ profile: 'recovered', user: 'u' }];
  const key = resolveProfilePaths(root, 'recovered', 'u').key;
  watchdog.armLearningRun(root, now, { accounts });
  let kills = 0, releases;
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null, kill() { kills++; } });
  const ready = new Promise(resolve => { releases = resolve; });
  const monitor = watchdog.startBatchMonitor({ root, accounts, now, observe: async () => ({ [key]: missing }), launch: async () => ({ proc: child }), notify: async () => { releases(); return { ok: true }; }, retryDelayMs: 0 });
  await ready;
  monitor.stop();
  await monitor.finished;
  assert.equal(kills, 1);
  let resume, started;
  const observing = new Promise(resolve => { started = resolve; });
  const second = watchdog.startBatchMonitor({ root, accounts, now: now + 130_000, observe: async () => { started(); return await new Promise(resolve => { resume = resolve; }); }, launch: async () => { assert.fail('launch after stop'); }, notify: async () => ({ ok: true }), retryDelayMs: 0 });
  await observing;
  second.stop(); resume({ [key]: missing });
  await second.finished;
  assert.equal(kills, 1);
});

test('stop waits for in-flight recovery ownership before allowing batch exit', async () => {
  const batch = await import('../batch-learn.mjs');
  assert.equal(typeof batch.stopOwnedBatch, 'function');
  const owner = batch.createChildOwner();
  let release, exited = false, stopped = false, kills = 0;
  const monitor = { stop() { stopped = true; }, finished: new Promise(resolve => { release = resolve; }) };
  const stopping = batch.stopOwnedBatch(owner, monitor).then(() => { exited = true; });
  await Promise.resolve();
  assert.equal(stopped, true); assert.equal(exited, false);
  owner.add(Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() { kills++; } }));
  release(); await stopping;
  assert.equal(kills, 1); assert.equal(exited, true);
});

test('retryable-failure machine marker overrides generic end text and remains recoverable', async t => {
  const root = temporaryDirectory(t), accounts = [{ profile: 'retry-stop', user: 'u' }];
  const paths = resolveProfilePaths(root, accounts[0].profile, 'u');
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(root, 'logs', `run-${paths.key}-2026-10-02T03-00-00.log`), '[11:00:00 +00:00:00] 结束。本次处理 2 门,学时/学分 3\n[11:00:01 +00:00:01] LEARNING_STOP_REASON=retryable-failure\n');
  const observation = (await watchdog.observeAccounts({ root, accounts, now, enumerate: async () => ({ known: true, processes: [] }) }))[paths.key];
  assert.equal(evaluateAccount({ now, armed: true, observation }).action, 'restart');
  watchdog.recordLearnerExit(root, accounts[0], { now, identityAccounts: accounts });
  const events = fs.readdirSync(path.join(root, 'logs/learning-alerts')).map(f => fs.readFileSync(path.join(root, 'logs/learning-alerts', f), 'utf8')).join('');
  assert.match(events, /意外退出/);
});

test('explicit learning launch arms only the current local day without changing credentials', t => {
  assert.equal(typeof watchdog.armLearningRun, 'function', 'normal batch launch must arm its built-in recovery');
  const root = temporaryDirectory(t);
  const arm = watchdog.armLearningRun(root, now);
  assert.equal(arm.enabled, true);
  assert.equal(arm.expires_at, new Date(2026, 9, 3).toISOString());
  assert.equal(watchdog.isArmed(arm, now), true);
  assert.equal(watchdog.isArmed(arm, new Date(2026, 9, 3).getTime()), false);
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'logs/learning-watchdog-arm.json')));
  assert.deepEqual(stored, arm);
});

test('runtime identifies exact profile and Chrome directory without exposing commands or credentials', async t => {
  assert.equal(typeof watchdog.observeAccounts, 'function', 'safe runtime observer must exist');
  const root = temporaryDirectory(t);
  const accounts = [{ profile: 'account-A', user: 'user-A', pass: 'never-print-this' }];
  const paths = resolveProfilePaths(root, accounts[0].profile, accounts[0].user);
  const result = await watchdog.observeAccounts({ root, accounts, now, enumerate: async () => ({ known: true, processes: [
    { Name: 'node.exe', CommandLine: 'node auto-learn.mjs --profile=account-A-extra --pass=never-print-this' },
    { Name: 'chrome.exe', CommandLine: `chrome --user-data-dir="${paths.directory}"` },
  ] }) });
  assert.equal(result[paths.key].learner, false);
  assert.equal(result[paths.key].browser, true);
  assert(!JSON.stringify(result).includes('never-print-this'));
  const active = await watchdog.observeAccounts({ root, accounts, now, enumerate: async () => ({ known: true, processes: [
    { Name: 'node.exe', CommandLine: '"C:\\Program Files\\node.exe" "auto-learn.mjs" --profile "account-A" --pass=never-print-this' },
  ] }) });
  assert.equal(active[paths.key].learner, true);
  const unknown = await watchdog.observeAccounts({ root, accounts, now, enumerate: async () => { throw new Error('secret command'); } });
  assert.equal(unknown[paths.key].known, false);
  assert(!JSON.stringify(unknown).includes('secret command'));
});

test('log observation derives daily cap date from elapsed timestamps, not touched mtime or lifetime credit', async t => {
  const root = temporaryDirectory(t);
  const accounts = [{ profile: 'log-fixture', user: 'fixture', pass: 'secret' }];
  const paths = resolveProfilePaths(root, accounts[0].profile, accounts[0].user);
  fs.mkdirSync(path.join(root, 'logs'));
  const file = path.join(root, 'logs', `run-${paths.name}-2026-10-01T03-00-00.log`);
  fs.writeFileSync(file, '[11:00:00 +00:00:00] 当前进度: 学时/学分 99\n[11:01:00 +00:01:00] ▶ 开始播放《课》\n[11:02:00 +00:02:00] …播放中 01:00 / 10:00 (10.0%)\n[11:03:00 +00:03:00] 已达站点【每日学时上限】\n');
  fs.utimesSync(file, new Date(now), new Date(now));
  const observe = () => watchdog.observeAccounts({ root, accounts, now, enumerate: async () => ({ known: true, processes: [] }) });
  let value = (await observe())[paths.key];
  assert.equal(value.currentCredit, 99);
  assert.equal(value.progress, '01:00 / 10:00 (10.0%)');
  assert.equal(value.completedDay, '2026-10-01');
  assert.equal(evaluateAccount({ now, armed: true, observation: value }).action, 'restart');
  // A run starting yesterday can hit its cap AFTER local midnight.
  fs.appendFileSync(file, '[11:00:00 +24:00:00] 学员您好，您今天已累计学习5学时了\n');
  value = (await observe())[paths.key];
  assert.equal(value.completedDay, '2026-10-02');
  assert.equal(evaluateAccount({ now, armed: true, observation: value }).status, 'complete');
  assert.equal(value.evidence.at, new Date('2026-10-01T03:02:00Z').getTime());
});

test('durable tick reserves attempts before spawn, emits immutable deduped alerts and only confirms fresh playback', async t => {
  assert.equal(typeof watchdog.tick, 'function', 'durable tick must exist');
  const root = temporaryDirectory(t);
  const accounts = [{ profile: 'durable-fixture', user: 'fixture', pass: 'never-persist' }];
  const paths = resolveProfilePaths(root, accounts[0].profile, accounts[0].user);
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs);
  watchdog.armLearningRun(root, now, { accounts });
  let launches = 0, observation = { ...missing, logFile: 'old.log', logSize: 400, evidence: { file: 'old.log', offset: 10, at: now - 10_000 } };
  const observe = async () => ({ [paths.key]: observation });
  const launch = async () => {
    launches++;
    const disk = JSON.parse(fs.readFileSync(path.join(logs, 'learning-watchdog-state.json')));
    assert.equal(disk.accounts[paths.key].attempts.length, launches);
    return { pid: 42 };
  };
  const run = time => watchdog.tick({ root, accounts, now: time, observe, launch });
  let health = await run(now);
  assert.equal(launches, 1);
  assert.equal(health.armed, true);
  assert.equal(health.pid, process.pid);
  assert.equal(typeof health.timestamp, 'string');
  const alertDir = path.join(logs, 'learning-alerts');
  const messages = () => fs.readdirSync(alertDir).filter(x => x.endsWith('.json')).map(x => JSON.parse(fs.readFileSync(path.join(alertDir, x))).message);
  assert(!messages().some(x => x.includes('已恢复')));
  observation = { ...observation, learner: true, mtime: now + 30_000 };
  await run(now + 30_000);
  assert(!messages().some(x => x.includes('已恢复')));
  observation.evidence = { file: 'new.log', start: now, offset: 0, at: now + 60_000 };
  observation.logFile = 'new.log';
  await run(now + 60_000);
  assert.equal(messages().filter(x => x.includes('已恢复')).length, 1);
  await run(now + 90_000);
  assert.equal(messages().filter(x => x.includes('已恢复')).length, 1);
  observation.completedDay = '2026-10-02';
  await run(now + 120_000);
  await run(now + 150_000);
  assert.equal(messages().filter(x => x.includes('已达今日上限')).length, 1);
  for (const file of fs.readdirSync(alertDir).filter(x => x.endsWith('.json'))) {
    const event = JSON.parse(fs.readFileSync(path.join(alertDir, file)));
    assert.deepEqual(Object.keys(event).sort(), ['created_at', 'id', 'message']);
    assert.match(event.id, /^[a-zA-Z0-9_-]+$/);
    assert.equal(file, `${event.id}.json`);
  }
  assert(!fs.readFileSync(path.join(logs, 'learning-watchdog-state.json'), 'utf8').includes('never-persist'));
  assert(!fs.readFileSync(path.join(logs, 'learning-watchdog-health.json'), 'utf8').includes('never-persist'));
});

test('spawn adapter uses original daily learner, never a shell, and returns sanitized launch errors', async () => {
  assert.equal(typeof watchdog.launchAccount, 'function', 'safe spawn adapter must exist');
  const account = { profile: 'spawn-fixture', user: 'fixture', pass: 'special" secret & ' };
  const child = new EventEmitter();
  child.pid = 123;
  const launch = watchdog.launchAccount(account, 'D:/fixture', (executable, args, options) => {
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, [path.join('D:/fixture', 'auto-learn.mjs'), '--profile=spawn-fixture', '--user=fixture', `--pass=${account.pass}`, '--newest-single', '--daily']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.stdio, 'ignore');
    assert.notEqual(options.shell, true);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  assert.deepEqual(await launch, { pid: 123, proc: child });
  await assert.rejects(watchdog.launchAccount(account, 'D:/fixture', () => { throw new Error(account.pass); }), /^Error: LEARNER_LAUNCH_FAILED$/);
});

test('duplicate monitor lock is refused and a crashed PID lock is recovered and released', t => {
  assert.equal(typeof watchdog.acquireMonitorLock, 'function', 'single-monitor lock must exist');
  const root = temporaryDirectory(t);
  const lock = watchdog.acquireMonitorLock(root);
  assert.equal(typeof lock.release, 'function');
  assert.equal(watchdog.acquireMonitorLock(root), null);
  lock.release();
  const file = path.join(root, 'logs', 'learning-watchdog.lock.json');
  fs.writeFileSync(file, JSON.stringify({ pid: 99999999, token: 'crashed' }));
  const recovered = watchdog.acquireMonitorLock(root);
  assert(recovered);
  assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid);
  recovered.release();
  assert(!fs.existsSync(file));
});

test('dry-run never writes, launches or notifies; expiry preserves active learners and retry state survives ticks', async t => {
  const root = temporaryDirectory(t);
  const accounts = [{ profile: 'safety-fixture', user: 'fixture', pass: 'secret' }];
  const paths = resolveProfilePaths(root, accounts[0].profile, accounts[0].user);
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs);
  const armFile = path.join(logs, 'learning-watchdog-arm.json');
  watchdog.armLearningRun(root, now, { accounts });
  let launches = 0;
  const launch = async () => { launches++; };
  let value = missing;
  const observe = async () => ({ [paths.key]: value });
  const before = fs.readdirSync(logs).map(f => [f, fs.readFileSync(path.join(logs, f), 'utf8')]);
  await watchdog.tick({ root, accounts, now, dryRun: true, observe, launch });
  assert.deepEqual(fs.readdirSync(logs).map(f => [f, fs.readFileSync(path.join(logs, f), 'utf8')]), before);
  assert.equal(launches, 0);
  for (const offset of [0, 120_000, 240_000, 360_000]) await watchdog.tick({ root, accounts, now: now + offset, observe, launch });
  assert.equal(launches, 3);
  const health = JSON.parse(fs.readFileSync(path.join(logs, 'learning-watchdog-health.json')));
  assert.equal(health.accounts[0].status, 'retry-limit');
  value = { ...missing, known: false };
  await watchdog.tick({ root, accounts, now: now + 400_000, observe, launch });
  assert.equal(launches, 3);
  value = { ...missing, learner: true, mtime: now };
  const nextDay = new Date(2026, 9, 3).getTime();
  const expired = await watchdog.tick({ root, accounts, now: nextDay, observe, launch });
  assert.equal(expired.armed, false);
  assert.equal(expired.accounts[0].learner, true);
  value = missing;
  await watchdog.tick({ root, accounts, now: nextDay + 30_000, observe, launch });
  assert.equal(launches, 3);
  for (const arm of [{ enabled: true, expires_at: new Date(2026, 9, 4).toISOString() }, { enabled: false, expires_at: new Date(2026, 9, 3).toISOString() }, { enabled: true, expires_at: 'invalid' }]) assert.equal(watchdog.isArmed(arm, now), false);
});

test('notifier uses hidden execFile with timeout and sanitizes failures; in-process monitor stops at terminal states', async t => {
  assert.equal(typeof watchdog.notifyGateway, 'function', 'gateway notifier hook must exist');
  let calls = 0;
  const success = await watchdog.notifyGateway('D:/fixture', async (exe, args, options) => {
    calls++;
    assert.match(exe, /python\.exe$/);
    assert.match(args[0], /learning_gateway_alerts\.py$/);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 20_000);
    return { stdout: 'do not print this' };
  });
  assert.equal(success.ok, true);
  assert.equal(calls, 1);
  const failure = await watchdog.notifyGateway('D:/fixture', async () => { throw new Error('command with password'); });
  assert.deepEqual(failure, { ok: false, error: 'NOTIFIER_FAILED' });
  const root = temporaryDirectory(t);
  let notified = 0;
  const monitor = watchdog.startBatchMonitor({ root, accounts: [], tickFn: async () => ({ accounts: [{ status: 'complete', learner: false }] }), notify: async () => { notified++; return { ok: true }; } });
  await monitor.finished;
  assert.equal(monitor.done, true);
  assert.equal(notified, 1);
  assert(!fs.existsSync(path.join(root, 'logs', 'learning-watchdog.lock.json')));
});

test('batch cannot finish while its in-process recovery monitor is still running', () => {
  assert.equal(typeof shouldFinishBatch, 'function', 'batch termination must account for supervision');
  const exited = [{ proc: { exitCode: 1 } }];
  assert.equal(shouldFinishBatch(exited, { done: false }), false);
  assert.equal(shouldFinishBatch(exited, { done: true }), true);
  assert.equal(shouldFinishBatch([{ proc: { exitCode: null } }], { done: true }), false);
  assert.equal(shouldFinishBatch(exited, null), true);
  assert.equal(shouldFinishBatch(exited, { done: true }, { size: 1 }), false, 'live recovery child still belongs to batch');
  assert.equal(shouldFinishBatch([{ proc: { exitCode: null, signalCode: 'SIGTERM' } }], { done: true }, { size: 0 }), true);
  const source = fs.readFileSync(new URL('../batch-learn.mjs', import.meta.url), 'utf8');
  assert.match(source, /startBatchMonitor\(/);
});

test('dry-run exercises real observation logic with injected process enumeration without reading host processes', async t => {
  const root = temporaryDirectory(t);
  fs.writeFileSync(path.join(root, 'accounts.local.json'), JSON.stringify([{ profile: 'cli-fixture', user: 'fixture', pass: 'CLI_PRIVATE_SECRET' }]));
  const accounts = watchdog.loadWatchdogAccounts(root);
  const health = await watchdog.tick({ root, accounts, dryRun: true, observe: options => watchdog.observeAccounts({ ...options, enumerate: async () => ({ known: true, processes: [] }) }) });
  const result = { stdout: JSON.stringify(health) };
  assert.equal(health.dry_run, true);
  assert.equal(health.accounts.length, 1);
  assert.equal(health.armed, false);
  assert.deepEqual(fs.readdirSync(root), ['accounts.local.json']);
  assert(!result.stdout.includes('CLI_PRIVATE_SECRET'));
  fs.writeFileSync(path.join(root, 'accounts.local.json'), JSON.stringify(Array.from({ length: 4 }, (_, i) => ({ profile: `account-${i}`, user: 'fixture', pass: 'CLI_PRIVATE_SECRET' }))));
  const rejected = spawnSync(process.execPath, [path.resolve('learning-watchdog.mjs'), '--once', '--dry-run', '--root', root], { windowsHide: true, timeout: 25_000, encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert(!rejected.stderr.includes('CLI_PRIVATE_SECRET'));
});

test('child exit hook durably records an unexpected exit immediately without treating daily cap as failure', t => {
  assert.equal(typeof watchdog.recordLearnerExit, 'function', 'integrated child exit hook must exist');
  const root = temporaryDirectory(t);
  const account = { profile: 'exit-fixture', user: 'fixture', pass: 'not-in-alert' };
  watchdog.recordLearnerExit(root, account, { code: 1, now });
  const directory = path.join(root, 'logs', 'learning-alerts');
  const alerts = () => fs.readdirSync(directory).filter(f => f.endsWith('.json'));
  assert.equal(alerts().length, 1);
  assert.match(fs.readFileSync(path.join(directory, alerts()[0]), 'utf8'), /意外退出/);
  assert(!fs.readFileSync(path.join(directory, alerts()[0]), 'utf8').includes('not-in-alert'));
  const paths = resolveProfilePaths(root, account.profile, account.user);
  fs.writeFileSync(path.join(root, 'logs', `run-${paths.name}-2026-10-02T03-00-00.log`), '[11:01:00 +00:01:00] 已达站点【每日学时上限】\n');
  watchdog.recordLearnerExit(root, account, { code: 0, now: now + 1, identityAccounts: [account] });
  assert.equal(alerts().length, 2);
  const all = alerts().map(f => fs.readFileSync(path.join(directory, f), 'utf8')).join('\n');
  assert.match(all, /已达今日上限/);
  const source = fs.readFileSync(new URL('../batch-learn.mjs', import.meta.url), 'utf8');
  assert.match(source, /recordLearnerExit/);
  assert.match(source, /uncaughtExceptionMonitor/);
});

test('policy reports stale progress, honors same-day completion, cooldown and rolling retry ceiling', () => {
  assert.equal(evaluateAccount({ now, armed: true, observation: { ...missing, learner: true } }).status, 'stale');
  assert.equal(evaluateAccount({ now, armed: true, observation: { ...missing, learner: true, mtime: now - 180_000 } }).status, 'active');
  assert.equal(evaluateAccount({ now, armed: true, observation: { ...missing, completedDay: '2026-10-02' } }).status, 'complete');
  assert.equal(evaluateAccount({ now, armed: true, observation: { ...missing, completedDay: '2026-10-01' } }).action, 'restart');
  assert.equal(evaluateAccount({ now, armed: true, observation: missing, state: { attempts: [now - 119_999] } }).status, 'cooldown');
  assert.equal(evaluateAccount({ now, armed: true, observation: missing, state: { attempts: [now - 120_000] } }).action, 'restart');
  assert.equal(evaluateAccount({ now, armed: true, observation: missing, state: { attempts: [now - 900_000, now - 600_000, now - 300_000] } }).status, 'retry-limit');
  assert.equal(evaluateAccount({ now, armed: true, observation: missing, state: { attempts: [now - 1_800_001, now - 600_000, now - 300_000] } }).action, 'restart');
});

test('missing learner restarts only with an absent matching browser and valid observation', () => {
  assert.equal(typeof watchdog.evaluateAccount, 'function', 'restart policy must exist');
  assert.equal(watchdog.evaluateAccount({ now, armed: true, observation: missing }).action, 'restart');
  for (const observation of [
    { ...missing, learner: true },
    { ...missing, browser: true },
    { ...missing, known: false },
  ]) assert.notEqual(watchdog.evaluateAccount({ now, armed: true, observation }).action, 'restart');
  assert.equal(watchdog.evaluateAccount({ now, armed: true, observation: { ...missing, browser: true } }).status, 'browser-blocked');
  assert.equal(watchdog.evaluateAccount({ now, armed: false, observation: missing }).status, 'disarmed');
});
