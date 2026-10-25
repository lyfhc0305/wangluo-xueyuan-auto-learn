import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporaryDirectory } from './fixtures.mjs';
import { enumerateProcesses } from '../learning-watchdog.mjs';

const complete = [{ Name: 'node.exe', ProcessId: 123, CommandLine: 'node auto-learn.mjs --profile=test --pass=DO_NOT_LOG' }];
const response = processes => ({ stdout: JSON.stringify({ processes }) });

test('process observer retries transient missing command lines without dropping unknown processes', async () => {
  let calls = 0, waits = 0;
  const snapshot = await enumerateProcesses({ platform: 'win32', exec: async (file, args, options) => {
    calls++;
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 15_000);
    return response(calls === 1 ? [...complete, { Name: 'chrome.exe', ProcessId: 456, CommandLine: null }] : complete);
  }, delay: async ms => { waits++; assert.equal(ms, 250); } });
  assert.equal(calls, 2);
  assert.equal(waits, 1);
  assert.equal(snapshot.known, true);
  assert.deepEqual(snapshot.processes, complete);
  assert.equal(snapshot.diagnostic.attempts, 2);
  assert.equal(snapshot.diagnostic.failures[0].error, 'INCOMPLETE_PROCESS_OBSERVATION');
  assert.deepEqual(snapshot.diagnostic.failures[0].incomplete, [{ name: 'chrome.exe', pid: 456 }]);
  assert(!JSON.stringify(snapshot.diagnostic).includes('DO_NOT_LOG'));
});

