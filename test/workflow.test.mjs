import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as runtime from '../runtime-utils.mjs';

// 在内存中运行真实主流程,替换网站、磁盘和时钟,避免登录网站或写入本机学习状态。
const moduleUrl = new URL('../auto-learn.mjs', import.meta.url);
const source = fs.readFileSync(moduleUrl, 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export \{[^\n]*\};\r?\n/gm, '')
  .replaceAll('import.meta.url', '__moduleUrl')
  .replace('const sleep = ms => new Promise(r => setTimeout(r, ms));', 'const sleep = async ms => { __clock.now += ms; };');

function fixture({ courses = [], initialState = {}, flags = [], enroll = () => ({ Type: 1 }), play = () => ({ ok: true }) } = {}) {
  let state = structuredClone(initialState);
  let credit = 0;
  const played = [], enrolled = [], completed = new Set();
  const clock = { now: 0 };
  const fakeChrome = path.resolve('fixture-chrome');
  const mainPage = {};
  const browser = { pages: async () => [mainPage], close: async () => {} };
  const context = vm.createContext({
    ...runtime, path, fileURLToPath, __moduleUrl: moduleUrl.href, __clock: clock,
    console: { log() {}, error() {} }, URLSearchParams, setTimeout,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock.now])); }
      static now() { return clock.now; }
    },
    process: { argv: ['node', 'fixture', '--credit=1', ...flags], platform: 'win32', env: { CHROME_PATH: fakeChrome } },
    fs: {
      existsSync: filename => filename === fakeChrome,
      mkdirSync() {},
      readFileSync: () => JSON.stringify(state),
      writeFileSync: (_filename, contents) => { state = JSON.parse(contents); },
      createWriteStream: () => ({ write() {}, end() {} }),
    },
    puppeteer: { launch: async () => browser },
    execSync() { throw new Error('Unexpected shell command'); },
    __site: {
      courses: async () => courses,
      mine: async () => ({ map: new Map(courses.map(c => [c.id, { browseScore: completed.has(c.id) ? 100 : 0, credit: 0 }])) }),
      credit: async () => ({ value: credit, source: 'fixture' }),
      enroll: async (_page, ids) => { enrolled.push(ids[0]); return enroll(ids[0]); },
      play: async (_browser, _cfg, course) => {
        played.push(course.id);
        const result = play(course.id);
        if (result.ok) { completed.add(course.id); credit += course.credit; }
        return result;
      },
    },
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    preparePage = async () => {};
    ensureLoggedIn = async () => true;
    fetchCourses = __site.courses;
    fetchMyCourses = __site.mine;
    getCredit = __site.credit;
    enrollCourses = __site.enroll;
    globalThis.actualPlayCourse = playCourse;
    playCourse = __site.play;
    solvePlayGate = async () => 'no-slider';
    readVideoState = async () => ({ hasVideo: true, duration: 120, currentTime: 0, paused: false, ended: false, quizOpen: false });
    globalThis.run = main;
  `, context);
  return { context, played, enrolled, state: () => state };
}

const course = (id, learning = 0) => ({ id, learning, credit: 1, time: 1, standards: 'mp4', name: `fixture ${id}`, type: 'video' });

test('main retries legacy failures, skips temporary failures once, and reaches later courses', async () => {
  const run = fixture({
    courses: [course(1), course(2), course(3)],
    initialState: { courses: { 1: { failed: true, reason: 'timeout' } } },
    play: id => id < 3 ? { ok: false, reason: 'timeout', retryable: true } : { ok: true },
  });
  await run.context.run();
  assert.equal(run.context.process.exitCode, undefined);
  assert.deepEqual(run.played, [1, 2, 3]);
  assert.equal(run.state().courses[1].failed, false);
  assert.equal(run.state().courses[1].retryable, true);
  const next = fixture({ courses: [course(1)], initialState: run.state() });
  await next.context.run();
  assert.deepEqual(next.played, [1]);
});

test('enrollment failure is retried on a later run and --only does not loop forever', async () => {
  const run = fixture({
    courses: [course(1, -1), course(2, -1)],
    enroll: id => ({ Type: id === 1 ? 0 : 1, Message: 'fixture temporary error' }),
  });
  await run.context.run();
  assert.equal(run.context.process.exitCode, undefined);
  assert.deepEqual(run.enrolled, [1, 2]);
  assert.deepEqual(run.played, [2]);
  assert.equal(run.state().courses[1].retryable, true);
  const next = fixture({ courses: [course(1, -1)], initialState: run.state() });
  await next.context.run();
  assert.deepEqual(next.played, [1]);
  const only = fixture({ courses: [course(1, -1)], flags: ['--only=1'], enroll: () => ({ Type: 0 }) });
  await only.context.run();
  assert.deepEqual(only.enrolled, [1]);
  assert.deepEqual(only.played, []);
});

test('actual playback timeout preserves duration and is retryable', async () => {
  const run = fixture();
  let closed = 0;
  const player = {
    goto: async () => {}, evaluate: async () => ({ hasVideo: true, hasGate: false }),
    close: async () => { closed++; },
  };
  const result = await run.context.actualPlayCourse({ newPage: async () => player }, { maxDurationFactor: 0, maxExtraMinutes: 0 }, course(1), {});
  assert.equal(result.reason, 'timeout');
  assert.equal(result.retryable, true);
  assert.equal(result.duration, 120);
  assert.equal(closed, 1);
});
