#!/usr/bin/env node
/**
 * 分享前隐私自查工具
 *
 * 用法:
 *   node privacy-check.mjs                 检查当前文件夹
 *   node privacy-check.mjs "D:\某文件夹"    检查指定文件夹
 *   node privacy-check.mjs 换电脑拷贝包.zip  直接检查 zip
 *
 * 它会检查:绝对路径里的用户名、手机号、身份证号、邮箱、UUID、
 *          站点密钥、Cookie/令牌、隐藏文件、NTFS 备用数据流。
 * 注意看不到 .chrome-profile 内部的 Cookie(那是二进制库),
 * 所以脚本会单独提醒这个目录的存在。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const target = process.argv[2] || '.';
const abs = path.resolve(target);

const HIGH = [], MED = [], INFO = [];

const DETECTORS = [
  { name: 'Windows 路径中的用户名', re: /[A-Za-z]:\\Users\\[^\\\s"'`)]+/g, level: 'HIGH' },
  { name: 'macOS/Linux 用户目录', re: /\/(?:Users|home)\/[^\s"'`)/]+/g, level: 'HIGH' },
  { name: '邮箱地址', re: /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/g, level: 'HIGH' },
  { name: '中国大陆手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, level: 'HIGH' },
  { name: '18 位身份证号', re: /(?<!\d)\d{17}[\dXx](?!\d)/g, level: 'HIGH' },
  { name: 'UUID', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, level: 'MED' },
  { name: '站点签名密钥', re: /jy365|0392039203920300/g, level: 'HIGH' },
  { name: '站点 RSA 公钥', re: /MIGfMA0GCSq/g, level: 'HIGH' },
  { name: 'WAF / 会话 Cookie', re: /acw_tc|\.AspNetCore|ASPXAUTH/g, level: 'HIGH' },
  { name: '验证令牌的值(非字段名)', re: /__RequestVerificationToken["'\s:=]+[A-Za-z0-9_-]{20,}/g, level: 'HIGH' },
];

const TEXT_EXT = /\.(mjs|cjs|js|json|md|txt|bat|cmd|sh|ps1|yml|yaml|html|css)$/i;
// 跳过这些目录:
//   node_modules / .git / _recon  —— 第三方或侦察产物
//   .chrome-profile*              —— 浏览器会话目录,里面是 Chrome 自带的二进制
//                                    和资源文件(WasmTtsEngine 的语音包、ZxcvbnData
//                                    的弱密码字典等),它们自带示例手机号/身份证号,
//                                    扫了会误报。这个目录单独作为"提醒"列出。
const SKIP_DIRS = /(^|[\\/])(node_modules|\.git|_recon|\.chrome-profile[^\\/]*)([\\/]|$)/;

function walk(dir, files = [], dirs = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (!SKIP_DIRS.test(p)) { dirs.push(p); walk(p, files, dirs); }
    }
    else files.push(p);
  }
  return { files, dirs };
}

console.log('════════════════════════════════════════════');
console.log(' 隐私自查:', abs);
console.log('════════════════════════════════════════════\n');

// ── zip 或目录 ──
if (abs.toLowerCase().endsWith('.zip')) {
  const zs = fs.readFileSync(abs).toString('latin1');
  for (const p of ['Users', 'Desktop', 'AppData']) {
    if (zs.includes(p)) HIGH.push([path.basename(abs), `压缩包头含 "${p}"`]);
  }
  const absEntries = [...zs.matchAll(/[A-Za-z]:[\\/][\x20-\x7e]{0,100}/g)].map(m => m[0]);
  if (absEntries.length) MED.push([path.basename(abs), '包内条目为绝对路径: ' + absEntries.join(', ')]);
  console.log(`检查压缩包: ${(fs.statSync(abs).size / 1024).toFixed(1)} KB`);
  console.log('  包头路径痕迹: ' + (HIGH.length || absEntries.length ? '有(见下方)' : '无'));
  console.log('  ※ 内容需解压后再查,建议直接对解压后的文件夹运行本工具\n');
} else {
  const { files, dirs } = walk(abs);
  console.log(`扫描 ${files.length} 个文本文件…\n`);
  for (const f of files) {
    const rel = path.relative(abs, f);
    if (path.basename(f) === 'privacy-check.mjs') continue;   // 跳过本工具自身(内含探测器正则)
    const text = fs.readFileSync(f, 'utf8');
    for (const d of DETECTORS) {
      const hits = [...new Set([...text.matchAll(d.re)].map(m => m[0]))];
      if (hits.length) {
        (d.level === 'HIGH' ? HIGH : MED).push([rel, `${d.name}: ${hits.slice(0, 3).join(' | ')}`]);
      }
    }
  }

  // 文件名 / 目录名也可能泄漏隐私(如 state-13800000000.json、run-13800000000-*.log、
  // .chrome-profile-13800000000),内容扫描覆盖不到这一层,单独过一遍探测器。
  let nameHits = 0;
  for (const p of [...dirs, ...files]) {
    const rel = path.relative(abs, p);
    if (rel === 'privacy-check.mjs') continue;
    for (const d of DETECTORS) {
      const hits = [...new Set([...rel.matchAll(d.re)].map(m => m[0]))];
      if (hits.length) {
        (d.level === 'HIGH' ? HIGH : MED).push([rel, `名称含${d.name}(改名或删除): ${hits.slice(0, 3).join(' | ')}`]);
        nameHits++;
        break;   // 同一路径报最相关的一条即可
      }
    }
  }
  if (nameHits) console.log(`⚠ 有 ${nameHits} 个文件/目录的【名称】本身含敏感信息(详见下方)\n`);

  // 隐藏文件
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    if (/^(\.chrome-profile|logs|state\.json)$/.test(d.name)) {
      INFO.push([d.name, d.isDirectory() ? '运行时生成的目录(含登录态/日志),分享前请排除' : '运行时生成的进度文件,含你学过的课程名']);
    } else if (/^\.|Thumbs\.db|desktop\.ini|\.DS_Store/i.test(d.name)) {
      MED.push([d.name, '隐藏/系统文件']);
    }
  }

  // NTFS 备用数据流
  if (process.platform === 'win32') {
    try {
      const ads = execSync(`powershell -NoProfile -Command "Get-ChildItem -Path '${abs}' -Recurse -File | ForEach-Object { Get-Item $_.FullName -Stream * | Where-Object { $_.Stream -ne ':$DATA' } | Select-Object -ExpandProperty Stream }"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (ads) MED.push(['NTFS', '备用数据流: ' + ads]);
    } catch { /* 忽略 */ }
  }
}

// ── 汇总 ──
const show = (title, list, icon) => {
  console.log(`${icon} ${title}: ${list.length}`);
  list.forEach(([where, what]) => console.log(`    · ${where}\n      ${what.slice(0, 150)}`));
};
show('高危(务必处理)', HIGH, HIGH.length ? '⚠' : '✔');
show('中危(建议确认)', MED, MED.length ? '⚠' : '✔');
show('提醒(运行时生成物)', INFO, INFO.length ? 'ℹ' : '✔');

console.log('\n────────────────────────────────────────────');
if (HIGH.length) {
  console.log(' 结论:发现高危内容,请处理后再分享。');
  process.exitCode = 1;
} else if (MED.length) {
  console.log(' 结论:无高危内容;中危项请自行确认是否可接受。');
} else {
  console.log(' 结论:✔ 未发现个人数据,可以放心分享。');
}
console.log(' 注意:Cookie、令牌一般存在二进制文件里,本工具查不到明文,');
console.log('       所以请务必确认没有把 .chrome-profile 一起发出去。');
