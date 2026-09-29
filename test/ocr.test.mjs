import test from 'node:test';
import assert from 'node:assert/strict';
import { solveLoginCaptchaWithOcr } from '../auto-learn.mjs';

test('solveLoginCaptchaWithOcr handles empty/invalid buffer safely without throwing', async () => {
  // 确保在没有 python 或无效输入时安全降级返回 null, 不会抛出 ReferenceError 或其他未捕获异常
  const res = await solveLoginCaptchaWithOcr(Buffer.from(''));
  assert.equal(res, null);
});

test('solveLoginCaptchaWithOcr returns null on corrupt image data', async () => {
  const dummyBuffer = Buffer.from('NOT_AN_IMAGE_DATA');
  const res = await solveLoginCaptchaWithOcr(dummyBuffer);
  assert.equal(res, null);
});
