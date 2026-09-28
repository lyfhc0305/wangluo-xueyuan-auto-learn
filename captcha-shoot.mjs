// 截取登录框验证码图 + (第二步)回填并点击登录
// 用法: node captcha-shoot.mjs shoot <profileDir> <outfile>
//       node captcha-shoot.mjs fill <profileDir> <code>
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [cmd, profileDir, arg] = process.argv.slice(2);
const portFile = path.join(profileDir, 'DevToolsActivePort');
const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0].trim());
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });

const pages = await browser.pages();
const page = pages.find(p => (p.url() || '').includes('hngbwlxy')) || pages[0];

if (cmd === 'shoot') {
  const img = await page.$('#loginModal img.codeImg');
  if (!img) { console.log('NO_IMG'); process.exit(2); }
  await img.screenshot({ path: arg });
  console.log('SHOT_OK ' + arg);
} else if (cmd === 'fill') {
  const handle = await page.$('#loginModal input[ng-model="login.ValidateCode"]');
  if (!handle) { console.log('NO_INPUT'); process.exit(2); }
  await handle.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.angular) {
      const scope = window.angular.element(el).scope();
      if (scope && scope.login) { scope.login.ValidateCode = v; scope.$apply(); }
    }
  }, arg);
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#loginModal .btn')];
    const b = btns.find(x => (x.textContent || '').trim() === '登录');
    if (b) { b.click(); return true; }
    return false;
  });
  console.log(clicked ? 'CLICKED' : 'NO_BTN');
} else {
  console.log('UNKNOWN_CMD');
  process.exit(2);
}
browser.disconnect();
