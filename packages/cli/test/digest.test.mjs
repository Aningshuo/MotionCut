// @ts-nocheck —— 测试以运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 结果里的 `sha256` 必须是**文件字节**的摘要。
 *
 * R24 发现的老坑：`digestOf()` 是给 opId ledger 的 JSON 值用的（内部 `JSON.stringify`），
 * 早先 VTT / fcpxml 的 `sha256` 直接把 `Buffer` 传给它，算出来是
 * `sha256('{"type":"Buffer","data":[…]}')` —— 与文件对不上，用户拿去校验必然失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { bytesDigest } from '../ops.mjs';
import { digestOf } from '../opid.mjs';

test('bytesDigest = 文件字节的 sha256（不是 JSON 化 Buffer 的）', () => {
  const body = Buffer.from('WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n你好\n', 'utf8');
  const want = crypto.createHash('sha256').update(body).digest('hex');
  assert.equal(bytesDigest(body), want);
  assert.notEqual(bytesDigest(body), digestOf(body), 'digestOf(Buffer) 是 JSON 文本的摘要，别用它算文件');
});

test('bytesDigest 对同内容不同 Buffer 实例稳定', () => {
  assert.equal(bytesDigest(Buffer.from('abc')), bytesDigest(Buffer.from('abc')));
});
