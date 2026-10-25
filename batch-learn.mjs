#!/usr/bin/env node
/**
 * 河南干部网络学院 · 多账号一键编排与任务汇总
 *
 * 功能:
 *   1. 自动读取 accounts.local.json 或 config.json 编排多账号并发
 *   2. 默认采用最优策略: --newest-single --daily
 *   3. 实时终端状态面板 (当前学分、今日增量、播放进度、完成门数)
 *   4. 全部完成时自动生成汇总报告 (控制台输出 + logs/summary-*.md)
 *   5. 支持 --status 随时独立查看当前各账号学习进度
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveProfilePaths } from './runtime-utils.mjs';
import { accountLogFiles, localDay, logIdentity } from './learning-log-utils.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_FILE = path.join(ROOT, 'accounts.local.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const LOG_DIR = path.join(ROOT, 'logs');

function maskPhone(s) {
  return String(s || '').replace(/^(1[3-9]\d)\d{4}(\d{4})$/, '$1＊＊＊＊$2');
}

export function parseBatchOptions(args = []) {
  const options = { daily: true, maxAccounts: 3, accounts: [], status: false };
  for (const arg of args) {
    if (arg === '--status') options.status = true;
    else if (arg === '--daily' || arg === '--daily=true') options.daily = true;
    else if (arg === '--daily=false') options.daily = false;
    else if (arg.startsWith('--accounts=')) options.accounts.push(...arg.slice(11).split(','));
    else if (arg.startsWith('--max-accounts=')) options.maxAccounts = Number(arg.slice(15));
    else throw new Error('INVALID_BATCH_OPTION');
  }
  if (!Number.isInteger(options.maxAccounts) || options.maxAccounts < 1 || options.accounts.some(a => !a)) throw new Error('INVALID_BATCH_OPTION');
  return options;
}

export function selectBatchAccounts(accounts, options) {
  const selected = accounts.filter(a => !options.accounts.length || options.accounts.includes(a.profile || a.user) || options.accounts.includes(a.user));
  if (!selected.length) throw new Error('NO_MATCHING_ACCOUNTS');
  if (selected.length > options.maxAccounts) throw new Error('MAX_ACCOUNTS_EXCEEDED');
  return selected;
}

export function loadAccounts() {
  if (fs.existsSync(ACCOUNTS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      if (Array.isArray(data) && data.length > 0) return data;
    } catch (e) {
      console.error('⚠ accounts.local.json 解析失败:', e.message);
    }
  }
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (cfg.username && cfg.password) {
        return [{ profile: cfg.username, user: cfg.username, pass: cfg.password }];
      }
    } catch {}
  }
  return [];
}

export function parseAccountLog(logFilePath) {
  if (!logFilePath || !fs.existsSync(logFilePath)) {
    return { initialCredit: null, currentCredit: null, status: '未启动', currentCourse: '', progress: '', finishedCount: 0 };
  }
  let content = '';
  try {
    content = fs.readFileSync(logFilePath, 'utf8');
  } catch {
    return { initialCredit: null, currentCredit: null, status: '读取中', currentCourse: '', progress: '', finishedCount: 0 };
  }

  const lines = content.split(/\r?\n/);
  let initialCredit = null;
  let currentCredit = null;
  let status = '运行中';
  let currentCourse = '';
  let progress = '';
  let finishedCount = 0;

  for (const line of lines) {
    // 学分提取
    // ⚠ 启动时的首行是「当前进度: 学时/学分 X」(全角冒号),而结算行是「当前学时/学分: X」。
    //   只认后者会把基准取成"第一门结算后"的值,看板增量凭空少算一门(如实际 +1.72 显示 +1.00)。
    const pm = /当前进度:\s*学时\/学分\s*([\d.]+)/.exec(line);
    if (pm && initialCredit === null) {
      initialCredit = parseFloat(pm[1]);
      if (currentCredit === null) currentCredit = initialCredit;
    }
    const cm = /当前学时\/学分:\s*([\d.]+)/.exec(line);
    if (cm) {
      const val = parseFloat(cm[1]);
      if (initialCredit === null) initialCredit = val;
      currentCredit = val;
    }
    const endCm = /结束。本次处理\s*\d+\s*门,学时\/学分\s*([\d.]+)/.exec(line);
    if (endCm) currentCredit = parseFloat(endCm[1]);

    // 当前课程
    const cmCourse = /──────── 第 \d+ 门 ────────/.test(line);
    if (cmCourse) progress = '';
    const nameMatch = /《([^》]+)》\s+id=(\d+)/.exec(line);
    if (nameMatch) currentCourse = nameMatch[1];

    // 播放进度
    const pctMatch = /…播放中\s+([\d:]+\s+\/\s+[\d:]+\s+\([\d.]+%\))/.exec(line);
    if (pctMatch) progress = pctMatch[1];

    // 完成门数
    if (/✔ 该课程已学完,学分已到账/.test(line)) {
      finishedCount++;
      currentCourse = '';
      progress = '';
    }

    // 状态标记
    if (/🛑 已达站点【每日学时上限】/.test(line)) {
      status = '已达今日上限';
    } else if (/🎉 已达到目标/.test(line)) {
      status = '已达目标学分';
    } else if (/✖ 运行出错/.test(line)) {
      status = '运行出错';
    } else if (/浏览器已关闭/.test(line)) {
      if (status === '运行中') status = '已结束';
    }
  }

  if (status === '运行中') {
    if (currentCourse && progress) {
      status = `播放中: ${progress}`;
    } else if (currentCourse) {
      status = `正在选课/准备: 《${currentCourse.slice(0, 10)}…》`;
    } else {
      status = '正在选课…';
    }
  }

  return { initialCredit, currentCredit, status, currentCourse, progress, finishedCount };
}

export function findLatestLog(key, root = ROOT) {
  const dir = path.join(root, 'logs');
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter(f => logIdentity(f)?.identity === key).sort((a, b) => logIdentity(a).start - logIdentity(b).start);
  return names.length ? path.join(dir, names.at(-1)) : null;
}

function dayTotals(root, files, now) {
  const today = localDay(now), credits = [], finished = new Set(), seen = new Set();
  let uncertain = false, unknownFinished = false;
  for (const file of files) {
    const start = logIdentity(file).start;
    const text = fs.readFileSync(path.join(root, 'logs', file), 'utf8');
    if (seen.has(text)) continue;
    seen.add(text);
    let course = '', previous = null;
    for (const [index, line] of text.split('\n').entries()) {
      const elapsed = /\+(\d+):(\d{2}):(\d{2})\]/.exec(line);
      const at = elapsed ? start + (Number(elapsed[1]) * 3600 + Number(elapsed[2]) * 60 + Number(elapsed[3])) * 1000 : NaN;
      const day = Number.isFinite(at) && at <= now + 1000 ? localDay(at) : null;
      const id = /《[^》]+》\s+id=(\d+)/.exec(line);
      if (id) course = id[1];
      if (/✔ 该课程已学完,学分已到账/.test(line)) {
        if (day === today) finished.add(course || `${start}:${index}`);
        else if (!day && localDay(start) === today) unknownFinished = true;
      }
      const match = /(?:当前进度[:：]\s*学时\/学分\s*|当前学时\/学分[:：]\s*|结束。本次处理\s*\d+\s*门,学时\/学分\s*)([\d.]+)/.exec(line);
      if (match) {
        const value = Number(match[1]);
        if (day === today) {
          if (previous && previous.day !== today) uncertain = true;
          else credits.push([previous?.value ?? value, value]);
        } else if (!day && localDay(start) === today) uncertain = true;
        previous = { value, day };
      }
    }
  }
  credits.sort((a, b) => a[0] - b[0]);
  let gain = 0, end = -Infinity;
  for (const [a, b] of credits) { gain += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
  return { gain: uncertain ? '未知（跨日/时间缺失区间不可归因）' : credits.length ? `+${gain.toFixed(2)}` : '未知', finished: unknownFinished ? '未知' : finished.size };
}

export async function generateDashboard(accounts, { root = ROOT, identityAccounts = accounts, now = Date.now(), observe } = {}) {
  observe ||= (await import('./learning-watchdog.mjs')).observeAccounts;
  let observations;
  try { observations = await observe({ root, accounts, identityAccounts, now }); } catch { observations = {}; }
  const rows = [];
  for (const acc of accounts) {
    const profile = acc.profile || acc.user;
    const paths = resolveProfilePaths(root, profile, acc.user);
    const files = accountLogFiles(root, acc, identityAccounts);
    const parsed = parseAccountLog(files.length ? path.join(root, 'logs', files.at(-1)) : null);
    const observation = observations?.[paths.key];
    const totals = dayTotals(root, files, now);
    const init = parsed.initialCredit !== null ? parsed.initialCredit.toFixed(2) : '--';
    const cur = parsed.currentCredit !== null ? parsed.currentCredit.toFixed(2) : '--';
    const runGain = parsed.initialCredit !== null && parsed.currentCredit !== null ? `+${(parsed.currentCredit - parsed.initialCredit).toFixed(2)}` : '未知';
    let status = '状态未知（进程观察不可用）', course = '';
    if (observation?.known) {
      if (['manual-required', 'no-gain'].includes(observation.stopReason) && (!observation.stopDay || observation.stopDay === localDay(now))) status = '保护停机（需人工确认，非完成）';
      else if (observation.quotaBlocked === true || (observation.quotaBlocked !== false && observation.completedDay === localDay(now))) status = '已达今日上限';
      else if (observation.stopReason === 'completed' && observation.stopDay === localDay(now)) status = '本次目标/课程处理已结束';
      else if (!observation.learner) status = observation.completedDay ? `已退出（历史达限 ${observation.completedDay}）` : '已退出（日志仅为历史记录）';
      else if (!observation.mtime || now - observation.mtime > 180_000 || observation.logDay !== localDay(now)) status = '进程存活，日志陈旧或日期未知';
      else { status = parsed.status; course = parsed.currentCourse; }
    }
    rows.push({ user: maskPhone(acc.user || profile), initial: init, current: cur, gain: totals.gain, runGain, finished: totals.finished, status, course });
  }
  return rows;
}

export function formatDashboard(rows) {
  const header = '══════════════════════════════════════════════════════════════════════════════\n' +
                 '  河南干部网络学院 · 多账号并行学习管理面板\n' +
                 '══════════════════════════════════════════════════════════════════════════════';
  const lines = [header];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const courseInfo = r.course ? ` | 当前: 《${r.course.slice(0, 18)}》` : '';
    lines.push(` [${i + 1}] ${r.user.padEnd(11)}  学分: ${r.current} (初始 ${r.initial}, 今日日志累计 ${r.gain}, 本轮 ${r.runGain ?? r.gain}) | 完成: ${r.finished}门 | 状态: ${r.status}${courseInfo}`);
  }
  lines.push('──────────────────────────────────────────────────────────────────────────────');
  return lines.join('\n');
}

export function formatSummaryReport(rows, durationSec = 0) {
  const dateStr = new Date().toLocaleDateString('zh-CN');
  const dMin = (durationSec / 60).toFixed(1);
  const lines = [
    `# 干部网络学院学习总结报告 (${dateStr})`,
    '',
    `> 总运行时长: ${dMin} 分钟 | 账号数: ${rows.length}`,
    '',
    '| 账号 | 初始学分 | 最终学分 | 今日净增 | 已完成门数 | 状态 |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
  ];
  for (const r of rows) {
    lines.push(`| **${r.user}** | ${r.initial} | **${r.current}** | **${r.gain}** | ${r.finished} 门 | ${r.status} |`);
  }
  lines.push('', '---', '*报告由 batch-learn 自动生成*');
  return lines.join('\n');
}

export function createChildOwner() {
  const live = new Set();
  let stopping = false;
  const terminate = proc => { if (proc.exitCode == null && proc.signalCode == null) { try { proc.kill(); } catch {} } };
  return {
    get stopping() { return stopping; },
    get size() { return live.size; },
    add(proc) {
      if (!proc || proc.exitCode != null || proc.signalCode != null) return;
      if (stopping) { terminate(proc); return; }
      live.add(proc);
      const remove = () => live.delete(proc);
      proc.once('exit', remove); proc.once('error', remove); proc.once('close', remove);
    },
    stop() { if (stopping) return; stopping = true; for (const proc of live) terminate(proc); }
  };
}

export async function stopOwnedBatch(owner, monitor, exits) {
  owner.stop();
  monitor?.stop();
  if (monitor) await monitor.finished;
  if (exits) await exits.finished;
}

export function shouldFinishBatch(children, monitor, owner, exits) {
  return children.every(c => c.closed ?? (c.proc.exitCode != null || c.proc.signalCode != null)) && (!owner || owner.size === 0) && (!monitor || monitor.done) && (!exits || exits.pending === 0);
}

export function createBatchExitRecorder({ root = ROOT, watchdogApi, identityAccounts = [], getMonitor = () => null, isStopping = () => false, notify = watchdogApi?.notifyGateway, drainOptions = {} }) {
  let finished = Promise.resolve(), pending = 0;
  return {
    get finished() { return finished; },
    get pending() { return pending; },
    recordExit(acc) {
      if (!watchdogApi || isStopping()) return;
      try { watchdogApi.recordLearnerExit(root, acc, { identityAccounts }); } catch { console.error('⚠ 学习退出告警持久化失败（详情已隐藏）。'); }
      const monitor = getMonitor();
      if (monitor && !monitor.done) monitor.wake();
      pending++;
      finished = finished.then(async () => {
        // A terminal tick may finish before child close. Never race its drain.
        if (monitor) await monitor.finished;
        const notifier = await watchdogApi.drainNotifications(root, notify, drainOptions);
        const file = path.join(root, 'logs', 'learning-watchdog-health.json');
        let health;
        try { health = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; health = monitor?.health || {}; }
        health.notifier = notifier;
        const temporary = `${file}.${randomUUID()}.tmp`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
          fs.writeFileSync(temporary, JSON.stringify(health, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          fs.renameSync(temporary, file);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        if (monitor?.health) monitor.health.notifier = notifier;
      }).catch(() => { console.error('⚠ 学习退出通知或健康记录保存失败（详情已隐藏）。'); })
        .finally(() => { pending--; });
    }
  };
}

/** Transactional startup: reserve monitor ownership before authorizing or spawning. */
export async function startLearningBatch({ root = ROOT, accounts, identityAccounts = accounts, daily = true, watchdogApi, spawnFn = spawn, monitorOptions = {} }) {
  watchdogApi ||= await import('./learning-watchdog.mjs');
  const owner = createChildOwner(), children = [], earlyExits = [];
  const monitor = watchdogApi.startBatchMonitor({ ...monitorOptions, root, accounts, identityAccounts, owner, deferStart: true });
  if (!monitor) throw new Error('MONITOR_ALREADY_RUNNING');
  const armFile = path.join(root, 'logs', 'learning-watchdog-arm.json');
  let previousArm, armAttempted = false, initializing = true;
  const exits = createBatchExitRecorder({ root, watchdogApi, identityAccounts, getMonitor: () => monitor,
    isStopping: () => owner.stopping, notify: monitorOptions.notify, drainOptions: monitorOptions });
  try {
    try { previousArm = fs.readFileSync(armFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!monitor.ownsLock) throw new Error('MONITOR_LOCK_LOST');
    armAttempted = true;
    watchdogApi.armLearningRun(root, Date.now(), { accounts, daily });
    for (const acc of accounts) {
      if (!monitor.ownsLock) throw new Error('MONITOR_LOCK_LOST');
      const profile = acc.profile || acc.user;
      const paths = resolveProfilePaths(root, profile, acc.user);
      const errLogFile = path.join(root, 'logs', `err-${paths.key}.log`);
      const errFd = fs.openSync(errLogFile, 'a');
      try {
        const proc = spawnFn(process.execPath, ['auto-learn.mjs', `--profile=${profile}`, `--user=${acc.user}`, `--pass=${acc.pass}`, '--newest-single', ...(daily ? ['--daily'] : [])],
          { cwd: root, stdio: ['ignore', 'ignore', errFd], windowsHide: true });
        owner.add(proc);
        const child = { proc, acc, profile, closed: false };
        children.push(child);
        let exitRecorded = false;
        const onExit = () => {
          if (exitRecorded) return;
          exitRecorded = true;
          if (initializing) earlyExits.push(acc); else exits.recordExit(acc);
        };
        proc.on('error', onExit);
        proc.on('close', code => {
          onExit();
          child.closed = true;
          try { if (code === 0 && fs.statSync(errLogFile).size === 0) fs.unlinkSync(errLogFile); } catch {}
        });
        await new Promise((resolve, reject) => {
          proc.once('spawn', resolve);
          proc.once('error', () => reject(new Error('LEARNER_LAUNCH_FAILED')));
        });
      } finally { fs.closeSync(errFd); }
    }
    monitor.start();
    initializing = false;
    for (const acc of earlyExits) exits.recordExit(acc);
    return { children, owner, monitor, exits, watchdogApi };
  } catch (error) {
    owner.stop();
    await Promise.all(children.map(child => child.closed ? undefined : new Promise(resolve => child.proc.once('close', resolve))));
    try {
      // Roll back only while still owning the project lock; never overwrite a successor.
      if (armAttempted && monitor.ownsLock) {
        if (previousArm === undefined) fs.rmSync(armFile, { force: true });
        else {
          const temporary = `${armFile}.${randomUUID()}.tmp`;
          try { fs.writeFileSync(temporary, previousArm, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, armFile); }
          finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        }
      }
    } finally { monitor.stop(false); await monitor.finished; }
    throw error;
  }
}

export async function runBatch({ args = process.argv.slice(2), identityAccounts = loadAccounts(), root = ROOT, spawnFn = spawn, monitorOptions = {} } = {}) {
  const options = parseBatchOptions(args);
  const isStatusOnly = options.status;
  const accounts = selectBatchAccounts(identityAccounts, options);

  if (!accounts.length) {
    console.error('❌ 未找到可用账号。请在 accounts.local.json 或 config.json 中配置账号。');
    process.exit(1);
  }

  if (isStatusOnly) {
    const rows = await generateDashboard(accounts, { root, identityAccounts });
    console.log(formatDashboard(rows));
    return;
  }

  console.log(`\n🚀 准备并行启动 ${accounts.length} 个账号学习任务…`);
  const startTime = Date.now();
  const { children, owner, monitor, exits, watchdogApi } = await startLearningBatch({ root, accounts, identityAccounts, daily: options.daily, spawnFn, monitorOptions });
  process.once('uncaughtExceptionMonitor', () => {
    for (const acc of accounts) {
      try { watchdogApi.recordLearnerExit(root, acc, { batchFatal: true, identityAccounts }); } catch {}
    }
    void watchdogApi.notifyGateway(root);
  });
  for (const { acc, proc } of children) console.log(`  → 已启动账号 ${maskPhone(acc.user)} (PID ${proc.pid})`);

  console.log('\n所有账号后台并发进程已就绪，按 Ctrl+C 可一键结束所有子任务。');
  console.log('正在实时监测各账号状态…\n');

  const checkInterval = 6000;
  const timer = setInterval(async () => {
    const rows = await generateDashboard(accounts, { root, identityAccounts });
    console.clear();
    console.log(formatDashboard(rows));
    console.log(`\n更新时间: ${new Date().toLocaleTimeString()} (每 6 秒刷新一次, 按 Ctrl+C 退出监测)`);

    // 检查所有子进程是否均已结束
    const allExited = shouldFinishBatch(children, monitor, owner, exits);
    if (allExited) {
      clearInterval(timer);
      await onComplete(children, startTime, identityAccounts, root);
    }
  }, checkInterval);

  process.on('SIGINT', async () => {
    clearInterval(timer);
    console.log('\n\n🛑 正在停止本批次拥有的子进程…');
    await stopOwnedBatch(owner, monitor, exits);
    await onComplete(children, startTime, identityAccounts, root);
    process.exit(0);
  });
}

export function saveSummaryReport(root, report, now = Date.now()) {
  const directory = path.join(root, 'logs');
  fs.mkdirSync(directory, { recursive: true });
  const reportPath = path.join(directory, `summary-${localDay(now)}-${now}-${randomUUID()}.md`);
  fs.writeFileSync(reportPath, report, { encoding: 'utf8', flag: 'wx' });
  return reportPath;
}

async function onComplete(children, startTime, identityAccounts, root = ROOT) {
  const durationSec = Math.round((Date.now() - startTime) / 1000);
  const accounts = children.map(c => c.acc);
  const rows = await generateDashboard(accounts, { root, identityAccounts });
  const report = formatSummaryReport(rows, durationSec);

  console.log('\n\n══════════════════════════════════════════════════════════════════════════════');
  console.log(' 🎉 所有账号任务均已执行完毕！最终学习汇总报告:');
  console.log('══════════════════════════════════════════════════════════════════════════════\n');
  console.log(report);

  // 写入总结报告到 logs/
  try {
    const reportPath = saveSummaryReport(root, report);
    console.log(`\n📄 总结报告已自动保存至: ${reportPath}`);
  } catch {}
}

if (process.argv[1] && (path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) || process.argv[1].endsWith('batch-learn.mjs'))) {
  runBatch().catch(error => { console.error(error.message === 'MONITOR_ALREADY_RUNNING' ? 'BATCH_FAILED: MONITOR_ALREADY_RUNNING; no learners started, authorization unchanged' : 'BATCH_FAILED: invalid scope or runtime failure'); process.exitCode = 1; });
}
