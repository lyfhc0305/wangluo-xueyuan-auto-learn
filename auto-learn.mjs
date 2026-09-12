#!/usr/bin/env node
/**
 * 河南干部网络学院 —— 自动学习助手
 * https://www.hngbwlxy.gov.cn/
 *
 * 工作方式(严格按真实播放计时,不做任何进度伪造):
 *   1. 打开真实 Chrome 窗口,账号密码由使用者本人输入(或写在 config.json)
 *   2. 读取课程中心,挑出「选课状态 = 未选课」的视频课程
 *   3. 自动选课,打开播放页,读取视频总时长
 *   4. 按 1 倍速真实播放,直到视频结束,然后关闭播放窗口
 *   5. 重复 2-4,直到累计学时/学分达到目标
 *
 * 用法:
 *   node auto-learn.mjs                   完整自动学习(目标取 config.json,默认 5)
 *   node auto-learn.mjs --credit=5        指定目标学时/学分
 *   node auto-learn.mjs --only=9504       只处理指定课程 ID(用于验证/补课)
 *   node auto-learn.mjs --max-courses=1   本次最多学几门
 *   node auto-learn.mjs --list            只列出「未选课」课程,不学习
 *   node auto-learn.mjs --diagnose        诊断:打印接口状态摘要
 *   node auto-learn.mjs --reset-profile   清除登录会话
 *   node auto-learn.mjs --no-keep-visible 关闭「保持页面可见」补丁(见 README)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://www.hngbwlxy.gov.cn/';
const LOG_DIR = path.join(ROOT, 'logs');
const CONFIG_FILE = path.join(ROOT, 'config.json');

// ───────────────────────────── 参数 / 配置 ─────────────────────────────

const argv = process.argv.slice(2);
const hasFlag = n => argv.includes('--' + n);
const optVal = (n, d) => {
  const hit = argv.find(a => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : d;
};

/**
 * 会话目录。默认 .chrome-profile;用 --profile=张三 可以给不同账号各建一个,
 * 两个账号的登录态互不干扰,学习记录(state-*.json)也是按 profile 隔离的。
 */
const PROFILE_NAME = String(optVal('profile', '') || '').trim();
// 净化后的名字会折叠(如 a/b、a:b、a_b 都会变成 a_b),再追加 6 位哈希区分。
const PROFILE_SAFE = PROFILE_NAME.replace(/[\\/:*?"<>|]/g, '_');
const PROFILE_HASH = PROFILE_NAME ? createHash('sha1').update(PROFILE_NAME, 'utf8').digest('hex').slice(0, 6) : '';
const PROFILE_TAG = PROFILE_NAME ? `${PROFILE_SAFE}-${PROFILE_HASH}` : '';
const PROFILE_DIR = PROFILE_NAME
  ? path.join(ROOT, `.chrome-profile-${PROFILE_TAG}`)
  : path.join(ROOT, '.chrome-profile');

// 不同 --profile 共用 state.json 会串课(已选/失败记录互相污染)。
// 默认 profile 沿用 state.json(兼容老用户)；命名 profile 用独立文件。
const STATE_FILE = PROFILE_NAME
  ? path.join(ROOT, `state-${PROFILE_TAG}.json`)
  : path.join(ROOT, 'state.json');

// 兼容上一版命名(无哈希后缀):.chrome-profile-<safe> / state-<safe>.json。
// 升级后若新路径不存在但旧路径存在,会自动迁移并打日志。
const LEGACY_PROFILE_DIR = PROFILE_NAME ? path.join(ROOT, `.chrome-profile-${PROFILE_SAFE}`) : null;
const LEGACY_STATE_FILE = PROFILE_NAME ? path.join(ROOT, `state-${PROFILE_SAFE}.json`) : null;

const DEFAULT_CONFIG = {
  username: '',
  password: '',
  targetCredit: 5,
  keepVisible: true,
  muteAudio: true,
  maxDurationFactor: 2.5,   // 单门课最长等待 = 视频时长 × 该系数 + 额外分钟
  maxExtraMinutes: 15,
  maxCoursesPerRun: 0,      // 0 = 不限制
};

function loadConfig() {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) { console.error('config.json 解析失败,已忽略:', e.message); }
  }
  const cfg = { ...DEFAULT_CONFIG, ...fileCfg };
  cfg.targetCredit = Number(optVal('credit', cfg.targetCredit));
  if (!isFinite(cfg.targetCredit)) cfg.targetCredit = 5;
  cfg.only = optVal('only', null);
  if (cfg.only) cfg.only = String(cfg.only);
  cfg.maxCoursesPerRun = Number(optVal('max-courses', cfg.maxCoursesPerRun)) || 0;
  if (hasFlag('no-keep-visible')) cfg.keepVisible = false;
  if (hasFlag('no-mute')) cfg.muteAudio = false;
  cfg.listOnly = hasFlag('list');
  cfg.diagnose = hasFlag('diagnose');
  cfg.keepOpen = hasFlag('keep-open');
  cfg.logout = hasFlag('logout');
  cfg.profileName = PROFILE_NAME;
  // --daily: 学到站点当日上限为止(推荐的日常用法,一天 5 学时)
  if (hasFlag('daily')) cfg.targetCredit = Number.POSITIVE_INFINITY;
  return cfg;
}

// ───────────────────────────── 日志 ─────────────────────────────

