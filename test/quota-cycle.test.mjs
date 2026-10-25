import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporaryDirectory } from './fixtures.mjs';
import { resolveProfilePaths } from '../runtime-utils.mjs';
import { observeAccounts, evaluateAccount, armLearningRun, tick, recordLearnerExit, startBatchMonitor } from '../learning-watchdog.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { generateDashboard } from '../batch-learn.mjs';

const now = new Date(2026, 9, 24, 15).getTime();
const account = { profile: 'quota-fixture', user: 'fixture' };
function fixture(t) {
  const root = temporaryDirectory(t);
  fs.mkdirSync(path.join(root, 'logs'));
  const key = resolveProfilePaths(root, account.profile, account.user).key;
  const write = (stamp, text) => fs.writeFileSync(path.join(root, 'logs', `run-${key}-${stamp}.log`), text);
  const observe = () => observeAccounts({ root, accounts: [account], now, enumerate: async () => ({ known: true, processes: [] }) });
  return { root, key, write, observe };
}

test('legacy midnight alert cannot suppress a new quota-cycle completion notification', async t => {
  const { root, key, write } = fixture(t);
  const alerts = path.join(root, 'logs/learning-alerts');
  fs.mkdirSync(path.join(alerts, 'sent'), { recursive: true });
  const legacyId = 'learning-' + createHash('sha256').update(`${key}:complete:2026-10-24`).digest('hex').slice(0,32);
  fs.writeFileSync(path.join(alerts, 'sent', legacyId + '.json'), JSON.stringify({ id:legacyId, message:'legacy midnight cap' }));
  write('2026-10-24T06-00-00', '[14:00:00 +00:00:00] LEARNING_STOP_REASON=daily-limit\n');
  recordLearnerExit(root, account, { now, identityAccounts: [account] });
  const pending = fs.readdirSync(alerts).filter(f=>f.endsWith('.json'));
  assert.equal(pending.length, 1);
  recordLearnerExit(root, account, { now: now+1000, identityAccounts: [account] });
  assert.equal(fs.readdirSync(alerts).filter(f=>f.endsWith('.json')).length, 1);
});

test('real fixture child exit is notified and recovery requires fresh playback evidence', async t => {
  const { root, key } = fixture(t);
  const time = Date.now();
  armLearningRun(root, time, { accounts: [account] });
  const failed = spawn(process.execPath, ['-e', 'process.exit(1)'], { windowsHide: true, stdio: 'ignore' });
  const [code] = await once(failed, 'close');
  assert.equal(code, 1);
  recordLearnerExit(root, account, { now: time, identityAccounts: [account] });
  let child, launches = 0;
  const stamp = new Date(time).toISOString().slice(0,19).replaceAll(':','-');
  const logfile = path.join(root, 'logs', `run-${key}-${stamp}-recovered.log`);
  const launch = async () => {
    launches++;
    child = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "[00:00:00 +00:00:00] ▶ 开始播放《fixture》\\n"); console.log("ready"); setTimeout(()=>{},10000)', logfile], { windowsHide: true, stdio: ['ignore','pipe','ignore'] });
    const closed = once(child, 'close');
    t.after(async () => { if (child.exitCode === null) child.kill(); await closed; });
    await once(child.stdout, 'data');
    return { pid: child.pid, proc: child };
  };
  const observe = () => observeAccounts({ root, accounts: [account], now: time,
    enumerate: async () => ({ known: true, processes: child && child.exitCode === null ? [{ Name: 'node.exe', CommandLine: `node.exe auto-learn.mjs --profile=${account.profile}` }] : [] }) });
  const initial = await tick({ root, accounts: [account], now: time, observe, launch });
  assert.equal(initial.accounts[0].status, 'restart-pending');
  const health = await tick({ root, accounts: [account], now: time + 1000, observe, launch });
  assert.equal(health.accounts[0].status, 'active');
  assert.equal(launches, 1);
  const messages = fs.readdirSync(path.join(root, 'logs/learning-alerts')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(root, 'logs/learning-alerts', f))).message);
  assert(messages.some(m => m.includes('意外退出')));
  assert(messages.some(m => m.includes('学习已恢复')));
});

test('active monitor relinquishes a replaced lock without stopping learners or deleting successor lock', async t => {
  const root = temporaryDirectory(t);
  let ready, kills = 0, ticks = 0;
  const observed = new Promise(resolve => { ready = resolve; });
  const monitor = startBatchMonitor({ root, accounts: [account], owner: { stop() { kills++; } },
    tickFn: async () => { ticks++; return { accounts: [{ status: 'active', learner: true }] }; },
    notify: async () => { ready(); return { ok: true }; } });
  t.after(async () => { monitor.stop(false); await monitor.finished; });
  await observed;
  await new Promise(resolve => setImmediate(resolve));
  const lockFile = path.join(root, 'logs/learning-watchdog.lock.json');
  const successor = JSON.stringify({ pid: process.pid, token: 'maintenance-fence' });
  fs.writeFileSync(lockFile, successor);
  monitor.wake();
  await monitor.finished;
  assert.equal(ticks, 1);
  assert.equal(kills, 0);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), successor);
});

