#!/usr/bin/env node
/** Independent, fail-closed observer. No gateway dependency or message transport. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { resolveProfilePaths } from './runtime-utils.mjs';
import { parseAccountLog, createChildOwner } from './batch-learn.mjs';
import { accountLogFiles, logIdentity, localDay, quotaDay, quotaResponseInLine, stopReasonInLine } from './learning-log-utils.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

// CommandLineToArgvW-style quoting; never return command lines to callers/loggers.
function windowsArgs(command) {
  const result = [];
  let value = '', quoted = false, started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\') {
      let count = 1;
      while (command[i + count] === '\\') count++;
      if (command[i + count] === '"') {
        value += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) value += '"'; else quoted = !quoted;
        i += count;
      } else { value += '\\'.repeat(count); i += count - 1; }
      started = true;
    } else if (c === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(c) && !quoted) {
      if (started) result.push(value);
      value = ''; started = false;
    } else { value += c; started = true; }
  }
  if (quoted) throw new Error('INVALID_PROCESS_ARGUMENTS');
  if (started) result.push(value);
  return result;
}
const flag = (args, key) => {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(`--${key}=`)) values.push(args[i].slice(key.length + 3));
    else if (args[i] === `--${key}`) values.push(args[++i]);
  }
  if (values.length > 1) throw new Error('AMBIGUOUS_PROCESS_ARGUMENTS');
  return values[0];
};

export async function enumerateProcesses({ exec = execFileAsync, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), platform = process.platform } = {}) {
  if (platform !== 'win32') return { known: false, error: 'WINDOWS_REQUIRED' };
  const started = Date.now(), failures = [];
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='chrome.exe' OR Name='msedge.exe'" | Select-Object Name,ProcessId,CommandLine); @{processes=$p} | ConvertTo-Json -Depth 4 -Compress`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const attemptStart = Date.now();
    let error = 'PROCESS_QUERY_FAILED', incomplete;
    try {
      const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
      error = 'INVALID_PROCESS_JSON';
      const data = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
      error = 'INVALID_PROCESS_LIST';
      if (!Array.isArray(data.processes) || data.processes.some(p => !p || typeof p.Name !== 'string')) throw new Error();
      const missing = data.processes.filter(p => typeof p.CommandLine !== 'string' || !p.CommandLine.trim());
      if (missing.length) {
        error = 'INCOMPLETE_PROCESS_OBSERVATION';
        // Persist identity only, never command lines, stderr or Error.message.
        incomplete = missing.map(p => ({ name: /^(node|chrome|msedge)\.exe$/i.test(p.Name) ? p.Name.toLowerCase() : 'other', pid: Number.isSafeInteger(p.ProcessId) && p.ProcessId > 0 ? p.ProcessId : null }));
        throw new Error();
      }
      return { known: true, processes: data.processes, diagnostic: { attempts: attempt, elapsedMs: Date.now() - started, failures } };
    } catch (cause) {
      if (error === 'PROCESS_QUERY_FAILED') {
        if (cause?.code === 'ENOENT') error = 'POWERSHELL_NOT_FOUND';
        else if (cause?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') error = 'PROCESS_QUERY_OUTPUT_LIMIT';
        else if (cause?.killed) error = 'PROCESS_QUERY_TIMEOUT';
      }
      failures.push({ error, elapsedMs: Date.now() - attemptStart, ...(incomplete ? { incomplete } : {}) });
    }
    // Retry a fresh complete snapshot. Never filter unreadable live processes and
    // interpret the remaining rows as proof that a learner/browser is absent.
    if (attempt < 3) await delay(250);
  }
  return { known: false, error: failures.at(-1).error, diagnostic: { attempts: 3, elapsedMs: Date.now() - started, failures } };
}

const observerErrors = new Set(['WINDOWS_REQUIRED', 'PROCESS_OBSERVER_FAILED', 'PROCESS_QUERY_FAILED', 'PROCESS_QUERY_TIMEOUT', 'POWERSHELL_NOT_FOUND', 'PROCESS_QUERY_OUTPUT_LIMIT', 'INVALID_PROCESS_JSON', 'INVALID_PROCESS_LIST', 'INCOMPLETE_PROCESS_OBSERVATION', 'INVALID_PROCESS_ARGUMENTS', 'AMBIGUOUS_PROCESS_ARGUMENTS', 'LOG_OBSERVER_FAILED', 'OBSERVER_FAILED']);
const safeObserverError = error => observerErrors.has(typeof error === 'string' ? error : error?.message) ? (typeof error === 'string' ? error : error.message) : 'OBSERVER_FAILED';
function safeObserverDiagnostic(value) {
  if (!value || typeof value !== 'object') return null;
  const number = v => Number.isSafeInteger(v) && v >= 0 ? v : 0;
  return { attempts: Math.min(3, number(value.attempts)), elapsedMs: number(value.elapsedMs), failures: (Array.isArray(value.failures) ? value.failures : []).slice(0, 3).map(f => ({
    error: safeObserverError(f?.error), elapsedMs: number(f?.elapsedMs),
    ...(Array.isArray(f?.incomplete) ? { incomplete: f.incomplete.slice(0, 128).map(p => ({ name: /^(node|chrome|msedge)\.exe$/i.test(p?.name) ? p.name.toLowerCase() : 'other', pid: Number.isSafeInteger(p?.pid) && p.pid > 0 ? p.pid : null })) } : {})
  })) };
}

export async function observeAccounts({ root = ROOT, accounts, identityAccounts = accounts, now = Date.now(), enumerate = enumerateProcesses }) {
  const result = {};
  let snapshot, observer = null, snapshotError = 'OBSERVER_FAILED';
  try {
    snapshot = await enumerate();
    observer = safeObserverDiagnostic(snapshot?.diagnostic);
    snapshotError = safeObserverError(snapshot?.error);
    if (!snapshot.known || !Array.isArray(snapshot.processes)) throw new Error('UNKNOWN');
    snapshot = snapshot.processes.map(p => ({ name: String(p.Name).toLowerCase(), args: windowsArgs(p.CommandLine) }));
  } catch (error) { if (snapshotError === 'OBSERVER_FAILED') snapshotError = safeObserverError(error); snapshot = null; }
  for (const account of accounts) {
    const paths = resolveProfilePaths(root, account.profile || account.user, account.user);
    try {
      if (!snapshot) throw new Error('UNKNOWN');
      const normalized = s => path.win32.normalize(s).replace(/[\\/]+$/, '').toLowerCase();
      const learner = snapshot.some(p => p.name === 'node.exe' && p.args.some(a => path.win32.basename(a) === 'auto-learn.mjs') && flag(p.args, 'profile') === (account.profile || account.user));
      const browser = snapshot.some(p => /^(chrome|msedge)\.exe$/.test(p.name) && normalized(flag(p.args, 'user-data-dir') || '') === normalized(paths.directory));
      const log = observeLogs(root, account, now, identityAccounts);
      result[paths.key] = { known: true, learner, browser, ...log, ...(observer ? { observer } : {}) };
    } catch (error) { result[paths.key] = { known: false, error: snapshot ? safeObserverError(error) : snapshotError, learner: null, browser: null, ...(observer ? { observer } : {}) }; }
  }
  return result;
}

function observeLogs(root, account, now, identityAccounts = []) {
  const directory = path.join(root, 'logs');
  const names = accountLogFiles(root, account, identityAccounts);
  const result = { mtime: null, currentCredit: null, currentCourse: '', progress: '', completedDay: null, logFile: null, logSize: 0, evidence: null };
  // 额度证据跨全部日志文件累积，按绝对时间比较：站点最后一次答复才是当前事实。
  let lastRefusal = null;
  let lastAccepted = null;
  for (const file of names) {
    const fullPath = path.join(directory, file);
    const stat = fs.statSync(fullPath);
    const text = fs.readFileSync(fullPath, 'utf8'); // throw on observer failure; never infer absence from unreadable logs
    const start = logIdentity(file)?.start ?? NaN;
    let offset = 0, evidence = null, stopReason = null, stopDay = null;
    for (const line of text.split(/(?<=\n)/)) {
      const elapsed = /\+([\d]+):(\d{2}):(\d{2})\]/.exec(line);
      const at = elapsed && Number.isFinite(start) ? start + (Number(elapsed[1]) * 3600 + Number(elapsed[2]) * 60 + Number(elapsed[3])) * 1000 : NaN;
      const reason = stopReasonInLine(line);
      if (reason && (!stopReason || reason !== 'completed')) { stopReason = reason; stopDay = Number.isFinite(at) ? localDay(at) : null; }
      if (reason === 'daily-limit' && Number.isFinite(at) && at <= now + 1000) {
        const day = localDay(at);
        if (!result.completedDay || day > result.completedDay) result.completedDay = day;
      }
      const quota = quotaResponseInLine(line);
      if (quota && Number.isFinite(at) && at <= now + 1000) {
        if (quota === 'refused') { if (!lastRefusal || at >= lastRefusal.at) lastRefusal = { at, day: localDay(at), quotaDay: quotaDay(at) }; }
        else if (!lastAccepted || at >= lastAccepted.at) lastAccepted = { at };
      }
      if (/开始播放|…播放中\s+[\d:]+\s*\//.test(line) && Number.isFinite(at)) evidence = { file, offset, at, start };
      offset += Buffer.byteLength(line);
    }
    if (file === names.at(-1)) {
      const parsed = parseAccountLog(fullPath);
      if (parsed.status === '读取中') throw new Error('LOG_OBSERVER_FAILED');
      Object.assign(result, { stopReason, stopDay, logDay: localDay(start), mtime: stat.mtimeMs, logFile: file, logSize: Buffer.byteLength(text), evidence, currentCredit: parsed.currentCredit, currentCourse: parsed.currentCourse, progress: parsed.progress });
    }
  }
  // 站点最后一次答复是权威：拒绝 => 额度仍受限（且须仍属同一配额日，跨配额日后平台会放行）；
  // 放行 => 额度可用。没有答复（null）表示未知，交由调用方按保守策略处理。
  const last = lastRefusal && lastAccepted ? (lastRefusal.at >= lastAccepted.at ? lastRefusal : lastAccepted) : (lastRefusal || lastAccepted);
  Object.assign(result, {
    quotaDay: quotaDay(now),
    quotaBlocked: !last ? null : last === lastAccepted ? false : last.quotaDay === quotaDay(now),
    quotaCapDay: lastRefusal ? lastRefusal.quotaDay : null,
    quotaCapAt: lastRefusal ? lastRefusal.at : null,
  });
  return result;
}

export const POLICY = Object.freeze({ intervalMs: 30_000, staleMs: 180_000, cooldownMs: 120_000, windowMs: 1_800_000, maxRetries: 3, unknownAlertTicks: 2 });


export function evaluateAccount({ now, armed, observation, state = {} }) {
  if (!observation.known) return { status: 'unknown', action: 'none' };
  if (['manual-required', 'no-gain'].includes(observation.stopReason) && (!observation.stopDay || observation.stopDay === localDay(now))) return { status: 'protected', action: 'none' };
  if (observation.stopReason === 'completed' && (!observation.stopDay || observation.stopDay === localDay(now))) return { status: 'finished', action: 'none' };
  // 额度是否受限以站点答复为准，不再用自然日比较：配额周期跨午夜，昨夜达限不代表今天受限。
  if (observation.quotaBlocked === true) return { status: 'complete', action: 'none' };
  if (observation.quotaBlocked !== false && (observation.completedDay === localDay(now) || state.completedDay === localDay(now))) return { status: 'complete', action: 'none' };
  if (observation.learner) return { status: now - (observation.mtime ?? state.firstSeen ?? now) > POLICY.staleMs ? 'stale' : 'active', action: 'none' };
  if (!armed) return { status: 'disarmed', action: 'none' };
  if (observation.browser) return { status: 'browser-blocked', action: 'none' };
  const attempts = (state.attempts || []).filter(t => now - t <= POLICY.windowMs);
  if (attempts.length >= POLICY.maxRetries) return { status: 'retry-limit', action: 'none' };
  if (attempts.some(t => now - t < POLICY.cooldownMs)) return { status: 'cooldown', action: 'none' };
  return { status: 'missing', action: 'restart' };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('INVALID_LOCAL_STATE'); }
}

function atomicJson(file, value, immutable = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (immutable) {
      try { fs.linkSync(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } else fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const labelFor = (paths, account) => /^1[3-9]\d{9}$/.test(account.profile || account.user) ? paths.name : `profile-${digest(account.profile || account.user).slice(0, 8)}`;
function enqueue(root, key, message, now) {
  const id = `learning-${digest(key)}`;
  const directory = path.join(root, 'logs', 'learning-alerts');
  const file = path.join(directory, `${id}.json`);
  if (fs.existsSync(file) || fs.existsSync(path.join(directory, 'sent', `${id}.json`))) return;
  atomicJson(file, { id, created_at: new Date(now).toISOString(), message }, true);
}

export function recordPlaybackEvent(root, account, { kind, courseId, ratio, now = Date.now() }) {
  const messages = {
    reload: '检测到持续低速：连续两个60秒窗口播放不足60%，已请求重载媒体并恢复已看位置；正在复查。',
    restart: '媒体重载未能解决卡顿，当前学习器将安全退出，等待原监控按授权范围限次补启。',
    recovered: '卡顿恢复已确认：连续两个60秒窗口播放速度达到85%以上。',
  };
  if (!Object.hasOwn(messages, kind) || !Number.isFinite(now)) throw new Error('INVALID_PLAYBACK_EVENT');
  const paths = resolveProfilePaths(root, account.profile || account.user, account.user);
  enqueue(root, `${paths.key}:playback:${kind}:${String(courseId).replace(/[^\w-]/g, '').slice(0, 40)}:${now}`,
    `${labelFor(paths, account)}：${messages[kind]}`, now);
}

export function recordLearnerExit(root, account, { now = Date.now(), batchFatal = false, identityAccounts = [] } = {}) {
  const paths = resolveProfilePaths(root, account.profile || account.user, account.user);
  const label = labelFor(paths, account);
  let complete = false, stopped = null;
  try { const log = observeLogs(root, account, now, identityAccounts); complete = log.quotaBlocked === true; stopped = (!log.stopDay || log.stopDay === localDay(now)) ? log.stopReason : null; } catch { /* Unknown is never called completed. */ }
  if (['manual-required', 'no-gain', 'completed'].includes(stopped) && !batchFatal) {
    enqueue(root, `${paths.key}:stop:${stopped}:${localDay(now)}`, `${label}：${stopped === 'completed' ? '本次目标/课程处理已结束。' : '学习器主动保护停机，需要人工确认；不自动补启，不认定今日完成。'}`, now);
    return;
  }
  if (complete && !batchFatal) enqueue(root, `${paths.key}:quota-complete:v2:${quotaDay(now)}`, `${label}：已达今日上限，停止自动补启。`, now);
  else enqueue(root, `${paths.key}:${batchFatal ? 'batch-fatal' : 'child-exit'}:${now}`, `${label}：${batchFatal ? '批次主进程发生未捕获异常（含未处理 Promise 拒绝），事件已持久化；不能保证进程退出前完成通知。' : '学习子进程意外退出；已记录告警，等待安全观察后决定是否补启。'}`, now);
}