let logStream = null;
const t0 = Date.now();
const pad = n => String(n).padStart(2, '0');
function log(...parts) {
  const d = new Date();
  const ts = d.toLocaleTimeString('zh-CN', { hour12: false });
  const e = Math.floor((Date.now() - t0) / 1000);
  const stamp = `${pad(Math.floor(e / 3600))}:${pad(Math.floor(e / 60) % 60)}:${pad(e % 60)}`;
  const line = `[${ts} +${stamp}] ${parts.join(' ')}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtTime = s => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch {}
}

// ───────────────────────────── 浏览器 ─────────────────────────────

/**
 * 查找浏览器可执行文件。puppeteer-core 不带浏览器,必须用系统已装的
 * Chrome / Edge / Chromium。这里覆盖 Windows / macOS / Linux 三种常见位置,
 * 也支持用环境变量 CHROME_PATH 直接指定。
 */
function findBrowser() {
  const cands = [];
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);

  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const la = process.env.LOCALAPPDATA || '';
    cands.push(
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      la && path.join(la, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    const home = process.env.HOME || '';
    cands.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      home && path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    );
  } else {
    cands.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
      '/snap/bin/chromium', '/opt/google/chrome/chrome',
      '/usr/lib/chromium/chromium',
    );
  }

  for (const c of cands) if (c && fs.existsSync(c)) return c;

  // 再从 PATH 里找一遍
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome'];
  for (const n of names) {
    try {
      const out = execSync(process.platform === 'win32' ? `where ${n}` : `command -v ${n}`,
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim().split(/\r?\n/)[0];
      if (out && fs.existsSync(out)) return out;
    } catch { /* 忽略 */ }
  }

  throw new Error('未找到 Chrome / Edge。请先安装 Chrome,或设置环境变量 CHROME_PATH 指向浏览器可执行文件');
}

/**
 * 上一个进程异常退出时可能留下占用 profile 的浏览器,导致再次启动报
 * "The browser is already running for ..."。这里只结束命令行里带本项目
 * profile 路径的进程,不会影响使用者自己的浏览器。
 */
function killLeftoverChrome() {
  try {
    if (process.platform === 'win32') {
      // 路径走环境变量传入,匹配用 .Contains() 而不用 -like,
      // 彻底绕开单引号/通配符/正则三层转义问题。单引号字符串里反引号
      // 不是转义符,之前在 pattern 里插反引号反而会把匹配搞坏。
      const ps = `$p = $env:LEARN_PROFILE_DIR; `
        + `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | `
        + `Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) } | `
        + `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        stdio: 'ignore', timeout: 30000,
        env: { ...process.env, LEARN_PROFILE_DIR: PROFILE_DIR },
      });
    } else {
      // pkill -f 收的是 ERE 正则,路径里的 .[]()+ 等都要转义,
      // 否则 a[1] 会误命中 a1 的进程。用参数数组避免 shell 注入。
      const re = PROFILE_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      spawnSync('pkill', ['-f', re], { stdio: 'ignore', timeout: 30000 });
    }
    return true;
  } catch { return false; }
}

async function preparePage(page, cfg) {
  await page.evaluateOnNewDocument((keepVisible) => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch {}
    if (keepVisible) {
      // 播放页在页面转为隐藏时会暂停。这里让页面始终认为可见,避免窗口被遮挡时白等。
      // 注意:视频本身仍是 1 倍速真实播放,不涉及进度伪造。
      try {
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
      } catch {}
    }
  }, cfg.keepVisible);

  // 站点使用原生 alert(如「同时只能打开一门课程」),必须接管,否则会卡住
  page.on('dialog', async d => {
    log(`  ⚠ 页面弹窗: ${d.message().replace(/\s+/g, ' ').slice(0, 160)}`);
    try { await d.accept(); } catch {}
  });
  page.on('pageerror', e => log(`  ⚠ 页面脚本错误: ${String(e.message).slice(0, 160)}`));
}

// ───────────────────────────── 站点接口 ─────────────────────────────

async function api(page, apiPath, data = {}) {
  return await page.evaluate(async (apiPath, data) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(data || {})) body.append(k, v == null ? '' : String(v));
    try {
      const r = await fetch('/api/' + apiPath, {
        method: 'POST', credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: body.toString(),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: r.status, ok: r.ok, json, text: json ? null : text.slice(0, 300) };
    } catch (e) {
      return { status: 0, ok: false, json: null, text: 'fetch failed: ' + e.message };
    }
  }, apiPath, data);
}

async function getAntiForgeryToken(page) {
  return await page.evaluate(async () => {
    try {
      const res = await fetch('/api/Page/AntiForgeryToken', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: '',
      });
      const j = await res.json();
      const m = /name="([^"]+)"[^>]*value="([^"]+)"/.exec(j.html || '');
      return m ? { name: m[1], value: m[2] } : null;
    } catch { return null; }
  });
}

// ───────────────────────────── 登录 ─────────────────────────────

async function isLoggedIn(page) {
  const r = await api(page, 'Info/GetUserInfo', {});
  return !!(r.json && r.json.Data && r.json.Data.IsOnline === true);
}

async function openLoginModal(page) {
  await page.evaluate(() => {
    const el = document.getElementById('loginModal');
    if (!el) return;
    if (window.$ && window.$.fn && window.$.modal) window.$(el).modal('show');
    else { el.classList.add('in'); el.style.display = 'block'; el.style.opacity = '1'; }
  });
  await sleep(800);
}

async function loginFormNeedsCaptcha(page) {
  return await page.evaluate(() => {
    const f = document.querySelector('#loginModal .ValidateCodeform');
    return !!(f && !f.classList.contains('ng-hide'));
  });
}

async function fillLoginForm(page, username, password) {
  return await page.evaluate((username, password) => {
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const acct = document.querySelector('#loginModal input[ng-model="login.Account"]');
    const pwd = document.querySelector('#loginModal input[ng-model="login.PassWord"]');
    if (acct) setVal(acct, username);
    if (pwd) setVal(pwd, password);
    return { filledAccount: !!acct, filledPassword: !!pwd };
  }, username, password);
}

async function clickLoginButton(page) {
  return await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#loginModal .btn')]
      .find(b => (b.innerText || '').trim() === '登录');
    if (btn) { btn.click(); return true; }
    return false;
  });
}

