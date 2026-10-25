import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporaryDirectory } from './fixtures.mjs';
import { notifyGateway, alertPythonCandidates } from '../learning-watchdog.mjs';

test('alert interpreter candidates prefer the configured path and include the live install environments', t => {
  const home = temporaryDirectory(t);
  const older = path.join(home, 'installs', 'install-a', 'environments', 'env-old', 'venv', 'Scripts');
  const newer = path.join(home, 'installs', 'install-a', 'environments', 'env-new', 'venv', 'Scripts');
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(older, 'python.exe'), '');
  fs.writeFileSync(path.join(newer, 'python.exe'), '');
  fs.utimesSync(path.join(older, 'python.exe'), new Date(1000), new Date(1000));
  fs.utimesSync(path.join(newer, 'python.exe'), new Date(2000), new Date(2000));
  const candidates = alertPythonCandidates(home, { LEARNING_ALERT_PYTHON: 'C:/configured/python.exe' });
  assert.equal(candidates[0], 'C:/configured/python.exe');
  assert(candidates.includes(path.join(newer, 'python.exe')));
  assert(candidates.includes(path.join(older, 'python.exe')));
  assert(candidates.indexOf(path.join(newer, 'python.exe')) < candidates.indexOf(path.join(older, 'python.exe')));
});

test('notifier falls back to another installed interpreter when the configured one is gone', async () => {
  const missing = 'C:/stale/environments/gone/venv/Scripts/python.exe';
  const working = 'C:/stale/environments/live/venv/Scripts/python.exe';
  const attempted = [];
  const result = await notifyGateway('D:/fixture', async (exe, args, options) => {
    attempted.push(exe);
    assert.match(args[0], /learning_gateway_alerts\.py$/);
    assert.equal(options.windowsHide, true);
    if (exe === missing) throw new Error('ENOENT --pass=DO_NOT_LOG');
    return { stdout: 'DO_NOT_LOG' };
  }, { candidates: [missing, working] });
  assert.deepEqual(attempted, [missing, working]);
  assert.deepEqual(result, { ok: true });
  assert(!JSON.stringify(result).includes('DO_NOT_LOG'));
});

test('notifier reports a sanitized failure when every interpreter candidate fails', async () => {
  let calls = 0;
  const result = await notifyGateway('D:/fixture', async () => { calls++; throw new Error('DO_NOT_LOG'); }, { candidates: ['C:/a/python.exe', 'C:/b/python.exe'] });
  assert.equal(calls, 2);
  assert.deepEqual(result, { ok: false, error: 'NOTIFIER_FAILED' });
});