test('explicit daily-limit marker blocks the same quota cycle across midnight, then expires', async t => {
  const { root, key, write } = fixture(t);
  write('2026-10-23T15-30-00', '[23:30:00 +00:00:00] LEARNING_STOP_REASON=daily-limit\n');
  const observeAt = async time => (await observeAccounts({ root, accounts: [account], now: time, enumerate: async () => ({ known: true, processes: [] }) }))[key];
  const midnight = new Date(2026, 9, 24, 1).getTime();
  const observation = await observeAt(midnight);
  assert.equal(observation.quotaBlocked, true);
  assert.equal(evaluateAccount({ now: midnight, armed: true, observation }).status, 'complete');
  recordLearnerExit(root, account, { now: midnight, identityAccounts: [account] });
  const messages = fs.readdirSync(path.join(root, 'logs/learning-alerts')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(root, 'logs/learning-alerts', f))).message);
  assert(messages.some(m => m.includes('已达今日上限')));
  const daytime = await observeAt(now);
  assert.equal(daytime.quotaBlocked, false);
  assert.equal(evaluateAccount({ now, armed: true, observation: daytime }).action, 'restart');
});

test('dashboard and exit notifications use current quota evidence instead of midnight historical cap', async t => {
  const { root, key, write, observe } = fixture(t);
  write('2026-10-23T16-00-00', '[00:51:00 +00:51:00] 已达站点【每日学时上限】\n');
  // Even before any new site reply, the old quota cycle must not block the daytime run.
  const observation = (await observe())[key];
  assert.equal(observation.quotaBlocked, false);
  assert.equal(evaluateAccount({ now, armed: true, observation, state: { completedDay: '2026-10-24' } }).action, 'restart');
  const rows = await generateDashboard([account], { root, now, observe });
  assert(!rows[0].status.includes('已达今日上限'));
  recordLearnerExit(root, account, { now, identityAccounts: [account] });
  const messages = fs.readdirSync(path.join(root, 'logs/learning-alerts')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(root, 'logs/learning-alerts', f))).message);
  assert(messages.some(m => m.includes('意外退出')));
  assert(!messages.some(m => m.includes('已达今日上限')));
});

test('later platform acceptance overrides both natural-day cap history and persisted complete state', async t => {
  const { root, key, write, observe } = fixture(t);
  write('2026-10-23T16-00-00', '[00:51:00 +00:51:00] 已达站点【每日学时上限】\n');
  write('2026-10-24T06-00-00', '[14:00:00 +00:00:00] 选课返回: Type=1 Message=成功添加了1条记录\n[14:00:01 +00:00:01] ▶ 开始播放《新课》\n');
  armLearningRun(root, now, { accounts: [account] });
  fs.writeFileSync(path.join(root, 'logs/learning-watchdog-state.json'), JSON.stringify({ version: 1, accounts: { [key]: { completedDay: '2026-10-24', attempts: [], incident: 0 } } }));
  const observation = (await observe())[key];
  assert.equal(observation.quotaBlocked, false);
  assert.equal(evaluateAccount({ now, armed: true, observation, state: { completedDay: '2026-10-24' } }).action, 'restart');
  let launches = 0;
  const health = await tick({ root, accounts: [account], now, observe, launch: async () => { launches++; return { pid: 42 }; } });
  assert.equal(launches, 1);
  assert.equal(health.accounts[0].status, 'restart-pending');
  const state = JSON.parse(fs.readFileSync(path.join(root, 'logs/learning-watchdog-state.json')));
  assert.equal(state.accounts[key].completedDay, undefined);
  const pending = state.accounts[key].pending;
  const recovered = { ...observation, learner: true, mtime: now + 30_000, evidence: { file: 'new-run.log', start: now, at: now + 30_000, offset: 0 } };
  await tick({ root, accounts: [account], now: now + 30_000, observe: async () => ({ [key]: recovered }), launch: async () => assert.fail('no duplicate launch') });
  const messages = fs.readdirSync(path.join(root, 'logs/learning-alerts')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(root, 'logs/learning-alerts', f))).message);
  assert(messages.some(m => m.includes('学习已恢复')));
  assert.equal(pending.launchedAt, now);
});
