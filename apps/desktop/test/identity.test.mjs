import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APP_ID,
  APP_NAME,
  APP_PACKAGE_NAME,
  APP_USER_DATA_DIRECTORY,
} from '../src/identity.mjs';

test('产品名称、安装标识和用户数据目录保持稳定', () => {
  assert.equal(APP_NAME, 'MotionCut');
  assert.equal(APP_USER_DATA_DIRECTORY, 'Opencut Studio');
  assert.equal(APP_ID, 'com.opencut.studio');
  assert.equal(APP_PACKAGE_NAME, 'opencut-studio');
});
