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
  const played = [], enrolled = [], completed = new Set(), logs = [], logFiles = [];
  const clock = { now: 0 };
  const fakeChrome = path.resolve('fixture-chrome');
  const mainPage = {};
  const browser = { pages: async () => [mainPage], close: async () => {} };
  const context = vm.createContext({
    ...runtime, path, fileURLToPath, __moduleUrl: moduleUrl.href, __clock: clock,
    console: { log: line => logs.push(line), error: line => logs.push(line) }, URLSearchParams, setTimeout,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock.now])); }
      static now() { return clock.now; }
    },
    process: { argv: ['node', 'fixture', ...flags, '--credit=1'], platform: 'win32', env: { CHROME_PATH: fakeChrome } },
    fs: {
      existsSync: filename => filename === fakeChrome,
      mkdirSync() {},
      readFileSync: () => JSON.stringify(state),
      writeFileSync: (_filename, contents) => { state = JSON.parse(contents); },
      createWriteStream: filename => { logFiles.push(filename); return { write() {}, end() {} }; },
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
  return { context, played, enrolled, logs, logFiles, state: () => state };
}

const course = (id, learning = 0) => ({ id, learning, credit: 1, time: 1, standards: 'mp4', name: `fixture ${id}`, type: 'video' });

function playbackFixture(states, score = 100) {
  const run = fixture();
  let reads = 0, closed = 0;
  const player = {
    goto: async () => {}, evaluate: async () => ({ hasVideo: true, hasGate: false, ok: true }),
    close: async () => { closed++; }, bringToFront: async () => {},
  };
  run.context.readVideoState = async () => ({
    hasVideo: true, duration: 120, currentTime: 0, paused: false, ended: false, quizOpen: false,
    ...states[Math.min(reads++, states.length - 1)],
  });
  run.context.fetchMyCourses = async () => {
    if (score === 'error') throw new Error('fixture unavailable');
    return { map: new Map(score === null ? [] : [[1, { browseScore: score }]]) };
  };
  return {
    ...run, closed: () => closed, reads: () => reads,
    play: (cfg = {}) => run.context.actualPlayCourse({ newPage: async () => player },
      { maxDurationFactor: 2.5, maxExtraMinutes: 15, ...cfg }, course(1), {}),
  };
}

test('complete stall also requests bounded single-account recovery after its existing watchdog is exhausted', async () => {
  const run=playbackFixture([{duration:2000,currentTime:0}]);
  const result=await run.play();
  assert.equal(result.reason,'stalled-watchdog');
  assert.equal(result.restartRequired,true);
  assert(run.logs.some(l=>l.includes('PLAYBACK_HEALTH=restart')));
});

test('actual playback loop detects intermittent low throughput and requests bounded learner restart', async () => {
  const run = playbackFixture(Array.from({length: 400}, (_, i) => ({duration:2000,currentTime:i*0.6})));
  const result=await run.play();
  assert.equal(result.reason,'slow-playback');
  assert.equal(result.restartRequired,true);
  assert.equal(result.retryable,true);
  assert(run.logs.some(l=>l.includes('PLAYBACK_HEALTH=reload')));
  assert(run.logs.some(l=>l.includes('PLAYBACK_HEALTH=restart')));
});

test('main closes a slow learner for supervisor recovery instead of silently skipping courses', async () => {
  const run=fixture({courses:[course(1),course(2)],flags:['--daily'],play:()=>({ok:false,retryable:true,restartRequired:true,reason:'slow-playback'})});
  await run.context.run();
  assert.deepEqual(run.played,[1]);
  assert.equal(run.context.process.exitCode,1);
  assert(run.logs.some(l=>l.includes('LEARNING_STOP_REASON=retryable-failure')));
  assert.equal(run.state().courses[1].retryable,true);
});

test('disappearing video is retryable failure rather than successful completion', async () => {
  const run = playbackFixture([{}, { hasVideo: false }]);
  const result = await run.play();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'video-disappeared');
  assert.equal(result.retryable, true);
  assert.equal(result.duration, 120);
  assert.equal(run.closed(), 1);
});

test('ended video requires confirmed server completion or returns retryable failure', async () => {
  for (const score of [55, 0, null, 'error']) {
    const run = playbackFixture([{}, { ended: true, currentTime: 120 }], score);
    const result = await run.play();
    assert.equal(result.ok, false, `score ${score} must not be successful`);
    assert.equal(result.reason, score === null || score === 'error' ? 'progress-unknown' : 'progress-incomplete');
    assert.equal(result.retryable, true);
    assert.equal(result.duration, 120);
    assert.equal(run.closed(), 1);
  }
  assert.equal((await playbackFixture([{}, { ended: true }], 100).play()).ok, true);
});

