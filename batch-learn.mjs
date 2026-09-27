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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveProfilePaths } from './runtime-utils.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_FILE = path.join(ROOT, 'accounts.local.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const LOG_DIR = path.join(ROOT, 'logs');

function maskPhone(s) {
  return String(s || '').replace(/^(1[3-9]\d)\d{4}(\d{4})$/, '$1＊＊＊＊$2');
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

export function findLatestLog(profileName) {
  if (!fs.existsSync(LOG_DIR)) return null;
  const files = fs.readdirSync(LOG_DIR);
  const prefix = `run-${profileName}-`;
  const matched = files
    .filter(f => f.startsWith(prefix) && f.endsWith('.log'))
    .sort()
    .reverse();
  return matched.length ? path.join(LOG_DIR, matched[0]) : null;
}

export function generateDashboard(accounts) {
  const rows = [];
  for (const acc of accounts) {
    const profile = acc.profile || acc.user;
    const paths = resolveProfilePaths(ROOT, profile, acc.user);
    const logFile = findLatestLog(paths.name);
    const parsed = parseAccountLog(logFile);
    const userMasked = maskPhone(acc.user || profile);
    const init = parsed.initialCredit !== null ? parsed.initialCredit.toFixed(2) : '--';
    const cur = parsed.currentCredit !== null ? parsed.currentCredit.toFixed(2) : '--';
    const gain = (parsed.initialCredit !== null && parsed.currentCredit !== null)
      ? `+${(parsed.currentCredit - parsed.initialCredit).toFixed(2)}`
      : '+0.00';

    rows.push({
      user: userMasked,
      initial: init,
      current: cur,
      gain,
      finished: parsed.finishedCount,
      status: parsed.status,
      course: parsed.currentCourse,
    });
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
    lines.push(` [${i + 1}] ${r.user.padEnd(11)}  学分: ${r.current} (初始 ${r.initial}, 增量 ${r.gain}) | 完成: ${r.finished}门 | 状态: ${r.status}${courseInfo}`);
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

async function runBatch() {
  const args = process.argv.slice(2);
  const isStatusOnly = args.includes('--status');
  const accounts = loadAccounts();

  if (!accounts.length) {
    console.error('❌ 未找到可用账号。请在 accounts.local.json 或 config.json 中配置账号。');
    process.exit(1);
  }

  if (isStatusOnly) {
    const rows = generateDashboard(accounts);
    console.log(formatDashboard(rows));
    return;
  }

  console.log(`\n🚀 准备并行启动 ${accounts.length} 个账号学习任务…`);
  const startTime = Date.now();
  const children = [];

  for (const acc of accounts) {
    const profile = acc.profile || acc.user;
    const childArgs = [
      'auto-learn.mjs',
      `--profile=${profile}`,
      `--user=${acc.user}`,
      `--pass=${acc.pass}`,
      '--newest-single',
      '--daily'
    ];
    const proc = spawn(process.execPath, childArgs, {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    children.push({ proc, acc, profile });
    console.log(`  → 已启动账号 ${maskPhone(acc.user)} (PID ${proc.pid})`);
  }

  console.log('\n所有账号后台并发进程已就绪，按 Ctrl+C 可一键结束所有子任务。');
  console.log('正在实时监测各账号状态…\n');

  const checkInterval = 6000;
  const timer = setInterval(() => {
    const rows = generateDashboard(accounts);
    console.clear();
    console.log(formatDashboard(rows));
    console.log(`\n更新时间: ${new Date().toLocaleTimeString()} (每 6 秒刷新一次, 按 Ctrl+C 退出监测)`);

    // 检查所有子进程是否均已结束
    const allExited = children.every(c => c.proc.exitCode !== null);
    if (allExited) {
      clearInterval(timer);
      onComplete(children, startTime);
    }
  }, checkInterval);

  process.on('SIGINT', () => {
    console.log('\n\n🛑 正在停止所有账号子进程…');
    for (const c of children) {
      try { process.kill(c.proc.pid); } catch {}
    }
    clearInterval(timer);
    onComplete(children, startTime);
    process.exit(0);
  });
}

function onComplete(children, startTime) {
  const durationSec = Math.round((Date.now() - startTime) / 1000);
  const accounts = children.map(c => c.acc);
  const rows = generateDashboard(accounts);
  const report = formatSummaryReport(rows, durationSec);

  console.log('\n\n══════════════════════════════════════════════════════════════════════════════');
  console.log(' 🎉 所有账号任务均已执行完毕！最终学习汇总报告:');
  console.log('══════════════════════════════════════════════════════════════════════════════\n');
  console.log(report);

  // 写入总结报告到 logs/
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const todayStr = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(LOG_DIR, `summary-${todayStr}.md`);
  try {
    fs.writeFileSync(reportPath, report, 'utf8');
    console.log(`\n📄 总结报告已自动保存至: ${reportPath}`);
  } catch {}
}

if (process.argv[1] && (path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) || process.argv[1].endsWith('batch-learn.mjs'))) {
  runBatch();
}
