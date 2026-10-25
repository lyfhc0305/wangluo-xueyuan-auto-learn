import fs from 'node:fs';
import path from 'node:path';
import { resolveProfilePaths } from './runtime-utils.mjs';

export const localDay = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * 站点每日学时额度按「配额周期」结算，不是自然日 00:00 归零。
 *
 * 实测（2026-09~10 全量日志标定）：同账号达限后，同一自然日 05:00~07:30 又能成功选课，
 * 例如 09-21 00:12 达限 → 06:01 恢复、09-27 00:09 → 07:30、09-29 01:02 → 05:00。
 * 由「达限 → 该账号之后首次成功选课」必须跨越一次配额日翻转这一硬约束求交，
 * 翻转时刻落在本地 02:15 ~ 05:00 之间（134 组样本中 R=0 有 14 组冲突，R≥2.25 零冲突）。
 *
 * 取区间下界 2.25 作为配额日边界：翻转点无法进一步精确时，宁可把「可能已重置」
 * 判成「已重置」——多试一次（一次选课请求即可证伪），
 * 也不要把已重置的额度误判为仍受限，那样会静默丢掉一整天的学习。
 */
export const QUOTA_RESET_HOUR = 2.25;

/** 配额日标签：等价于「当前配额周期所属的自然日」。 */
export const quotaDay = (ms, resetHour = QUOTA_RESET_HOUR) => localDay(ms - resetHour * 3600_000);

/**
 * 站点对「选课」接口的答复，是额度是否仍受限的直接证据：
 * - 成功添加记录 => 平台放行，额度可用
 * - 已累计学习5学时 => 平台拒绝，额度已用尽
 *
 * 顺序即事实：某账号最后一次额度答复是「拒绝」才说明额度仍受限；
 * 其后若出现「成功」，说明配额已翻转（站点自己证实），不应再按已受限处理。
 * 不去推测重置时刻，直接读平台自己的答复。
 */
export function quotaResponseInLine(line) {
  if (/选课返回:\s*Type=1 Message=成功添加了1条记录/.test(line)) return 'accepted';
  if (/LEARNING_STOP_REASON=daily-limit\b/.test(line)) return 'refused';
  if (!/疑似|多半|可能/.test(line) && /已达站点【每日学时上限】|今天已累计学习\s*5(?:\.0+)?\s*学时/.test(line)) return 'refused';
  return null;
}

export function stopReasonInLine(line) {
  const marker = /LEARNING_STOP_REASON=(manual-required|no-gain|daily-limit|completed|retryable-failure)\b/.exec(line);
  if (marker) return marker[1];
  if (/拒绝拖拽验证|页面不接受拖拽|连续两次拖拽完全无反应/.test(line)) return 'manual-required';
  if (/连续\s*2\s*门.*(?:没有新增|无增量)/.test(line)) return 'no-gain';
  if (!/疑似|多半|可能/.test(line) && /已达站点【每日学时上限】|今天已累计学习\s*5(?:\.0+)?\s*学时/.test(line)) return 'daily-limit';
  if (/已达到目标|没有需要继续学习的视频课程|结束。本次处理\s*\d+\s*门/.test(line)) return 'completed';
  return null;
}

export function logIdentity(file) {
  const match = /^run-(.+)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-[\w-]+)?\.log$/.exec(file);
  return match ? { identity: match[1], start: Date.parse(`${match[2]}T${match[3]}:${match[4]}:${match[5]}Z`) } : null;
}

/** Only a complete authorized inventory can disambiguate legacy masked names. */
export function accountLogFiles(root, account, identityAccounts = []) {
  const directory = path.join(root, 'logs');
  if (!fs.existsSync(directory)) return [];
  const paths = resolveProfilePaths(root, account.profile || account.user, account.user);
  const legacy = paths.name.replace(/[\\/:*?"<>|]/g, '_');
  const owners = new Set(identityAccounts.map(a => resolveProfilePaths(root, a.profile || a.user, a.user)).filter(p => p.name.replace(/[\\/:*?"<>|]/g, '_') === legacy).map(p => p.key));
  return fs.readdirSync(directory).filter(file => {
    const id = logIdentity(file)?.identity;
    return id === paths.key || (id === legacy && owners.size === 1 && owners.has(paths.key));
  }).sort((a, b) => logIdentity(a).start - logIdentity(b).start || a.localeCompare(b));
}