test('main skips courses with unconfirmed recheck without counting them as no-gain successes', async () => {
  for (const score of [55, null]) {
    const run = fixture({ courses: [course(1), course(2), course(3)], flags: ['--daily', '--max-courses=3'] });
    run.context.fetchMyCourses = async () => ({ map: new Map([1, 2, 3].map(id => [id, { browseScore: score === null ? 0 : score, credit: 0 }])) });
    // A completed player's subsequent progress report may regress or disappear.
    run.context.playCourse = async (_browser, _cfg, c) => {
      run.played.push(c.id);
      if (score === null) run.context.fetchMyCourses = async () => ({ map: new Map([1, 2, 3].filter(id => !run.played.includes(id)).map(id => [id, { browseScore: 0 }])) });
      return { ok: true, duration: 120, browseScore: 100 };
    };
    run.context.getCredit = async () => ({ value: 0, source: 'fixture' });
    await run.context.run();
    assert.deepEqual(run.played, [1, 2, 3]);
    assert.equal(run.state().courses[1].ok, false);
    assert.equal(run.state().courses[1].retryable, true);
    assert.equal(run.logs.some(line => /连续 2 门课都没有新增学时/.test(line)), false);
  }
});

test('main retries transient statistics failures with a bound and never treats failure as empty courses', async () => {
  for (const failAt of [1, 2, 3, 4]) {
    for (const failures of [1, 3]) {
      const run = fixture({ courses: [course(1)] });
      const original = run.context.fetchMyCourses;
      let calls = 0;
      run.context.fetchMyCourses = async (...args) => {
        calls++;
        if (calls >= failAt && calls < failAt + failures) throw new Error('fixture detached Frame');
        return original(...args);
      };
      await run.context.run();
      if (failures === 1) {
        assert.equal(run.context.process.exitCode, undefined, `transient failure at ${failAt}`);
        assert.deepEqual(run.played, [1], `transient failure at ${failAt}`);
      } else {
        assert.equal(run.context.process.exitCode, 1, `exhausted failure at ${failAt}`);
        assert.equal(calls, failAt + 2);
      }
      assert.equal(run.logs.some(line => line.includes('没有需要继续学习')), false);
      assert(run.logs.some(line => line.includes('读取学习统计失败')));
    }
  }
});

test('quiz time is excluded from playback deadlines and stall watchdog with recovery grace', async () => {
  const states = [
    {}, ...Array.from({ length: 15 }, () => ({ paused: true })),
    ...Array.from({ length: 70 }, () => ({ quizOpen: true, paused: true })),
    ...Array.from({ length: 10 }, () => ({ paused: true })),
    { ended: true, currentTime: 120 },
  ];
  for (const factor of [1, 10]) {
    const run = playbackFixture(states);
    const result = await run.play({ maxDurationFactor: factor, maxExtraMinutes: 0 });
    assert.equal(result.ok, true, `quiz >120s must not trigger ${result.reason}`);
    assert.equal(run.reads(), states.length);
    assert.equal(run.closed(), 1);
  }
});