export function armLearningRun(root = ROOT, now = Date.now(), { accounts = [], daily = true } = {}) {
  const d = new Date(now);
  const arm = { accountKeys: accounts.map(a => resolveProfilePaths(root, a.profile || a.user, a.user).key), policy: { daily, newestSingle: true }, enabled: true, armed_at: new Date(now).toISOString(), expires_at: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString() };
  atomicJson(path.join(root, 'logs', 'learning-watchdog-arm.json'), arm);
  return arm;
}

export function isArmed(arm, now) {
  const expires = Date.parse(arm?.expires_at);
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return arm?.enabled === true && Number.isFinite(expires) && expires > now && expires <= midnight;
}

function playbackRecovered(pending, observation) {
  const e = observation.evidence;
  if (!pending || !observation.learner || !e || e.at < pending.launchedAt - 1000) return false;
  return e.file === pending.baselineFile ? e.offset >= pending.baselineSize : e.start >= pending.launchedAt - 1000;
}

export function acquireMonitorLock(root = ROOT) {
  const directory = path.join(root, 'logs');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'learning-watchdog.lock.json');
  const token = randomUUID();
  const alive = pid => {
    if (!Number.isInteger(pid) || pid <= 0) return true; // malformed lock is not safe to steal
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  };
  const claim = () => {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  try { claim(); } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('MONITOR_LOCK_FAILED');
    // Serialize stale-lock recovery. Never steal a recovery fence: fail closed if a
    // machine crash interrupts this tiny section; the fence then needs manual review.
    const fence = `${file}.recovery`;
    let fd;
    try { fd = fs.openSync(fence, 'wx', 0o600); } catch { return null; }
    try {
      let owner;
      try { owner = readJson(file, null); } catch { return null; }
      if (owner && alive(owner.pid)) return null;
      if (owner) fs.unlinkSync(file);
      try { claim(); } catch { return null; }
    } finally { fs.closeSync(fd); fs.unlinkSync(fence); }
  }
  const owned = () => {
    try { return readJson(file, null)?.token === token; } catch { return false; }
  };
  return { owned, release() { if (owned()) fs.unlinkSync(file); } };
}

