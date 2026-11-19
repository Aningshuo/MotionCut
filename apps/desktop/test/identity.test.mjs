// @ts-nocheck
/**
 * B08（R109）：打包身份与旧 userData 只读检测。
 *
 * 这里只测**纯函数与常量**（不 import electron、不起 app）：
 *  - 产品身份不得再叫旧名字；
 *  - 旧目录检测只调用一次 `exists`，路径是 `<appData>/OpenFilm`；
 *  - 当前 userData 恰好就是旧目录时不算命中（避免自己提示自己）。
 *
 * 真打包的 plist / 窗口标题 / 起停由 `scripts/_probe-r109-b08.mjs` 验。
 *
 * 跑法：node --test apps/desktop/test/identity.test.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  APP_ID,
  APP_NAME,
  APP_PACKAGE_NAME,
  APP_USER_DATA_DIRECTORY,
  LEGACY_APP_NAME,
  detectLegacyUserData,
  legacyUserDataPath,
} from '../src/identity.mjs';

test('产品身份与旧身份分家', () => {
  assert.equal(APP_NAME, 'MotionCut');
  assert.equal(APP_USER_DATA_DIRECTORY, 'Opencut Studio');
  assert.equal(APP_ID, 'com.opencut.studio');
  assert.equal(APP_PACKAGE_NAME, 'opencut-studio');
  assert.equal(LEGACY_APP_NAME, 'OpenFilm');
  assert.ok(!APP_NAME.includes(LEGACY_APP_NAME), '产品名不得包含旧身份');
  assert.ok(!APP_ID.includes(LEGACY_APP_NAME.toLowerCase()), 'bundle id 不得包含旧身份');
});

test('旧目录路径 = <appData>/<旧身份>（不 stat、不 mkdir）', () => {
  assert.equal(legacyUserDataPath('/tmp/appdata'), path.join('/tmp/appdata', 'OpenFilm'));
});

test('旧目录存在 → 命中，且 exists 只被调用一次', () => {
  const calls = [];
  const result = detectLegacyUserData({
    appData: '/tmp/appdata',
    userData: '/tmp/userdata',
    exists: (file) => {
      calls.push(file);
      return true;
    },
  });
  assert.deepEqual(result, {
    detected: true,
    path: path.join('/tmp/appdata', 'OpenFilm'),
    sameAsCurrent: false,
  });
  assert.deepEqual(calls, [path.join('/tmp/appdata', 'OpenFilm')]);
});

test('旧目录不存在 → 不命中，不抛', () => {
  const result = detectLegacyUserData({
    appData: '/tmp/appdata',
    userData: '/tmp/userdata',
    exists: () => false,
  });
  assert.equal(result.detected, false);
  assert.equal(result.sameAsCurrent, false);
});

test('当前 userData 就是旧目录 → 不算命中（不提示自己）', () => {
  const legacy = path.join('/tmp/appdata', 'OpenFilm');
  let called = 0;
  const result = detectLegacyUserData({
    appData: '/tmp/appdata',
    userData: legacy,
    exists: () => {
      called += 1;
      return true;
    },
  });
  assert.equal(result.detected, false);
  assert.equal(result.sameAsCurrent, true);
  assert.equal(called, 0, '同一个目录不应再去 exists（省一次 IO，也避免语义混淆）');
});