async function ensureLoggedIn(page, cfg) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(3000);

  if (await isLoggedIn(page)) {
    log('✔ 检测到已登录会话(浏览器配置已保存,无需重复登录)');
    return true;
  }

  log('▶ 尚未登录,正在打开登录框…');
  await openLoginModal(page);

  const needsCaptcha = await loginFormNeedsCaptcha(page);
  let autoSubmitted = false;

  if (cfg.username && cfg.password) {
    const f = await fillLoginForm(page, cfg.username, cfg.password);
    log(`  已从 config.json 填入账号(账号${f.filledAccount ? '√' : '×'} 密码${f.filledPassword ? '√' : '×'})`);
    if (!needsCaptcha) {
      await sleep(500);
      autoSubmitted = await clickLoginButton(page);
      if (autoSubmitted) log('  已自动提交登录…');
      await sleep(4000);
      if (await isLoggedIn(page)) { log('✔ 登录成功'); return true; }
      log('  ✖ 自动登录未成功(可能需要验证码/滑块),请手动完成');
      await openLoginModal(page);
    } else {
      log('  ⚠ 该账号需要图形验证码,请手动输入');
    }
  }

  if (!autoSubmitted) {
    log('');
    log('  ┌────────────────────────────────────────────────────────┐');
    log('  │  请在弹出的浏览器窗口中输入【账号】【密码】并点击登录   │');
    log('  │  若出现图形验证码或滑块,请手动完成                     │');
    log('  │  登录成功后程序会自动继续,最长等待 10 分钟             │');
    log('  └────────────────────────────────────────────────────────┘');
    log('');
  }

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      if (await isLoggedIn(page)) {
        log('✔ 登录成功,开始自动学习');
        await sleep(1500);
        return true;
      }
    } catch { /* 页面跳转中,忽略 */ }
  }
  throw new Error('等待登录超时(10 分钟)。请重新运行程序。');
}

// ───────────────────────────── 课程列表 ─────────────────────────────

const mapCourse = c => ({
  id: c.Id,
  name: c.Name,
  credit: Number(c.Credit) || 0,
  learning: c.Learning == null ? -1 : Number(c.Learning),
  standards: String(c.Standards || ''),
  type: String(c.Type || ''),
  time: Number(c.Time) || 0,
  required: !!c.RequiredFlag,
});

/**
 * 会员课程列表 —— 必须用 Page/CourseList。
 * 首页用的 Page/CourseListSy 是公开列表,其 Learning 恒为 -1,不能判断选课状态。
 * 这里返回的 Learning 就是本人学习进度:-1 未选课,0~1 在学(=浏览百分比)。
 */
async function fetchCourses(page, maxPages = 10) {
  const seen = new Map();
  let total = 0;
  for (let p = 1; p <= maxPages; p++) {
    const r = await api(page, 'Page/CourseList', {
      page: p, rows: 200, sort: 'Sort', order: 'desc',
      courseType: '', channelId: '', channelCode: '', title: '',
      titleNav: '课程中心', wordLimt: 35, teacher: '', flag: 'All',
    });
    const d = (r.json && r.json.Data) || {};
    total = d.Count || total;
    const list = d.ListData || [];
    if (!list.length) break;
    for (const c of list) if (!seen.has(c.Id)) seen.set(c.Id, mapCourse(c));
    if (seen.size >= total) break;
  }
  return [...seen.values()];
}

/** 我的课程与进度: id -> { browseScore, credit } */
async function fetchMyCourses(page, maxPages = 20) {
  const m = new Map();
  let creditSum = 0, finish, unfinish, count = 0;
  for (let p = 1; p <= maxPages; p++) {
    const r = await api(page, 'Page/MyStudyStat', {
      page: p, rows: 500, sort: 'Id', order: 'desc', titleNav: '学习统计',
    });
    const d = (r.json && r.json.Data) || {};
    // 第一页带汇总字段，后续页只补 ListData
    if (p === 1) {
      creditSum = Number(d.CreditSum) || 0;
      finish = d.FinishCourse; unfinish = d.UnFinishCourse; count = d.Count;
    }
    const list = d.ListData || [];
    if (!list.length) break;
    for (const c of list) {
      if (!m.has(c.Id)) m.set(c.Id, { browseScore: Number(c.BrowseScore) || 0, credit: Number(c.Credit) || 0, name: c.Name });
    }
    // 之前版本只取第一页(rows=500)，课多时会被截断导致误判“无课可学”
    if (typeof count === 'number' && m.size >= count) break;
    if (list.length < 500) break;
  }
  return { map: m, creditSum, finish, unfinish, count };
}

const isVideo = c => c.standards.toLowerCase() === 'mp4';
const isUnselected = c => c.learning < 0;

// ───────────────────────────── 选课 ─────────────────────────────

async function enrollCourses(page, ids) {
  const token = await getAntiForgeryToken(page);
  const data = { checkValue: ids.join(',') };
  if (token) data[token.name] = token.value;
  const r = await api(page, 'Page/AddStudyCourse', data);
  return r.json;
}

// ───────────────────────────── 学分 / 学时 ─────────────────────────────

/**
 * 平台的"学分"指标实际是 MyStudyStat.Data.CreditSum(个人中心叫「所获学时」)。
 * 逐个接口尝试,并尽量精确到 CreditSum 字段。
 */
async function getCredit(page) {
  const r = await api(page, 'Page/MyStudyStat', {
    page: 1, rows: 10, sort: 'Id', order: 'desc', titleNav: '学习统计',
  });
  const d = r.json && r.json.Data;
  if (d) {
    for (const k of ['CreditSum', 'TotalCredit', 'StudyCredit', 'TotalScore']) {
      if (typeof d[k] === 'number') return { value: d[k], source: `MyStudyStat.${k}`, exact: true };
    }
    for (const k of Object.keys(d)) {
      if (/credit/i.test(k) && typeof d[k] === 'number') return { value: d[k], source: `MyStudyStat.${k}`, exact: true };
    }
  }
  const r2 = await api(page, 'Info/GetUserInfo', {});
  const d2 = r2.json && r2.json.Data;
  if (d2) for (const k of Object.keys(d2)) {
    if (/credit/i.test(k) && typeof d2[k] === 'number') return { value: d2[k], source: `GetUserInfo.${k}`, exact: false };
  }
  return { value: null, source: '未能获取', exact: false };
}

// ───────────────────────────── 播放 ─────────────────────────────