export function launchAccount(account, root = ROOT, spawnFn = spawn, policy = { daily: true }) {
  return new Promise((resolve, reject) => {
    try {
      const child = spawnFn(process.execPath, [path.join(root, 'auto-learn.mjs'), `--profile=${account.profile || account.user}`, `--user=${account.user}`, `--pass=${account.pass}`, '--newest-single', ...(policy.daily ? ['--daily'] : [])], { cwd: root, windowsHide: true, stdio: 'ignore' });
      child.once('spawn', () => resolve({ pid: child.pid, proc: child }));
      child.on('error', () => reject(new Error('LEARNER_LAUNCH_FAILED')));
    } catch { reject(new Error('LEARNER_LAUNCH_FAILED')); }
  });
}

export async function tick({ root = ROOT, accounts, identityAccounts = accounts, now = Date.now(), dryRun = false, owner, isStopping = () => false, observe = observeAccounts, launch = launchAccount }) {
  const logs = path.join(root, 'logs');
  const arm = readJson(path.join(logs, 'learning-watchdog-arm.json'), null);
  const armed = isArmed(arm, now);
  const stateFile = path.join(logs, 'learning-watchdog-state.json');
  const state = readJson(stateFile, { version: 1, accounts: {} });
  const health = { timestamp: new Date(now).toISOString(), pid: process.pid, armed, dry_run: dryRun, observerVersion: 2, accounts: [] };
  let observations;
  try { observations = await observe({ root, accounts, identityAccounts, now }); } catch { observations = {}; }
  if (armed && !dryRun && state.armAnnounced !== arm.expires_at) {
    enqueue(root, `monitor:${arm.expires_at}`, '学习监控已启用；仅在本地当日授权范围内补启，恢复须由新播放日志确认。', now);
    state.armAnnounced = arm.expires_at;
  }
  for (const account of accounts) {
    const paths = resolveProfilePaths(root, account.profile || account.user, account.user);
    const label = labelFor(paths, account);
    const s = state.accounts[paths.key] ||= { attempts: [], firstSeen: now, incident: 0 };
    s.attempts = s.attempts.filter(t => now - t <= POLICY.windowMs);
    const observation = observations[paths.key] || { known: false, error: 'OBSERVER_FAILED' };
    const accountArmed = armed && arm.accountKeys?.includes(paths.key) && typeof arm.policy?.daily === 'boolean';
    if (observation.known && observation.quotaBlocked === false) {
      delete s.completedDay;
      delete s.completedQuotaDay;
    }
    const decision = evaluateAccount({ now, armed: accountArmed, observation, state: s });
    s.unknownTicks = decision.status === 'unknown' ? (Number.isSafeInteger(s.unknownTicks) && s.unknownTicks >= 0 ? s.unknownTicks : 0) + 1 : 0;
    if (decision.status !== 'unknown') s.unknownAlerted = false;
    if (decision.status !== s.lastStatus) s.incident++;
    const alert = (kind, message, unique = `${paths.key}:${localDay(now)}:${s.incident}:${kind}`) => {
      if (!dryRun) enqueue(root, unique, `${label}：${message}`, now);
    };
    if (['protected', 'finished'].includes(decision.status)) {
      delete s.pending;
      alert(decision.status, decision.status === 'protected' ? '学习器主动保护停机，需要人工确认；不自动补启，不认定今日完成。' : '本次学习目标/课程处理已结束，不自动补启。');
    }
    if (decision.status === 'complete') {
      s.completedDay = localDay(now);
      delete s.pending;
      alert('complete', '已达今日上限，停止自动补启。', `${paths.key}:quota-complete:v2:${quotaDay(now)}`);
    } else if (playbackRecovered(s.pending, observation)) {
      alert('recovered', '学习已恢复：检测到补启后的新播放日志。', `${paths.key}:recovered:${s.pending.launchedAt}`);
      delete s.pending;
    }
    if (decision.status === 'unknown' && s.unknownTicks >= POLICY.unknownAlertTicks && !s.unknownAlerted) {
      alert('unknown', `连续${s.unknownTicks}轮观察失败（${safeObserverError(observation.error)}），状态未知；禁止自动补启。`);
      s.unknownAlerted = true;
    }
    if (decision.status !== s.lastStatus) {
      if (armed && decision.status === 'stale') alert('stale', '日志超过180秒未更新；保留现有学习进程和浏览器，不重复启动。');
      if (armed && decision.status === 'browser-blocked') alert('blocked', '学习进程已退出，但对应浏览器仍存活；已阻止补启，不关闭浏览器。');
      if (armed && decision.status === 'retry-limit') alert('limit', '30分钟内已尝试补启3次，暂停补启。');
    }
    if (decision.action === 'restart' && !owner?.stopping && !isStopping()) {
      alert('interrupted', '学习进程和对应浏览器均已退出，准备安全补启。');
      if (!dryRun) {
        s.attempts.push(now);
        s.pending = { launchedAt: now, baselineFile: observation.logFile || null, baselineSize: observation.logSize || 0 };
        s.lastStatus = decision.status;
        // Reserve BEFORE the side effect. A crash consumes a retry conservatively.
        atomicJson(stateFile, state);
        try {
          const launched = await launch(account, root, undefined, arm.policy);
          owner?.add(launched?.proc);
          decision.status = 'restart-pending';
          alert('restart', '已请求补启，等待新播放日志；尚未确认恢复。', `${paths.key}:restart:${now}`);
        } catch {
          delete s.pending;
          decision.status = 'restart-failed';
          alert('spawn-failed', '补启启动失败；等待冷却后重试。', `${paths.key}:spawn-failed:${now}`);
        }
      }
    }
    s.lastStatus = decision.status;
    const observer = safeObserverDiagnostic(observation.observer);
    health.accounts.push({ profile: label, status: decision.status, action: dryRun ? decision.action : 'none', known: observation.known, learner: observation.learner ?? null, browser: observation.browser ?? null, mtime: observation.mtime ? new Date(observation.mtime).toISOString() : null, currentCredit: observation.currentCredit ?? null, course: observation.currentCourse || '', progress: observation.progress || '', attempts: s.attempts.length, unknownTicks: s.unknownTicks, ...(!observation.known ? { error: safeObserverError(observation.error) } : {}), ...(observer ? { observer } : {}) });
  }
  if (!dryRun) {
    atomicJson(stateFile, state);
    atomicJson(path.join(logs, 'learning-watchdog-health.json'), health);
    const diagnostics = health.accounts.filter(a => !a.known || a.observer?.failures.length).map(({ profile, status, error, observer, unknownTicks }) => ({ profile, status, ...(error ? { error } : {}), ...(observer ? { observer } : {}), unknownTicks }));
    if (diagnostics.length) fs.appendFileSync(path.join(logs, 'learning-observer-diagnostics.jsonl'), JSON.stringify({ timestamp: health.timestamp, pid: process.pid, accounts: diagnostics }) + '\n', { mode: 0o600 });
  }
  return health;
}

