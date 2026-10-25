import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { temporaryDirectory } from './fixtures.mjs';

test('Monitor forwards explicit scope and daily policy and preserves failure exit', { skip: process.platform !== 'win32' }, t => {
  const directory = temporaryDirectory(t);
  const launcher = path.join(directory, 'launcher.ps1');
  fs.copyFileSync(new URL('../并行学习.ps1', import.meta.url), launcher);
  const command = `function node { $args | ConvertTo-Json -Compress; $global:LASTEXITCODE = 7 }; & '${launcher.replaceAll("'", "''")}' -Monitor -Accounts 'single' -Daily:$false -MaxAccounts 1; exit $LASTEXITCODE`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert(result.stdout.trim(), result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['batch-learn.mjs', '--daily=false', '--max-accounts=1', '--accounts=single']);
  assert.equal(result.status, 7);
});

test('detached launcher supports portable runtime overrides without a machine-specific executable path', () => {
  const script=fs.readFileSync(new URL('../run-batch-detached.cmd',import.meta.url),'utf8');
  assert.doesNotMatch(script,/[A-Za-z]:[\\/]/);
  assert.match(script,/NODE_EXE/);
  assert.match(script,/runtime\.local\.cmd/);
});

test('detached cmd creates logs before redirecting stub batch output', { skip: process.platform !== 'win32' }, t => {
  const directory = temporaryDirectory(t);
  const script = path.join(directory, 'launch.cmd');
  const original = fs.readFileSync(new URL('../run-batch-detached.cmd', import.meta.url), 'utf8');
  // Redirect only the working directory to an isolated fixture. The learner is a harmless stub.
  fs.writeFileSync(script, original.replace(/cd \/d "[^"\r\n]+"/, `cd /d "${directory}"`));
  fs.writeFileSync(path.join(directory, 'batch-learn.mjs'), "process.stdout.write('fixture-only');");
  const result = spawnSync('cmd.exe', ['/d', '/c', script], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(directory, 'logs/batch-task.log'), 'utf8'), 'fixture-only');
});

test('PowerShell Start-Process preserves spaces, quotes, backslashes and Unicode', { skip: process.platform !== 'win32' }, t => {
  const directory = temporaryDirectory(t);
  const script = path.join(directory, 'capture args.cjs');
  const input = path.join(directory, 'input.json');
  const output = path.join(directory, 'output args.json');
  const helper = fileURLToPath(new URL('../native-args.ps1', import.meta.url));
  const expected = [
    '--profile=账号 one', '--pass=two words', '--pass=quote"in the middle',
    '--pass=ends with slash\\', '--pass=slash\\"quote', '--pass=two\\\\"slashes',
    '--pass=$() & ; % !', '--pass=line\nbreak', '',
  ];
  fs.writeFileSync(script, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));');
  fs.writeFileSync(input, JSON.stringify([script, output, ...expected]));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const command = `
$ErrorActionPreference = 'Stop'
${fs.readFileSync(helper, 'utf8')}
$arguments = Get-Content -LiteralPath ${quote(input)} -Raw -Encoding UTF8 | ConvertFrom-Json
$line = ($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
$child = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList $line -WindowStyle Hidden -PassThru -Wait
exit $child.ExitCode
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), expected);
});