/**
 * 播放页的「向右滑动箭头填充拼图」验证。
 *
 * 该组件结构: 一个 310x155 的背景 canvas(缺口处被半透明白色漂白)
 *            + 一个 63x155 的 canvas.block(拼图块,初始 left=0)
 *            + .slider 拖动手柄
 *
 * 求解思路: 用拼图块的 alpha 掩膜在背景上滑动,取「掩膜区域平均亮度最高」
 *          的偏移量 —— 即被漂白的缺口位置,就是 canvas.block 需要移动的像素数。
 *          注意手柄位移与拼图块位移并非 1:1(实测比例 25/27≈0.9259),
 *          所以先在拖拽中做一次微校准,再换算出手柄需要移动的距离。
 */
async function solvePlayGate(page, maxAttempts = 5) {
  const hasSlider = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')];
    return cs.some(c => (c.className || '').toString().includes('block')) && !!document.querySelector('.slider');
  });
  if (!hasSlider) return 'no-slider';

  log('  ⚠ 检测到播放前的拼图滑块验证,正在自动求解…');

  let noEffectStreak = 0;   // 连续"拖拽无反应"次数

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const a = await page.evaluate(() => {
      const cs = [...document.querySelectorAll('canvas')];
      const bg = cs.find(c => !(c.className || '').toString().includes('block'));
      const blk = cs.find(c => (c.className || '').toString().includes('block'));
      const sl = document.querySelector('.slider');
      if (!bg || !blk || !sl) return { err: 'no-canvas' };
      const w = bg.width, h = bg.height, bw = blk.width;
      let bgd, bld;
      try {
        bgd = bg.getContext('2d').getImageData(0, 0, w, h).data;
        bld = blk.getContext('2d').getImageData(0, 0, bw, h).data;
      } catch (e) { return { err: 'tainted: ' + e.message }; }

      const mask = new Uint8Array(bw * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < bw; x++) {
        if (bld[(y * bw + x) * 4 + 3] > 128) mask[y * bw + x] = 1;
      }
      const maxOff = w - bw;
      const sB = [], sW = [];
      for (let off = 0; off <= maxOff; off++) {
        let sb = 0, sw = 0, n = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < bw; x++) {
          if (!mask[y * bw + x]) continue;
          const i = (y * w + (x + off)) * 4;
          sb += (bgd[i] + bgd[i + 1] + bgd[i + 2]) / 3;
          sw += Math.min(bgd[i], bgd[i + 1], bgd[i + 2]);
          n++;
        }
        sB.push(sb / n); sW.push(sw / n);
      }
      const argmax = arr => arr.indexOf(Math.max(...arr));

      // 手柄会随拖拽移动,每次都必须重新读取它的实时位置
      const r = sl.getBoundingClientRect();
      return {
        bestB: argmax(sB), bestW: argmax(sW), maxOff,
        curBlockLeft: Math.max(0, parseFloat(blk.style.left || '0') || 0),
        hx: r.x + r.width / 2, hy: r.y + r.height / 2,
      };
    });

    if (a.err) { log('    ✖ 图像分析失败: ' + a.err); return 'failed'; }
    const target = a.bestW;
    if (Math.abs(a.bestB - a.bestW) > 10) log(`    ⚠ 两种算法的缺口判定不一致(${a.bestB} vs ${a.bestW}),采用后者`);
    log(`    第 ${attempt} 次尝试: 目标偏移 ${target}px(当前 ${a.curBlockLeft.toFixed(1)}px)`);

    const readBlockLeft = () => page.evaluate(() =>
      Math.max(0, parseFloat((document.querySelector('canvas.block') || {}).style?.left || '0') || 0));

    try {
      await page.mouse.move(a.hx, a.hy);
      await page.mouse.down();

      // 微校准:移 20px 读实际位移,求出手柄→拼图块的换算比例(实测约 0.9259)
      const before = await readBlockLeft();
      await page.mouse.move(a.hx + 20, a.hy);
      await sleep(80);
      const after = await readBlockLeft();
      const ratio = (after - before) / 20;
      const curHandle = a.hx + 20;
      const curBlock = after;

      let dist;
      if (ratio > 0.3 && ratio < 2) {
        dist = (target - curBlock) / ratio;          // 还差多少(按当前绝对位置算)
      } else {
        dist = target - curBlock;                     // 比例异常时退回 1:1
        log(`    ⚠ 校准比例异常(${ratio.toFixed(4)}),按 1:1 处理`);
      }
      // 比例≈0 说明手柄拖动完全没带动拼图块 —— 页面根本不接受拖拽,
      // 通常是当日学时已达上限/播放被限制。这种情况再试也没用,早点退出。
      if (ratio <= 0.15) {
        noEffectStreak++;
        log(`    ⚠ 拖拽无任何反应(${noEffectStreak}/2)`);
      } else {
        noEffectStreak = 0;
      }

      log(`    校准比例 ${ratio.toFixed(4)} → 手柄再移动 ${dist.toFixed(1)}px`);

      const steps = 26;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(curHandle + dist * i / steps, a.hy + (i % 2 ? 0.8 : -0.8));
        await sleep(14);
      }
      await sleep(160);
      await page.mouse.up();
      await sleep(3000);
    } catch (e) {
      log('    ✖ 拖拽执行失败: ' + e.message);
      try { await page.mouse.up(); } catch {}
    }

    const st = await page.evaluate(() => ({ hasVideo: !!document.querySelector('video') }));
    if (st.hasVideo) { log('    ✔ 验证通过'); return 'ok'; }

    if (noEffectStreak >= 2) {
      log('    ✖ 连续两次拖拽完全无反应 —— 页面很可能已限制播放(如当日学时已达上限)');
      return 'blocked';
    }

    // 未通过:点一下刷新图标换一张拼图再试,避免卡在同一张
    log('    ✖ 未通过,刷新拼图后重试…');
    await page.evaluate(() => {
      const r = document.querySelector('.refreshIcon');
      if (r) r.click();
    });
    await sleep(1800);
  }

  log('  ⚠ 自动求解失败,请在浏览器中手动完成拼图验证(最多等待 2 分钟)');
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (await page.evaluate(() => !!document.querySelector('video'))) {
      log('  ✔ 验证已通过'); return 'ok';
    }
  }
  return 'failed';
}

