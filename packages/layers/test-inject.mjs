/**
 * 失败 / 超时路径的清理实测开关（S55 · B-SUB1-R28-028）
 *
 * ## 为什么不直接在用例里写死一个失败
 *
 * 失败注入要能反复开关、且**默认零影响**：只有显式设了环境变量才会多出一个用例。
 * 平时 `node scripts/test-runner.mjs --filter=packages/layers` 不会看到它。
 *
 * ## 两个开关
 *
 * - `OPENCUT_TEST_INJECT_FAIL=1`：追加一个必失败用例。用来验证「用例红了，但
 *   `after()` 仍然跑、槽仍然还、Chromium 仍然关」。
 * - `OPENCUT_TEST_INJECT_HANG=1`：追加一个永不 resolve 的用例。runner 的
 *   `--timeout-ms` 到点会 SIGTERM 整个文件进程 —— 这时 `after()` **不会**跑
 *   （node:test 的 after 只在测试正常收尾时执行）。若同时给了
 *   `OPENCUT_INJECT_SENTINEL=<path>`，本模块会注册一个 after 写哨兵文件：
 *   文件不存在 = 证明确实没跑；随后下一次取槽要能把残留回收掉。
 *
 * 哨兵只放在 hang 分支：失败分支的 `after()` 本来就会跑，写哨兵会混淆证据。
 */
import fs from 'node:fs/promises';
import { after, test } from 'node:test';

/**
 * @param {string} suite 测试文件名（写进用例标题，便于看报告）
 */
export function registerCleanupProbe(suite) {
  if (process.env.OPENCUT_TEST_INJECT_FAIL === '1') {
    test(`INJECT-FAIL ${suite}：故意失败（验证失败路径的槽与进程回收）`, () => {
      throw new Error(`OPENCUT_TEST_INJECT_FAIL=1（${suite}）：这是故意的失败，不是产品缺陷`);
    });
  }

  if (process.env.OPENCUT_TEST_INJECT_HANG === '1') {
    const sentinel = process.env.OPENCUT_INJECT_SENTINEL ?? '';
    test(`INJECT-HANG ${suite}：挂住到进程被杀（验证 after 没跑的情况）`, () => new Promise(() => {}));
    if (sentinel !== '') {
      after(async () => {
        await fs.writeFile(sentinel, `after ran: ${suite}\n`);
      });
    }
  }
}
