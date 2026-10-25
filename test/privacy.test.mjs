import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { temporaryDirectory } from './fixtures.mjs';

const scanner = fileURLToPath(new URL('../privacy-check.mjs', import.meta.url));
const scan = directory => spawnSync(process.execPath, [scanner, directory], { encoding: 'utf8', windowsHide: true, timeout: 20000 });

test('user-profile paths in either separator style are detected without printing their values', t => {
  const directory=temporaryDirectory(t);
  const windows=['C:', 'Users', 'private-fixture-user', 'Documents', 'file.txt'].join('/');
  fs.writeFileSync(path.join(directory,'note.txt'),windows);
  const result=scan(directory);
  assert.equal(result.status,1);
  assert(!result.stdout.includes('private-fixture-user'));
});

test('Windows scan paths remain literal data rather than PowerShell commands', { skip: process.platform !== 'win32' }, t => {
  const directory = temporaryDirectory(t);
  const marker = 'PRIVACY_PATH_COMMAND_EXECUTED';
  const target = path.join(directory, `folder'; Write-Output '${marker}'; #`);
  fs.mkdirSync(target);
  const file = path.join(target, 'fixture.txt');
  fs.writeFileSync(file, 'synthetic harmless file');
  fs.writeFileSync(`${file}:safe-review-stream`, 'synthetic harmless metadata');
  const result = scan(target);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /备用数据流:[^\n]*safe-review-stream/);
  assert.doesNotMatch(result.stdout, new RegExp(`备用数据流:[^\\n]*${marker}`));
});

test('account templates reject non-empty passwords without revealing them', t => {
  const directory = temporaryDirectory(t);
  const password = ['synthetic', 'template', 'secret'].join('-');
  fs.writeFileSync(path.join(directory, 'accounts.example.json'), JSON.stringify([{ user: '', pass: password }]));
  const result = scan(directory);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /非空账号\/密码字段/);
  assert(!result.stdout.includes(password));
});

test('masked account examples with blank passwords remain shareable', t => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'accounts.example.json');
  fs.writeFileSync(target, JSON.stringify([{ profile: '账号1', user: '138xxxxxxxx', pass: '' }]));
  const clean = scan(directory);
  assert.equal(clean.status, 0, clean.stdout);
  fs.writeFileSync(target, JSON.stringify([{ profile: '账号1', user: '138xxxxxxxx', pass: 'synthetic-template-secret' }]));
  const unsafe = scan(directory);
  assert.equal(unsafe.status, 1, unsafe.stdout);
  assert(!unsafe.stdout.includes('synthetic-template-secret'));
});

test('credentials under test directories are not silently excluded', t => {
  const directory = temporaryDirectory(t);
  const password = ['synthetic', 'nested', 'secret'].join('-');
  const nested = path.join(directory, 'test');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'config.json'), JSON.stringify({ password }));
  const result = scan(directory);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /非空账号\/密码字段/);
  assert(!result.stdout.includes(password));
});

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