test('observer classifies query failures without persisting exception messages or raw output', async () => {
  for (const [failure, expected] of [
    [Object.assign(new Error('DO_NOT_LOG --pass=secret'), { killed: true }), 'PROCESS_QUERY_TIMEOUT'],
    [Object.assign(new Error('DO_NOT_LOG'), { code: 'ENOENT' }), 'POWERSHELL_NOT_FOUND'],
    [Object.assign(new Error('DO_NOT_LOG'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'PROCESS_QUERY_OUTPUT_LIMIT'],
    [new Error('DO_NOT_LOG'), 'PROCESS_QUERY_FAILED'],
    [{ stdout: 'DO_NOT_LOG invalid JSON' }, 'INVALID_PROCESS_JSON'],
    [{ stdout: JSON.stringify({ processes: null, secret: 'DO_NOT_LOG' }) }, 'INVALID_PROCESS_LIST'],
  ]) {
    let calls = 0;
    const result = await enumerateProcesses({ platform: 'win32', exec: async () => { calls++; if (failure instanceof Error) throw failure; return failure; }, delay: async () => {} });
    assert.equal(calls, 3);
    assert.equal(result.known, false);
    assert.equal(result.error, expected);
    assert(!JSON.stringify(result).includes('DO_NOT_LOG'));
    assert.equal(result.processes, undefined);
  }
});

test('diagnostics whitelist injected observer details and record recovered retry incidents without alerting', async t => {
  const { observeAccounts, tick, armLearningRun } = await import('../learning-watchdog.mjs');
  const root = temporaryDirectory(t), accounts = [{ profile: 'test', user: 'fixture' }];
  const now = new Date(2026, 9, 4, 12).getTime();
  armLearningRun(root, now, { accounts });
  const diagnostic = { attempts: 2, elapsedMs: 99, secret: 'DO_NOT_LOG', failures: [{ error: 'INCOMPLETE_PROCESS_OBSERVATION', elapsedMs: 20, command: 'DO_NOT_LOG', incomplete: [{ name: 'chrome.exe', pid: 456, commandLine: 'DO_NOT_LOG' }] }] };
  const observe = () => observeAccounts({ root, accounts, now, enumerate: async () => ({ known: true, processes: complete, diagnostic }) });
  const before = fs.readdirSync(path.join(root, 'logs'));
  const dry = await tick({ root, accounts, now, dryRun: true, observe, launch: async () => assert.fail('dry-run spawn') });
  assert.deepEqual(fs.readdirSync(path.join(root, 'logs')), before);
  assert.equal(dry.accounts[0].status, 'active');
  assert(!JSON.stringify(dry).includes('DO_NOT_LOG'));
  await tick({ root, accounts, now, observe, launch: async () => assert.fail('active learner spawn') });
  const log = fs.readFileSync(path.join(root, 'logs/learning-observer-diagnostics.jsonl'), 'utf8');
  assert(!log.includes('DO_NOT_LOG'));
  assert.equal(JSON.parse(log).accounts[0].observer.attempts, 2);
  const messages = fs.readdirSync(path.join(root, 'logs/learning-alerts')).map(n => fs.readFileSync(path.join(root, 'logs/learning-alerts', n), 'utf8')).join('');
  assert(!messages.includes('观察失败'));
});

test('persistent observation failure is bounded, fail-closed, diagnosed and alerted only after consecutive ticks', async t => {
  const { observeAccounts, tick, armLearningRun } = await import('../learning-watchdog.mjs');
  const { resolveProfilePaths } = await import('../runtime-utils.mjs');
  const root = temporaryDirectory(t), accounts = [{ profile: 'test', user: 'fixture', pass: 'DO_NOT_LOG' }];
  const now = new Date(2026, 9, 4, 12).getTime();
  armLearningRun(root, now, { accounts });
  let calls = 0;
  const broken = await enumerateProcesses({ platform: 'win32', exec: async () => { calls++; return response([{ Name: 'chrome.exe', ProcessId: 456, CommandLine: null }]); }, delay: async () => {} });
  assert.equal(calls, 3);
  assert.equal(broken.known, false);
  assert.equal(broken.error, 'INCOMPLETE_PROCESS_OBSERVATION');
  assert.equal(broken.processes, undefined, 'never return a partial snapshot as safe absence');
  const observe = () => observeAccounts({ root, accounts, now, enumerate: async () => broken });
  const key = resolveProfilePaths(root, 'test', 'fixture').key;
  const value = (await observe())[key];
  assert.equal(value.known, false);
  assert.equal(value.error, 'INCOMPLETE_PROCESS_OBSERVATION');
  assert.equal(value.observer.attempts, 3);
  const launches = [];
  const run = offset => tick({ root, accounts, now: now + offset, observe, launch: async () => launches.push('unsafe') });
  const alerts = () => fs.readdirSync(path.join(root, 'logs/learning-alerts')).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(root, 'logs/learning-alerts', n))).message);
  await run(0);
  assert.equal(alerts().filter(m => m.includes('观察失败')).length, 0, 'a single failed tick is diagnostic only');
  await run(30_000);
  assert.equal(alerts().filter(m => m.includes('观察失败')).length, 1);
  await run(60_000);
  assert.equal(alerts().filter(m => m.includes('观察失败')).length, 1, 'same incident is deduped');
  assert.equal(launches.length, 0);
  const health = JSON.parse(fs.readFileSync(path.join(root, 'logs/learning-watchdog-health.json')));
  assert.equal(health.accounts[0].error, 'INCOMPLETE_PROCESS_OBSERVATION');
  assert.equal(health.accounts[0].observer.attempts, 3);
  assert.equal(health.accounts[0].unknownTicks, 3);
  assert(!JSON.stringify(health).includes('DO_NOT_LOG'));
  const diagnosticLines = fs.readFileSync(path.join(root, 'logs/learning-observer-diagnostics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(diagnosticLines.length, 3);
  assert.equal(diagnosticLines[0].accounts[0].observer.failures[0].incomplete[0].pid, 456);
  const recovered = () => observeAccounts({ root, accounts, now: now + 90_000, enumerate: async () => ({ known: true, processes: complete }) });
  await tick({ root, accounts, now: now + 90_000, observe: recovered, launch: async () => assert.fail('active learner must not spawn') });
  await run(120_000);
  assert.equal(alerts().filter(m => m.includes('观察失败')).length, 1, 'successful observation resets the consecutive threshold');
});

test('monitor does not combine different accounts transient failures into a premature silent shutdown', async t => {
  const { startBatchMonitor, armLearningRun } = await import('../learning-watchdog.mjs');
  const { resolveProfilePaths } = await import('../runtime-utils.mjs');
  const root = temporaryDirectory(t), accounts = ['A', 'B', 'C'].map(profile => ({ profile, user: 'fixture' }));
  const now = new Date(2026, 9, 4, 12).getTime();
  armLearningRun(root, now, { accounts });
  let calls = 0, monitor;
  const messages = [];
  monitor = startBatchMonitor({ root, accounts, now, retryDelayMs: 0,
    observe: async () => {
      const failedIndex = calls++;
      return Object.fromEntries(accounts.map((account, index) => [resolveProfilePaths(root, account.profile, account.user).key,
        index === failedIndex ? { known: false, error: 'LOG_OBSERVER_FAILED' } : { known: true, learner: false, browser: false, completedDay: '2026-10-04' }]));
    },
    launch: async () => assert.fail('never launch unknown or completed learner'),
    notify: async () => {
      const directory = path.join(root, 'logs/learning-alerts');
      fs.mkdirSync(path.join(directory, 'sent'), { recursive: true });
      for (const file of fs.readdirSync(directory).filter(n => n.endsWith('.json'))) {
        messages.push(JSON.parse(fs.readFileSync(path.join(directory, file))).message);
        fs.renameSync(path.join(directory, file), path.join(directory, 'sent', file));
      }
      queueMicrotask(() => monitor.wake());
      return { ok: true };
    }
  });
  t.after(async () => { monitor.stop(false); await monitor.finished; });
  await monitor.finished;
  assert.equal(calls, 4, 'A/B/C each failed only once; monitoring must continue to confirmed completion');
  assert(monitor.health.accounts.every(a => a.status === 'complete'));
  assert.equal(messages.filter(m => m.includes('观察失败')).length, 0);
});

test('monitor still drains the persistent unknown alert and stops after three failures of the same account', async t => {
  const { startBatchMonitor, armLearningRun } = await import('../learning-watchdog.mjs');
  const { resolveProfilePaths } = await import('../runtime-utils.mjs');
  const root = temporaryDirectory(t), accounts = [{ profile: 'unknown', user: 'fixture' }];
  const now = new Date(2026, 9, 4, 12).getTime();
  armLearningRun(root, now, { accounts });
  let calls = 0, monitor;
  const messages = [];
  monitor = startBatchMonitor({ root, accounts, now, retryDelayMs: 0,
    observe: async () => { calls++; return { [resolveProfilePaths(root, 'unknown', 'fixture').key]: { known: false, error: 'PROCESS_QUERY_TIMEOUT' } }; },
    launch: async () => assert.fail('unknown cannot launch'),
    notify: async () => {
      const directory = path.join(root, 'logs/learning-alerts');
      fs.mkdirSync(path.join(directory, 'sent'), { recursive: true });
      for (const file of fs.readdirSync(directory).filter(n => n.endsWith('.json'))) {
        messages.push(JSON.parse(fs.readFileSync(path.join(directory, file))).message);
        fs.renameSync(path.join(directory, file), path.join(directory, 'sent', file));
      }
      queueMicrotask(() => monitor.wake());
      return { ok: true };
    }
  });
  t.after(async () => { monitor.stop(false); await monitor.finished; });
  await monitor.finished;
  assert.equal(calls, 3);
  assert.equal(monitor.health.accounts[0].unknownTicks, 3);
  assert.equal(messages.filter(m => m.includes('观察失败')).length, 1);
  assert.equal(monitor.health.notifier.pending, 0);
});
