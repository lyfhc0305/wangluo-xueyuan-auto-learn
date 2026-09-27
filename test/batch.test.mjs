import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporaryDirectory } from './fixtures.mjs';
import { parseAccountLog, formatDashboard, formatSummaryReport } from '../batch-learn.mjs';

test('parseAccountLog correctly parses credit, progress, and daily limit status', t => {
  const dir = temporaryDirectory(t);
  const logFile = path.join(dir, 'run-test.log');

  const content = `
[08:00:00]   当前学时/学分: 50.0 (来源 MyStudyStat.CreditSum)
[08:00:01] ──────── 第 1 门 ────────
[08:00:01] 《高素质干部队伍建设》 id=1234 学分=1 进度=-1
[08:05:00]     …播放中 10:00 / 20:00 (50.0%)
[08:10:00]   ✔ 播放完毕(20:00 / 20:00)
[08:10:05]   ✔ 进度已入账: BrowseScore 100
[08:10:06]   ✔ 该课程已学完,学分已到账
[08:10:07]   当前学时/学分: 51.0 (来源 MyStudyStat.CreditSum)
[08:10:10] ──────── 第 2 门 ────────
[08:10:10] 《新时代党的建设》 id=5678 学分=1 进度=-1
[08:10:12]   🛑 已达站点【每日学时上限】
[08:10:15]  结束。本次处理 2 门,学时/学分 51.0
[08:10:16] 浏览器已关闭
`;

  fs.writeFileSync(logFile, content, 'utf8');
  const res = parseAccountLog(logFile);

  assert.equal(res.initialCredit, 50.0);
  assert.equal(res.currentCredit, 51.0);
  assert.equal(res.status, '已达今日上限');
  assert.equal(res.finishedCount, 1);
});

test('formatDashboard and formatSummaryReport produce clean formatted output', () => {
  const rows = [
    {
      user: '138＊＊＊＊1234',
      initial: '50.00',
      current: '55.00',
      gain: '+5.00',
      finished: 5,
      status: '已达今日上限',
      course: '',
    },
  ];

  const dashboard = formatDashboard(rows);
  assert.ok(dashboard.includes('138＊＊＊＊1234'));
  assert.ok(dashboard.includes('学分: 55.00'));
  assert.ok(dashboard.includes('完成: 5门'));

  const report = formatSummaryReport(rows, 3600);
  assert.ok(report.includes('# 干部网络学院学习总结报告'));
  assert.ok(report.includes('| **138＊＊＊＊1234** | 50.00 | **55.00** | **+5.00** | 5 门 | 已达今日上限 |'));
});