test('unanswered quiz retains an independent bounded manual-wait timeout', async () => {
  const run = playbackFixture([{}, { quizOpen: true, paused: true }]);
  const result = await run.play({ maxDurationFactor: 1, maxExtraMinutes: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'quiz-timeout');
  assert.equal(result.retryable, true);
  assert.equal(result.manualRequired, true);
  assert(run.context.__clock.now >= 600000 && run.context.__clock.now < 620000);
  assert.equal(run.closed(), 1);
});

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

test('actual main refuses occupied profiles without cleanup or relaunch', async () => {
  for (const message of ['The browser is already running for fixture', 'ProcessSingleton lock failed', 'profile is in use']) {
    const run = fixture();
    let launches = 0, shells = 0;
    run.context.puppeteer.launch = async () => { launches++; throw new Error(message); };
    run.context.execSync = () => { shells++; };
    await assert.rejects(run.context.run(), { code: 'PROFILE_IN_USE' });
    assert.equal(launches, 1);
    assert.equal(shells, 0);
  }
});

test('actual main log filenames use unique profile keys and preserve default format', async () => {
  const names = [];
  for (const profile of [['138', '0000', '1234'].join(''), ['138', '9999', '1234'].join(''), 'a/b', 'a_b', '']) {
    const run = fixture({ flags: profile ? [`--profile=${profile}`] : [] });
    await run.context.run();
    const filename = path.basename(run.logFiles[0]);
    const { key } = runtime.resolveProfilePaths('.', profile);
    assert.equal(filename, `run-${key ? key + '-' : ''}1970-01-01T00-00-00.log`);
    names.push(filename);
  }
  assert.equal(new Set(names).size, names.length);
});

test('invalid numeric CLI limits fail before browser launch instead of silently disabling limits', async () => {
  for (const [option, values] of [
    ['max-courses', ['-1', 'Infinity', 'NaN', 'abc', '1.5', '']],
    ['credit', ['-1', 'Infinity', 'NaN', 'abc', '']],
  ]) {
    for (const value of values) {
      const run = fixture({ flags: [`--${option}=${value}`] });
      let launches = 0;
      run.context.puppeteer.launch = async () => { launches++; throw new Error('browser must not launch'); };
      await assert.rejects(run.context.run(), new RegExp(option));
      assert.equal(launches, 0);
    }
  }
  for (const flags of [['--max-courses=0'], ['--max-courses=1'], ['--credit=0'], ['--credit=0.5'], ['--daily']]) {
    const run = fixture({ flags });
    await run.context.run();
    assert.equal(run.context.process.exitCode, undefined);
  }
});

test('main emits completed stop marker for normal target, course limit, only, and no-candidate exits', async () => {
  for (const options of [
    {}, { courses: [course(1)] },
    { courses: [course(1), course(2)], flags: ['--daily', '--max-courses=1'] },
    { courses: [course(1)], flags: ['--only=1'] },
    { flags: ['--plan'] }, { flags: ['--list'] },
  ]) {
    const run = fixture(options);
    await run.context.run();
    assert.equal(run.logs.filter(line => line.includes('LEARNING_STOP_REASON=completed')).length, 1);
  }
  const failed = fixture();
  failed.context.fetchMyCourses = async () => { throw new Error('fixture unavailable'); };
  await failed.context.run();
  assert.equal(failed.context.process.exitCode, 1);
  assert.equal(failed.logs.some(line => line.includes('LEARNING_STOP_REASON=completed')), false);
});

test('manual intervention stops main immediately and is never labelled a daily limit', async () => {
  for (const flags of [[], ['--only=1']]) {
    for (const result of [
      { ok: false, reason: 'gate-blocked', retryable: true, blocked: true },
      { ok: false, reason: 'gate-failed', retryable: true },
      { ok: false, reason: 'quiz-timeout', retryable: true, manualRequired: true },
    ]) {
      const run = fixture({ courses: [course(1), course(2)], flags, play: () => result });
      const originalPlay = run.context.playCourse;
      run.context.playCourse = async (...args) => {
        const res = await originalPlay(...args);
        run.context.fetchMyCourses = async () => { throw new Error('must not recheck after manual stop'); };
        return res;
      };
      await run.context.run();
      assert.deepEqual(run.played, [1]);
      assert.equal(run.context.process.exitCode, undefined);
      assert.equal(run.logs.filter(line => line.includes('LEARNING_STOP_REASON=manual-required')).length, 1);
      assert.equal(run.logs.some(line => /每日.*上限|LEARNING_STOP_REASON=completed|LEARNING_STOP_REASON=daily-limit/.test(line)), false);
    }
  }
});

test('two confirmed courses without credit gain emit no-gain rather than a daily-limit assertion', async () => {
  const run = fixture({ courses: [course(1), course(2), course(3)], flags: ['--daily'] });
  run.context.getCredit = async () => ({ value: 0, source: 'fixture' });
  await run.context.run();
  assert.deepEqual(run.played, [1, 2]);
  assert.equal(run.logs.filter(line => line.includes('LEARNING_STOP_REASON=no-gain')).length, 1);
  assert.equal(run.logs.some(line => /LEARNING_STOP_REASON=(completed|daily-limit)/.test(line)), false);
});

test('explicit site daily-limit response emits daily-limit without attempting playback', async () => {
  const run = fixture({ courses: [course(1, -1)], enroll: () => ({ Type: 0, Message: '今天已累计学习5学时,明天再继续' }) });
  await run.context.run();
  assert.deepEqual(run.played, []);
  assert.equal(run.logs.filter(line => line.includes('LEARNING_STOP_REASON=daily-limit')).length, 1);
  assert.equal(run.logs.some(line => line.includes('LEARNING_STOP_REASON=completed')), false);
});

test('exhausted retryable playback failures remain non-successful and restartable, not completed or daily-limited', async () => {
  for (const flags of [[], ['--only=1'], ['--max-courses=1']]) {
    const run = fixture({ courses: [course(1), course(2)], flags,
      play: () => ({ ok: false, reason: 'progress-unknown', retryable: true }) });
    await run.context.run();
    assert.equal(new Set(run.played).size, run.played.length);
    assert.equal(run.context.process.exitCode, 1);
    assert.equal(run.logs.filter(line => line.includes('LEARNING_STOP_REASON=retryable-failure')).length, 1);
    assert.equal(run.logs.some(line => /LEARNING_STOP_REASON=(completed|daily-limit|no-gain)/.test(line)), false);
  }
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