async function readVideoState(page) {
  return await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return { hasVideo: false };
    const qm = document.querySelector('.questionModal');
    const quizOpen = !!(qm && qm.classList.contains('in') && getComputedStyle(qm).display !== 'none');
    return {
      hasVideo: true,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      currentTime: Number(v.currentTime) || 0,
      paused: v.paused, ended: v.ended,
      muted: v.muted, playbackRate: v.playbackRate, quizOpen,
    };
  });
}

async function ensurePlaying(page, muteAudio = true) {
  return await page.evaluate((muteAudio) => {
    const v = document.querySelector('video');
    if (!v) return false;
    if (muteAudio) v.muted = true;
    if (v.playbackRate !== 1) v.playbackRate = 1;
    if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    return !v.paused;
  }, muteAudio);
}

async function playCourse(browser, cfg, course, mainPage) {
  const player = await browser.newPage();
  await preparePage(player, cfg);

  const url = `${BASE}#/play/play?Id=${course.id}`;
  log(`  → 打开播放页: ${url}`);

  // 站点限制同一账号同时只能播放一门课。上一门刚关闭时立刻打开新播放页,
  // 会弹「同时只能打开一门课程,请关闭之前页面,并于10秒后重试！」并拒绝加载。
  // 所以这里检测"页面既无视频也无滑块"的情况,等待后重试。
  let loaded = false;
  for (let openTry = 1; openTry <= 3; openTry++) {
    try {
      await player.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (e) {
      log(`  ✖ 打开播放页失败: ${e.message}`);
      await player.close().catch(() => {});
      return { ok: false, reason: 'open-failed' };
    }

    await sleep(4000);
    const ready = p => p.evaluate(() => {
      const cs = [...document.querySelectorAll('canvas')];
      return {
        hasVideo: !!document.querySelector('video'),
        hasGate: cs.some(c => (c.className || '').toString().includes('block')),
      };
    });
    const r0 = await ready(player);
    if (r0.hasVideo || r0.hasGate) { loaded = true; break; }

    log(`  ⚠ 播放页未加载出内容(疑似"同时只能打开一门课程"限制),等待 12 秒后重试(${openTry}/3)…`);
    await sleep(12000);
  }
  if (!loaded) {
    const body = await player.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200));
    log(`  ✖ 播放页始终未加载。页面提示: ${body}`);
    await player.close().catch(() => {});
    return { ok: false, reason: 'play-locked', retryable: true };
  }

  const gate = await solvePlayGate(player);
  if (gate === 'blocked') {
    log('  ✖ 页面不接受拖拽,判定为已限制播放');
    await player.close().catch(() => {});
    return { ok: false, reason: 'gate-blocked', retryable: true, blocked: true };
  }
  if (gate === 'failed') {
    log('  ✖ 未通过播放前验证,跳过该课程(稍后重跑会再试)');
    await player.close().catch(() => {});
    return { ok: false, reason: 'gate-failed', retryable: true };
  }

  let waited = 0;
  let st = await readVideoState(player);
  while (!st.hasVideo && waited < 60) { await sleep(2000); waited += 2; st = await readVideoState(player); }
  if (!st.hasVideo) {
    const body = await player.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 240));
    log(`  ✖ 60 秒内未出现视频元素。页面提示: ${body}`);
    await player.close().catch(() => {});
    return { ok: false, reason: 'no-video', retryable: true };
  }

  waited = 0;
  while ((!st.duration || !isFinite(st.duration)) && waited < 60) {
    await sleep(2000); waited += 2; await ensurePlaying(player, cfg.muteAudio); st = await readVideoState(player);
  }
  if (!st.duration || !isFinite(st.duration)) {
    log('  ✖ 无法读取视频时长,跳过该课程');
    await player.close().catch(() => {});
    return { ok: false, reason: 'no-duration', retryable: true };
  }

  const duration = st.duration;
  const startAt = st.currentTime || 0;
  const remain = Math.max(1, duration - startAt);
  log(`  ▶ 开始播放《${course.name}》`);
  log(`    视频总时长 ${fmtTime(duration)}(从 ${fmtTime(startAt)} 继续),预计需要 ${fmtTime(remain)}`);

  const hardDeadline = Date.now() + remain * 1000 * cfg.maxDurationFactor + cfg.maxExtraMinutes * 60 * 1000;
  let lastLog = 0, lastPos = startAt, stalledSince = 0, quizNotified = false;

  while (true) {
    await sleep(2000);
    st = await readVideoState(player);

    if (!st.hasVideo) { log('  ⚠ 视频元素消失,视为播放结束'); break; }

    if (st.quizOpen && !quizNotified) {
      quizNotified = true;
      log('');
      log('  ┌────────────────────────────────────────────────────────┐');
      log('  │  ❗ 出现随堂答题,视频已暂停 —— 请到浏览器中手动作答      │');
      log('  │  答完会自动继续播放(程序不会替你作答)                 │');
      log('  └────────────────────────────────────────────────────────┘');
      log('');
      try { await player.bringToFront(); } catch {}
    }
    if (!st.quizOpen && quizNotified) { quizNotified = false; log('  ✔ 答题完成,继续播放'); }

    if (st.ended || (st.duration && st.currentTime >= st.duration - 1.2)) {
      log(`  ✔ 播放完毕(${fmtTime(st.currentTime)} / ${fmtTime(st.duration)})`);
      break;
    }

    if (Math.abs(st.currentTime - lastPos) < 0.4) {
      if (!stalledSince) stalledSince = Date.now();
      if (Date.now() - stalledSince > 25000 && !st.quizOpen) {
        log('  ⚠ 播放停滞,尝试恢复播放…');
        await ensurePlaying(player, cfg.muteAudio);
        stalledSince = Date.now();
      }
    } else { stalledSince = 0; lastPos = st.currentTime; }

    if (Date.now() - lastLog > 60000) {
      lastLog = Date.now();
      const pct = ((st.currentTime / st.duration) * 100).toFixed(1);
      log(`    …播放中 ${fmtTime(st.currentTime)} / ${fmtTime(st.duration)} (${pct}%)${st.paused ? ' [暂停中]' : ''}`);
    }

    if (Date.now() > hardDeadline) {
      log('  ⚠ 超过预设最长等待时间,放弃该课程');
      await player.close().catch(() => {});
      return { ok: false, reason: 'timeout' };
    }
  }

  // 视频播完后不要立刻关窗口。
  // 站点的进度上报是每 60 秒一次(SingleProcessSubmit),关太快会丢掉最后一次
  // 上报 —— 实测出现过"视频明明播完了,服务端只记到 55%"的情况。
  // 这里轮询个人学习统计,等 BrowseScore 真正到 100 再关。
  log('  ⏳ 等待站点完成最后一次进度上报…');
  let finalScore = null;
  const reportDeadline = Date.now() + 100000;
  while (Date.now() < reportDeadline) {
    await sleep(4000);
    try {
      const mine = await fetchMyCourses(mainPage);
      const rec = mine.map.get(course.id);
      if (rec) {
        finalScore = rec.browseScore;
        if (finalScore >= 100) { log(`  ✔ 进度已入账: BrowseScore ${finalScore}`); break; }
      }
    } catch { /* 查询失败就再等一轮 */ }
  }
  if (finalScore !== null && finalScore < 100) {
    log(`  ⚠ 等待 100 秒后 BrowseScore 仍为 ${finalScore},稍后重跑该课程`);
  }

  await player.close().catch(() => {});
  log('  ✔ 已关闭播放窗口');
  try { await mainPage.bringToFront(); } catch {}
  return { ok: true, duration, browseScore: finalScore };
}