/** Interpreter candidates for the alert helper: configured path first, then every
 * installed Hermes environment (newest first). Hermes upgrades replace environment
 * directories, so a pinned path alone silently breaks every learning alert. */
export function alertPythonCandidates(home = path.join(os.homedir(), 'AppData', 'Local', 'hermes'), env = process.env) {
  const list = [];
  if (env.LEARNING_ALERT_PYTHON) list.push(env.LEARNING_ALERT_PYTHON);
  const installs = path.join(home, 'installs');
  const found = [];
  let installNames = [];
  try { installNames = fs.readdirSync(installs); } catch { installNames = []; }
  for (const install of installNames) {
    const environments = path.join(installs, install, 'environments');
    let environmentNames = [];
    try { environmentNames = fs.readdirSync(environments); } catch { continue; }
    for (const name of environmentNames) {
      const python = path.join(environments, name, 'venv', 'Scripts', 'python.exe');
      try { if (fs.statSync(python).isFile()) found.push({ python, mtime: fs.statSync(python).mtimeMs }); } catch { /* missing interpreter */ }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  list.push(...found.map(f => f.python));
  list.push(path.join(home, 'hermes-agent', 'venv', 'Scripts', 'python.exe'));
  return [...new Set(list)];
}

export async function notifyGateway(root = ROOT, exec = execFileAsync, { candidates } = {}) {
  const home = path.join(os.homedir(), 'AppData', 'Local', 'hermes');
  const helper = process.env.LEARNING_ALERT_HELPER || path.join(home, 'scripts', 'learning_gateway_alerts.py');
  const interpreters = Array.isArray(candidates) ? candidates : alertPythonCandidates(home);
  for (const python of interpreters) {
    try {
      await exec(python, [helper, '--root', root], { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      return { ok: true };
    } catch { /* try the next installed interpreter; never surface command output */ }
  }
  return { ok: false, error: 'NOTIFIER_FAILED' };
}

/** Bounded local drain; helper success alone is not proof of delivery. */
export async function drainNotifications(root, notify = notifyGateway, { retryDelayMs = 1000, deliveryAttempts = 3 } = {}) {
  let pending = null;
  const directory = path.join(root, 'logs', 'learning-alerts');
  const count = () => fs.existsSync(directory) ? fs.readdirSync(directory).filter(f => f.endsWith('.json')).length : 0;
  const limit = Math.max(1, Math.min(5, deliveryAttempts));
  for (let attempt = 1; attempt <= limit; attempt++) {
    let result;
    try { result = await notify(root); } catch { result = { ok: false }; }
    if (!result?.ok) {
      try { enqueue(root, `notifier:${localDay(Date.now())}`, '学习监控通知通道失败；事件仍在本地，尚未确认投递。正在进行有界重试。', Date.now()); } catch {}
    }
    try { pending = count(); } catch { pending = null; }
    if (result?.ok && pending === 0) return { ok: true, pending: 0, attempts: attempt };
    if (attempt < limit) await new Promise(resolve => setTimeout(resolve, Math.max(0, retryDelayMs)));
  }
  return { ok: false, error: 'UNDELIVERED_LOCAL', pending, attempts: limit };
}

/** Learning-scoped timer: no task/cron/service. */
export function startBatchMonitor({ root = ROOT, accounts, owner = createChildOwner(), tickFn = tick, notify = notifyGateway, intervalMs = POLICY.intervalMs, deferStart = false, ...options }) {
  const lock = acquireMonitorLock(root);
  if (!lock) return null;
  let timer, resolveFinished, running = false, stopping = false, started = false, unknownTicks = 0, pendingWake = false;
  const monitor = { done: false, health: null, finished: new Promise(resolve => { resolveFinished = resolve; }), stop,
    get ownsLock() { return lock.owned(); },
    start() {
      if (started || stopping) return;
      if (!lock.owned()) throw new Error('MONITOR_LOCK_LOST');
      started = true;
      queueMicrotask(step);
    },
    wake() { if (!started || stopping) return; if (running) pendingWake = true; else { clearTimeout(timer); queueMicrotask(step); } }
  };
  function stop(killOwned = true) {
    if (killOwned) owner.stop();
    stopping = true;
    clearTimeout(timer);
    if (!running) {
      lock.release();
      monitor.done = true;
      resolveFinished(monitor.health);
    }
  }
  async function step() {
    if (running) { pendingWake = true; return; }
    if (stopping || !lock.owned()) { stop(false); return; }
    running = true;
    try {
      monitor.health = await tickFn({ root, accounts, owner, ...options, isStopping: () => stopping });
      // Account-local unknown streaks are already persisted by tick. The global
      // counter is reserved for consecutive monitor/persistence exceptions.
      unknownTicks = 0;
      monitor.health.notifier = await drainNotifications(root, notify, options);
      atomicJson(path.join(root, 'logs', 'learning-watchdog-health.json'), monitor.health);
      const terminal = monitor.health.accounts.every(a => ['complete', 'protected', 'finished'].includes(a.status) || (!a.learner && ['disarmed', 'retry-limit', 'browser-blocked'].includes(a.status)) || (a.status === 'unknown' && a.unknownTicks >= 3));
      if (terminal) stopping = true;
    } catch {
      try {
        enqueue(root, `monitor-error:${localDay(Date.now())}`, '学习监控观察或持久化失败；禁止盲目补启，现有学习进程保持不变。', Date.now());
        monitor.health = { timestamp: new Date().toISOString(), pid: process.pid, armed: false, error: 'MONITOR_FAILED', accounts: accounts.map(a => ({ profile: labelFor(resolveProfilePaths(root, a.profile || a.user, a.user), a), status: 'unknown', known: false })) };
      } catch { /* Persistence failure must never launch a learner. */ }
      const delivery = await drainNotifications(root, notify, options);
      monitor.health ||= { error: 'MONITOR_FAILED', accounts: [] };
      monitor.health.notifier = delivery;
      try { atomicJson(path.join(root, 'logs', 'learning-watchdog-health.json'), monitor.health); } catch {}
      unknownTicks++;
      if (unknownTicks >= 3) stopping = true;
    } finally {
      running = false;
      if (stopping) stop(false);
      else { timer = setTimeout(step, pendingWake ? 0 : Math.max(POLICY.intervalMs, intervalMs)); pendingWake = false; }
    }
  }
  if (!deferStart) monitor.start();
  return monitor;
}

export function loadWatchdogAccounts(root = ROOT) {
  try {
    const accounts = readJson(path.join(root, 'accounts.local.json'), null);
    if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 3) throw new Error();
    const seen = new Set();
    for (const a of accounts) {
      const profile = a.profile || a.user;
      if (typeof profile !== 'string' || !profile || profile !== profile.trim() || typeof a.user !== 'string' || !a.user.trim() || typeof a.pass !== 'string' || !a.pass || seen.has(profile)) throw new Error();
      resolveProfilePaths(root, profile, a.user);
      seen.add(profile);
    }
    return accounts;
  } catch { throw new Error('AUTHORIZED_ACCOUNTS_INVALID'); }
}

async function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1] || ROOT) : ROOT;
  const accounts = loadWatchdogAccounts(root);
  const dryRun = args.includes('--dry-run');
  if (dryRun && !args.includes('--once')) throw new Error('DRY_RUN_REQUIRES_ONCE');
  if (args.includes('--once')) {
    if (dryRun) {
      console.log(JSON.stringify(await tick({ root, accounts, dryRun: true }), null, 2));
      return;
    }
    const lock = acquireMonitorLock(root);
    if (!lock) return;
    try { console.log(JSON.stringify(await tick({ root, accounts }), null, 2)); await notifyGateway(root); } finally { lock.release(); }
    return;
  }
  // Default and --attach are learning-scoped, NOT a forever daemon.
  const monitor = startBatchMonitor({ root, accounts });
  if (!monitor) return;
  const stop = () => monitor.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await monitor.finished; } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('WATCHDOG_FAILED: invalid configuration or observation; no unsafe restart.'); process.exitCode = 1; });
}
