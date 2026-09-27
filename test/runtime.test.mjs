import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveProfilePaths, isPermanentFailure, nextNoGainStreak, launchProfileBrowser } from '../runtime-utils.mjs';
import { fetchMyCourses, playCourse } from '../auto-learn.mjs';

const root = path.resolve('profile-fixture');

test('same visible phone mask still has separate browser, state and log keys', () => {
  const first = resolveProfilePaths(root, '13800001234');
  const second = resolveProfilePaths(root, '13899991234');
  assert.equal(first.name, second.name);
  for (const field of ['key', 'directory', 'stateFile']) assert.notEqual(first[field], second[field]);
  assert(!first.directory.includes('13800001234'));
  assert.deepEqual(first, resolveProfilePaths(root, '13800001234'));
});

test('legacy masked accounts recover identity from user; ambiguous masks fail', () => {
  const original = resolveProfilePaths(root, '13800001234');
  assert.deepEqual(resolveProfilePaths(root, '138＊＊＊＊1234', '13800001234'), original);
  assert.deepEqual(resolveProfilePaths(root, '138****1234', '13800001234'), original);
  assert.throws(() => resolveProfilePaths(root, '138＊＊＊＊1234'), /不能唯一标识/);
  assert.throws(() => resolveProfilePaths(root, '138＊＊＊＊1234', '13900001234'), /不能唯一标识/);
});

test('sanitized aliases and case variants do not collide; default paths stay stable', () => {
  const profiles = ['a/b', 'a_b', 'A', 'a', '../test', 'x'.repeat(80), 'x'.repeat(81)];
  const paths = profiles.map(profile => resolveProfilePaths(root, profile));
  assert.equal(new Set(paths.map(item => item.key.toLowerCase())).size, profiles.length);
  for (const item of paths) assert.equal(path.dirname(item.directory), root);
  assert.equal(resolveProfilePaths(root).directory, path.join(root, '.chrome-profile'));
  assert.equal(resolveProfilePaths(root).stateFile, path.join(root, 'state.json'));
});

test('occupied profiles fail with one launch attempt and no process cleanup', async () => {
  for (const message of ['The browser is already running for this profile', 'ProcessSingleton lock failed']) {
    let calls = 0;
    const launcher = { async launch() { calls++; throw new Error(message); } };
    await assert.rejects(launchProfileBrowser(launcher, { userDataDir: path.join(root, '.chrome-profile') }), { code: 'PROFILE_IN_USE' });
    assert.equal(calls, 1);
  }
  const error = new Error('executable not found');
  await assert.rejects(launchProfileBrowser({ launch: async () => { throw error; } }, {}), candidate => candidate === error);
});

test('legacy and temporary failures become eligible on subsequent runs', () => {
  for (const reason of ['open-failed', 'timeout', 'enroll: temporarily unavailable']) {
    assert.equal(isPermanentFailure({ failed: true, reason }), false);
    assert.equal(isPermanentFailure({ failed: false, retryable: true, reason }), false);
  }
  assert.equal(isPermanentFailure(undefined), false);
  assert.equal(isPermanentFailure({ failed: true, retryable: false }), true);
});

test('failed playback and unavailable credit do not imply a daily limit', () => {
  assert.equal(nextNoGainStreak(1, { ok: false }, 0, 0), 0);
  assert.equal(nextNoGainStreak(1, { ok: true }, null, 0), 0);
  assert.equal(nextNoGainStreak(1, { ok: true }, 0, null), 0);
  assert.equal(nextNoGainStreak(1, { ok: true }, 1, 1), 2);
  assert.equal(nextNoGainStreak(1, { ok: true }, 1, 1.25), 0);
});

function mockStatistics(total, pageSize, includeCount = true) {
  const requests = [];
  const page = { async evaluate(_fn, endpoint, args) {
    requests.push(args.page);
    assert.equal(endpoint, 'Page/MyStudyStat');
    const start = (args.page - 1) * pageSize;
    return { ok: true, status: 200, json: { Data: {
      ...(includeCount ? { Count: String(total) } : {}),
      CreditSum: 9, FinishCourse: total - 1, UnFinishCourse: 1,
      ListData: Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, i) => ({
        Id: start + i + 1, BrowseScore: start + i + 1 === total ? 42 : 100, Credit: 1, Name: 'fixture',
      })),
    } } };
  } };
  return { page, requests };
}

test('statistics pagination includes course 501 and preserves summary fields', async () => {
  const { page, requests } = mockStatistics(501, 500);
  const result = await fetchMyCourses(page);
  assert.deepEqual(requests, [1, 2]);
  assert.equal(result.map.size, 501);
  assert.equal(result.map.get(501).browseScore, 42);
  assert.equal(result.creditSum, 9);
  assert.equal(result.finish, 500);
  assert.equal(result.unfinish, 1);
});

test('server page-size caps and missing Count do not truncate statistics', async () => {
  for (const includeCount of [true, false]) {
    const { page, requests } = mockStatistics(501, 200, includeCount);
    const result = await fetchMyCourses(page);
    assert.equal(result.map.size, 501);
    assert.equal(result.count, 501);
    assert.deepEqual(requests, includeCount ? [1, 2, 3] : [1, 2, 3, 4]);
  }
  assert.equal((await fetchMyCourses(mockStatistics(0, 500).page)).map.size, 0);
});

test('incomplete or repeated statistics pages fail visibly', async () => {
  const broken = { evaluate: async () => ({ ok: false, status: 503 }) };
  await assert.rejects(fetchMyCourses(broken), /第 1 页失败/);
  const repeated = { evaluate: async () => ({ ok: true, status: 200, json: { Data: {
    Count: 2, ListData: [{ Id: 1, BrowseScore: 10 }],
  } } }) };
  await assert.rejects(fetchMyCourses(repeated), /分页结果不完整/);
  const { page } = mockStatistics(501, 500);
  const original = page.evaluate;
  page.evaluate = (...args) => args[2].page === 2 ? broken.evaluate() : original(...args);
  await assert.rejects(fetchMyCourses(page), /第 2 页失败/);
});

test('navigation timeout is retryable and closes only the new player', async () => {
  let closed = 0;
  const player = {
    evaluateOnNewDocument: async () => {}, on() {},
    goto: async () => { throw new Error('fixture network timeout'); },
    close: async () => { closed++; },
  };
  const result = await playCourse({ newPage: async () => player }, { keepVisible: true }, { id: 'fixture' }, {});
  assert.equal(result.reason, 'open-failed');
  assert.equal(result.retryable, true);
  assert.equal(closed, 1);
});
