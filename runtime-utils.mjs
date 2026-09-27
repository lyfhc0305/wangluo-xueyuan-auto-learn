import path from 'node:path';
import { createHash } from 'node:crypto';

const maskPhone = value => value.replace(/^(1[3-9]\d)\d{4}(\d{4})$/, '$1＊＊＊＊$2');

/** 显示名称可以脱敏,磁盘标识必须由完整 profile 计算。 */
export function resolveProfilePaths(root, profile = '', username = '') {
  let identity = String(profile || '').trim();
  if (/^1[3-9]\d[＊*]{4}\d{4}$/.test(identity)) {
    // 旧版并行启动器会提前把 profile 打码;利用同条记录的 user 恢复唯一性。
    const user = String(username || '').trim();
    if (!/^1[3-9]\d{9}$/.test(user) || maskPhone(user) !== identity.replace(/\*/g, '＊')) {
      throw new Error('脱敏手机号不能唯一标识会话。请使用完整手机号或独立别名作为 --profile。');
    }
    identity = user;
  }
  const name = maskPhone(identity);
  const label = name.replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').slice(0, 40);
  const key = identity ? `${label}-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}` : '';
  return {
    name, key,
    directory: path.join(root, `.chrome-profile${key ? '-' + key : ''}`),
    stateFile: path.join(root, `state${key ? '-' + key : ''}.json`),
  };
}

/** 旧版仅有 failed=true 的记录没有区分网络失败,允许重新尝试。 */
export const isPermanentFailure = record => record?.failed === true && record.retryable === false;

export function nextNoGainStreak(streak, result, before, after) {
  if (!result.ok || !Number.isFinite(before) || !Number.isFinite(after)) return 0;
  return after - before > 0.001 ? 0 : streak + 1;
}

/** profile 占用并不代表进程残留。保留现有进程,由用户关闭对应会话后重试。 */
export async function launchProfileBrowser(launcher, options) {
  try {
    return await launcher.launch(options);
  } catch (cause) {
    if (!/already running for|ProcessSingleton|profile.*in use/i.test(String(cause.message))) throw cause;
    const error = new Error(`会话目录 ${path.basename(options.userDataDir)} 正被占用。请关闭使用该会话的学习程序及浏览器后重试。`, { cause });
    error.code = 'PROFILE_IN_USE';
    throw error;
  }
}