// ───────────────────────────── 退出登录 / 换账号 ─────────────────────────────

/**
 * 退出当前账号,为换账号做准备。
 *
 * 站点自己的退出流程是: POST /api/Page/LoginOut(带 __RequestVerificationToken),
 * 然后清 sessionStorage 并删除 isChange cookie。
 *
 * 但仅仅调这个接口还不够 —— 登录框的「记住密码」默认勾选,会把
 * base64(记住我|账号|密码) 存进名为 RM 的 Cookie 保留 7 天,所以下次打开
 * 还会自动带出上一个账号。这里额外清掉本站的全部 Cookie 和本地存储。
 */
async function performLogout(page) {
  log('▶ 正在退出当前账号…');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(3000);

  const before = await api(page, 'Info/GetUserInfo', {});
  const wasOnline = !!(before.json && before.json.Data && before.json.Data.IsOnline);
  log(`  当前登录状态: ${wasOnline ? '已登录' : '本来就未登录'}`);

  // 1) 调站点自己的退出接口
  try {
    const token = await getAntiForgeryToken(page);
    const data = {};
    if (token) data[token.name] = token.value;
    const r = await api(page, 'Page/LoginOut', data);
    log(`  退出接口: ${r.json ? JSON.stringify(r.json).slice(0, 160) : ('HTTP ' + r.status + ' ' + (r.text || ''))}`);
  } catch (e) {
    log('  ⚠ 退出接口调用失败: ' + e.message);
  }

  // 2) 清掉本站会话数据(含记住密码的 RM cookie)
  try {
    const client = typeof page.createCDPSession === 'function'
      ? await page.createCDPSession()
      : await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies');
    await client.send('Storage.clearDataForOrigin', {
      origin: new URL(BASE).origin,
      storageTypes: 'all',
    });
    await client.detach().catch(() => {});
    log('  已清除本站 Cookie、localStorage、sessionStorage');
  } catch (e) {
    log('  ⚠ 清除浏览数据失败: ' + e.message);
    log('    可改用 node auto-learn.mjs --reset-profile 彻底重置');
  }

  // 3) 复核
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(3000);
  const after = await api(page, 'Info/GetUserInfo', {});
  const stillOnline = !!(after.json && after.json.Data && after.json.Data.IsOnline);

  log('');
  if (stillOnline) {
    log('  ✖ 仍处于登录状态,清除未生效。');
    log('    请用:node auto-learn.mjs --reset-profile  (会删掉整个会话目录,需重新登录)');
    return false;
  }
  log('  ✔ 已退出登录。');
  log('  下次运行 node auto-learn.mjs 时,会重新弹出登录框,');
  log('  输入新账号的手机号/用户名和密码即可。');
  return true;
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
  const cfg = loadConfig();
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`);

  // --reset-profile 现在连记录文件一起清(之前只删会话目录,永久的 failed 标记清不掉);
  // 只想重学、不想重登录用 --reset-state。
  if (hasFlag('reset-profile')) {
    if (fs.existsSync(PROFILE_DIR)) {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
      console.log(`已清除会话目录(${path.basename(PROFILE_DIR)}),下次运行需要重新登录。`);
    }
    if (fs.existsSync(STATE_FILE)) {
      fs.rmSync(STATE_FILE, { force: true });
      console.log(`已清除记录文件(${path.basename(STATE_FILE)})。`);
    }
  }
  if (hasFlag('reset-state') && fs.existsSync(STATE_FILE)) {
    fs.rmSync(STATE_FILE, { force: true });
    console.log(`已清除记录文件(${path.basename(STATE_FILE)}),登录会话保留。`);
  }

  // 从无哈希旧命名迁移:新路径不存在但旧路径存在时自动搬家,避免重复登录/丢记录。
  if (PROFILE_NAME) {
    try {
      if (LEGACY_PROFILE_DIR && LEGACY_PROFILE_DIR !== PROFILE_DIR
        && !fs.existsSync(PROFILE_DIR) && fs.existsSync(LEGACY_PROFILE_DIR)) {
        fs.renameSync(LEGACY_PROFILE_DIR, PROFILE_DIR);
        console.log(`已迁移会话目录: ${path.basename(LEGACY_PROFILE_DIR)} → ${path.basename(PROFILE_DIR)}`);
      }
      if (LEGACY_STATE_FILE && LEGACY_STATE_FILE !== STATE_FILE
        && !fs.existsSync(STATE_FILE) && fs.existsSync(LEGACY_STATE_FILE)) {
        fs.copyFileSync(LEGACY_STATE_FILE, STATE_FILE);
        console.log(`已迁移记录文件: ${path.basename(LEGACY_STATE_FILE)} → ${path.basename(STATE_FILE)}`);
      } else if (!fs.existsSync(STATE_FILE) && !fs.existsSync(LEGACY_STATE_FILE)
        && fs.existsSync(path.join(ROOT, 'state.json'))) {
        // 之前所有 profile 共用 state.json 的老用户:旧文件还在,但本 profile 不会再读它。
        console.log(`提示:检测到旧的共用 state.json,本 profile(--profile=${PROFILE_NAME})改用 ${path.basename(STATE_FILE)},旧文件已不再读取,如需沿用可手动复制。`);
      }
    } catch (e) {
      console.log('迁移旧 profile 数据失败(不影响继续运行):' + e.message);
    }
  }

  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  log('══════════════════════════════════════════════════════');
  log(' 河南干部网络学院 · 自动学习助手');
  log(` 目标: ${cfg.targetCredit} 学时/学分${cfg.only ? ` 仅处理课程 ${cfg.only}` : ''}${cfg.maxCoursesPerRun ? ` 最多 ${cfg.maxCoursesPerRun} 门` : ''}`);
  log(` 会话目录: ${path.basename(PROFILE_DIR)}${cfg.profileName ? `  (--profile=${cfg.profileName})` : ''}`);
  log(` 记录文件: ${path.basename(STATE_FILE)}`);
  log(` 日志: ${logFile}`);
  log('══════════════════════════════════════════════════════');

  let browser = null;
  try {
    const chromePath = findBrowser();
    log(` 浏览器: ${chromePath}`);
    const launchOpts = {
      executablePath: chromePath,
      headless: false,
      userDataDir: PROFILE_DIR,
      defaultViewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--start-maximized',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=Translate,OptimizationHints',
        ...(cfg.muteAudio ? ['--mute-audio'] : []),
      ],
    };

    try {
      browser = await puppeteer.launch(launchOpts);
    } catch (e) {
      if (!/already running for/i.test(String(e.message))) throw e;
      log('⚠ 检测到上次运行残留的浏览器仍占用配置目录,正在清理…');
      killLeftoverChrome();
      await sleep(3000);
      // 若第二次仍抛 already running,直接进外层 catch 打日志退出,不再静默崩溃。
      browser = await puppeteer.launch(launchOpts);
    }

    const state = loadState();
    state.courses = state.courses || {};

    const page = (await browser.pages())[0] || await browser.newPage();
    await preparePage(page, cfg);
    // --logout: 只退出登录,然后结束(用于换账号或公用电脑上清理登录态)
    if (cfg.logout) {
      await performLogout(page);
      return;
    }

    await ensureLoggedIn(page, cfg);

    const mine = await fetchMyCourses(page);
    let credit = await getCredit(page);
    log(`当前进度: 学时/学分 ${credit.value} (来源 ${credit.source}) | 已完成 ${mine.finish} 门,未完成 ${mine.unfinish} 门,累计 ${mine.count} 门`);

    if (cfg.diagnose) {
      log('\n──── 诊断 ────');
      const ui = await api(page, 'Info/GetUserInfo', {});
      log('GetUserInfo: ' + JSON.stringify({ status: ui.status, online: ui.json?.Data?.IsOnline === true }));
      const cl = await api(page, 'Page/CourseList', { page: 1, rows: 5, sort: 'Sort', order: 'desc', courseType: '', channelId: '', channelCode: '', title: '', titleNav: '课程中心', wordLimt: 35, teacher: '', flag: 'All' });
      log('CourseList: ' + JSON.stringify({ status: cl.status, returnedRows: Array.isArray(cl.json?.Data?.ListData) ? cl.json.Data.ListData.length : 0 }));
      log('──── 诊断结束 ────\n');
      await sleep(2000);
      return;
    }

    let courses = await fetchCourses(page);
    log(`课程中心: 共 ${courses.length} 门(已抓取),未选课 ${courses.filter(isUnselected).length} 门,已选/在学 ${courses.filter(c => !isUnselected(c)).length} 门`);

    if (cfg.listOnly) {
      const pending = courses.filter(c => isUnselected(c) && isVideo(c));
      log(`\n未选课的可播放视频课程 (${pending.length} 门,按学时升序):`);
      pending.sort((a, b) => a.time - b.time)
        .slice(0, 60)
        .forEach((c, i) => log(`  ${String(i + 1).padStart(3)}. [${c.id}] ${c.name}  学分 ${c.credit}  时长参考 ${c.time}`));
      if (pending.length > 60) log(`  … 以及另外 ${pending.length - 60} 门`);
      return;
    }

    let round = 0;
    let dailyLimitHit = false;
    let noGainStreak = 0;            // 连续几门课没拿到学时(兜底:防每日上限空转)
    const skipThisRun = new Set();   // 本次运行内跳过(可重试的失败),不写进 state
    while (true) {
      if (!cfg.only && credit.value !== null && credit.value >= cfg.targetCredit - 1e-6) {
        log(`\n🎉 已达到目标: ${credit.value} ≥ ${cfg.targetCredit}`);
        break;
      }
      if (cfg.maxCoursesPerRun && round >= cfg.maxCoursesPerRun) {
        log(`\n已达到本次运行上限 ${cfg.maxCoursesPerRun} 门,结束。`);
        break;
      }

      let course;
      if (cfg.only) {
        courses = await fetchCourses(page);
        course = courses.find(c => String(c.id) === cfg.only);
        if (!course) { log(`✖ 未找到课程 ID ${cfg.only}`); break; }
      } else {
        courses = await fetchCourses(page);
        // 用个人学习统计里的 BrowseScore(0~100)判断"还没学满",这个口径
        // 不受 CourseList.Learning 到底是 0~1 还是 0~100 的影响,最可靠。
        // 只挑 Learning<0 的课会漏掉"已选但没看完"的课,那些课同样不给学分。
        const mineNow = (await fetchMyCourses(page)).map;
        const needsWork = c => {
          if (!isVideo(c)) return false;
          if (isUnselected(c)) return true;
          const rec = mineNow.get(c.id);
          return !!rec && rec.browseScore < 100;
        };
        const pending = courses
          .filter(needsWork)
          .filter(c => !skipThisRun.has(c.id))
          .filter(c => !(state.courses[c.id] && state.courses[c.id].failed))
          .sort((a, b) => {
            const ai = isUnselected(a) ? 1 : 0;   // 先把已选的半截课补完
            const bi = isUnselected(b) ? 1 : 0;
            return (ai - bi) || (b.required - a.required) || (a.time - b.time);
          });
        if (!pending.length) {
          log('\n没有需要继续学习的视频课程了。');
          break;
        }
        course = pending[0];
      }

      round++;
      log('');
      log(`──────── 第 ${round} 门 ────────`);
      log(`《${course.name}》 id=${course.id} 学分=${course.credit} 进度=${course.learning} 类型=${course.type}/${course.standards}`);

      // 1) 选课(已在学则跳过)
      if (isUnselected(course)) {
        log('  → 正在选课…');
        const enr = await enrollCourses(page, [course.id]);
        const msg = (enr && enr.Message ? String(enr.Message) : '');
        if (enr) {
          log(`    选课返回: Type=${enr.Type} Message=${msg.slice(0, 120)}`);
          // 站点有每日学时上限,达到后会返回这条提示。此时再选课/播放都没用,
          // 滑块也会失效,所以直接结束本次运行。
          if (/今天已累计学习|明天再继续|劳逸结合/.test(msg)) {
            dailyLimitHit = true;
            log('');
            log('  ╔══════════════════════════════════════════════════════╗');
            log('  ║  🛑 已达站点【每日学时上限】                          ║');
            log(`  ║  ${msg.slice(0, 48)}`);
            log('  ║  今天无法再获取学时,请明天再运行本程序。             ║');
            log('  ╚══════════════════════════════════════════════════════╝');
            log('');
            break;
          }
          if (!(enr.Type > 0)) {
            log('    ⚠ 选课未成功,跳过');
            state.courses[course.id] = { name: course.name, failed: true, reason: 'enroll: ' + msg };
            saveState(state);
            continue;
          }
        } else {
          log('    ⚠ 选课接口无响应,继续尝试直接播放');
        }
        await sleep(1500);
      } else {
        log('  → 该课程已在学习中,直接继续播放');
      }

      // 2) 播放到结束
      const before = (await fetchMyCourses(page)).map.get(course.id);
      const res = await playCourse(browser, cfg, course, page);
      state.courses[course.id] = {
        name: course.name, credit: course.credit, at: new Date().toISOString(),
        ok: res.ok, reason: res.reason || '', duration: res.duration || 0,
      };
      if (!res.ok) {
        if (res.blocked) {
          log('');
          log('  ╔══════════════════════════════════════════════════════╗');
          log('  ║  🛑 播放页拒绝拖拽验证 —— 多半是已达【每日学时上限】  ║');
          log('  ║  停止本次运行,请明天再试。                           ║');
          log('  ╚══════════════════════════════════════════════════════╝');
          log('');
          dailyLimitHit = true;
        }
        if (res.retryable) {
          // 可重试的失败(如验证没过/时长没读到): 本次运行跳过,但不写死,下次还会再试
          skipThisRun.add(course.id);
          state.courses[course.id].failed = false;
          state.courses[course.id].retryable = true;
        } else {
          state.courses[course.id].failed = true;
        }
      }
      saveState(state);
      // 关掉播放窗口后给站点留出释放"单课程锁"的时间
      await sleep(11000);

      // 3) 复核:该课程的浏览进度是否到 100
      await sleep(4000);
      const after = (await fetchMyCourses(page)).map.get(course.id);
      if (after) {
        const b0 = before ? before.browseScore : '未选课';
        log(`  课程进度复核: BrowseScore ${b0} → ${after.browseScore}, 已得学分 ${after.credit}`);
        if (after.browseScore >= 100) {
          log('  ✔ 该课程已学完,学分已到账');
        } else if (res.ok) {
          log('  ⚠ 视频已播完但进度未满 100%,下次运行会继续补播');
          state.courses[course.id].failed = false;
          state.courses[course.id].incomplete = true;
          saveState(state);
        }
      } else {
        log('  ⚠ 该课程暂未出现在个人学习统计中');
      }

      const creditBefore = credit.value;
      credit = await getCredit(page);
      log(`  当前学时/学分: ${credit.value} (来源 ${credit.source})`);
      if (cfg.only) { log('  --only 模式:处理完毕,结束。'); break; }

      // 兜底:连续 2 门课学时都没涨,多半是撞上每日上限(已选课不会返回那条提示,
      // 只能靠这个判断),继续跑只会空转。
      const gained = (credit.value !== null && creditBefore !== null) ? credit.value - creditBefore : 0;
      noGainStreak = gained > 0.001 ? 0 : noGainStreak + 1;
      if (dailyLimitHit || noGainStreak >= 2) {
        if (!dailyLimitHit) {
          log('');
          log('  ╔══════════════════════════════════════════════════════╗');
          log('  ║  🛑 连续 2 门课都没有新增学时,疑似已达每日上限        ║');
          log('  ║  停止本次运行,请明天再试。                           ║');
          log('  ╚══════════════════════════════════════════════════════╝');
          log('');
        }
        break;
      }
    }

    log('\n══════════════════════════════════════════════════════');
    log(` 结束。本次处理 ${round} 门,学时/学分 ${credit.value}`);
    log('══════════════════════════════════════════════════════');

  } catch (e) {
    log('✖ 运行出错: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  } finally {
    if (cfg.keepOpen) {
      log('浏览器窗口保持打开(--keep-open)。按 Ctrl+C 结束进程。');
    } else if (browser) {
      try { await browser.close(); log(`浏览器已关闭(登录会话保存在 ${path.basename(PROFILE_DIR)},下次无需重新登录)`); }
      catch { /* 忽略 */ }
    }
    if (logStream) logStream.end();
  }
}

main();
