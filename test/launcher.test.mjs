import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { temporaryDirectory } from './fixtures.mjs';

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
