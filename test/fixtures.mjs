import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function temporaryDirectory(t) {
  const base = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(base, 'wlxy-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('wlxy-test-')) {
      throw new Error('Unexpected test cleanup path');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}
