import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { temporaryDirectory } from './fixtures.mjs';

const scanner = fileURLToPath(new URL('../privacy-check.mjs', import.meta.url));
const scan = directory => spawnSync(process.execPath, [scanner, directory], { encoding: 'utf8', windowsHide: true, timeout: 20000 });

test('non-empty credentials are rejected without printing their values', t => {
  const directory = temporaryDirectory(t);
  const username = ['fixture', 'private', 'account'].join('-');
  const password = ['fixture', 'private', 'secret'].join('-');
  for (const [name, value] of [
    ['config.json', { username, password }],
    ['config.example.json', { username: '', password }],
    ['accounts.local.json', [{ user: username, pass: password }]],
  ]) {
    fs.writeFileSync(path.join(directory, name), '\uFEFF' + JSON.stringify(value));
    const result = scan(directory);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /非空账号\/密码字段/);
    assert(!result.stdout.includes(username));
    assert(!result.stdout.includes(password));
    fs.unlinkSync(path.join(directory, name));
  }
});

test('empty configuration succeeds and malformed credentials fail closed', t => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'config.json');
  fs.writeFileSync(target, JSON.stringify({ username: '', password: '', targetCredit: 5 }));
  assert.equal(scan(directory).status, 0);
  fs.writeFileSync(target, '{"password":');
  const result = scan(directory);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /凭据配置无法解析/);
});

test('default and nested named browser profiles are rejected even with binary cookies', t => {
  const directory = temporaryDirectory(t);
  for (const name of ['.chrome-profile', 'nested/.chrome-profile-alias']) {
    const profile = path.join(directory, name);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'Cookies'), Buffer.from([0, 1, 2]));
  }
  const result = scan(directory);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /浏览器会话目录/);
  assert(!result.stdout.includes('可以放心分享'));
});
