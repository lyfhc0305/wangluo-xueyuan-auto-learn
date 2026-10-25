import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporaryDirectory } from './fixtures.mjs';
import * as watchdog from '../learning-watchdog.mjs';

test('playback events enter the existing durable alert queue with bounded sanitized content', t => {
  assert.equal(typeof watchdog.recordPlaybackEvent,'function');
  const root=temporaryDirectory(t), account={profile:'playback-fixture',user:'fixture'};
  for(const kind of ['reload','restart','recovered']) {
    watchdog.recordPlaybackEvent(root,account,{kind,courseId:42,ratio:0.3,now:1000});
    watchdog.recordPlaybackEvent(root,account,{kind,courseId:42,ratio:0.3,now:1000});
  }
  const directory=path.join(root,'logs/learning-alerts');
  const messages=fs.readdirSync(directory).map(f=>JSON.parse(fs.readFileSync(path.join(directory,f))).message);
  assert.equal(messages.length,3);
  assert(messages.some(m=>m.includes('持续低速')));
  assert(messages.some(m=>m.includes('限次补启')));
  assert(messages.some(m=>m.includes('两个60秒窗口')));
  assert.throws(()=>watchdog.recordPlaybackEvent(root,account,{kind:'unknown',now:1000}));
});
