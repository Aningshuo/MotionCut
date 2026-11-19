/**
 * MCP 测试用 render 端口 —— **STUB**，不是真实渲染。
 *
 * 只验证「MCP → ops.startExport → render 端口」这一层的参数透传与门禁；
 * 真实渲染/混音由 packages/render 的测试与导出服务测试覆盖。
 *
 * 通过环境变量记录调用（测试进程读这份日志）：
 *   OPENCUT_STUB_RENDER_LOG  追加一行 JSON：{ spec, audioMix }
 *   OPENCUT_STUB_RENDER_FAIL 设为 '1' 时返回 AUDIO_DECODE_FAILED
 */

import fs from 'node:fs/promises';

export function createRenderPort() {
  return {
    /**
     * @param {any} spec
     * @param {{ audioMix?: any }} [opts]
     */
    async start(spec, opts = {}) {
      const log = process.env.OPENCUT_STUB_RENDER_LOG;
      if (log) {
        await fs.appendFile(
          log,
          `${JSON.stringify({ spec, audioMix: opts.audioMix ?? null, at: new Date().toISOString() })}\n`,
        );
      }
      if (process.env.OPENCUT_STUB_RENDER_FAIL === '1') {
        return { error: 'AUDIO_DECODE_FAILED', detail: 'stub failure' };
      }
      return { jobId: spec.jobId, state: 'waiting' };
    },
    /** @param {string} jobId */
    async status(jobId) {
      return { jobId, state: 'done', framesTotal: 1, framesDone: 1 };
    },
    async cancel() {},
  };
}
