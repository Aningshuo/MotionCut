/**
 * 版本 diff → 中文摘要（S75 · WP09）。
 *
 * 单独放 `.mjs` 的原因：验收脚本要在 Node 里直接 import 这个纯函数（不经过 tsc），
 * 而 `.ts` 不能被 Node 直接加载。和 S72 的 `batch-detach.mjs` 同一套路。
 *
 * 服务端的 `diffVersion` 是「该版本相对**父提交**」的 numstat：只有路径 / 状态 / 增删行数，
 * 没有逐字段语义。所以摘要只说「改了哪些文件、增删多少行」，**不假装知道改了哪个片段**。
 */

/**
 * @typedef {{ path: string, status: 'added'|'deleted'|'modified', additions: number, deletions: number }} DiffFile
 * @typedef {{ ok: true, sha: string, files: DiffFile[], mediaChanged: string[], missingMedia: number }} DiffData
 */

const STATUS_LABEL = Object.freeze({
  added: '新增',
  deleted: '删除',
  modified: '修改',
});

/**
 * @param {DiffData} data
 * @returns {string[]} 第一行是汇总，其余每个文件一行，最后一行是媒体说明
 */
export function summarizeDiff(data) {
  const files = Array.isArray(data?.files) ? data.files : [];
  if (files.length === 0) {
    return ['这个版本没有文本改动（只有媒体清单变化或空提交）。'];
  }
  const added = files.reduce((sum, file) => sum + (file.status === 'added' ? 1 : 0), 0);
  const deleted = files.reduce((sum, file) => sum + (file.status === 'deleted' ? 1 : 0), 0);
  const modified = files.length - added - deleted;
  const plus = files.reduce((sum, file) => sum + (Number.isFinite(file.additions) ? file.additions : 0), 0);
  const minus = files.reduce((sum, file) => sum + (Number.isFinite(file.deletions) ? file.deletions : 0), 0);
  const head = `共 ${String(files.length)} 个文件改动：${[
    added > 0 ? `新增 ${String(added)}` : '',
    modified > 0 ? `修改 ${String(modified)}` : '',
    deleted > 0 ? `删除 ${String(deleted)}` : '',
  ]
    .filter((part) => part !== '')
    .join(' / ')}；合计 +${String(plus)} / −${String(minus)} 行。`;
  const lines = files.map(
    (file) =>
      `· ${file.path} — ${STATUS_LABEL[file.status] ?? file.status}（+${String(file.additions)} / −${String(file.deletions)}）`,
  );
  const media =
    data.missingMedia > 0
      ? `媒体：${String(data.missingMedia)} 个记录在案的文件现在大小对不上（${data.mediaChanged.slice(0, 3).join(', ')}${data.mediaChanged.length > 3 ? ' …' : ''}）。`
      : '媒体：记录在案的文件都在原处、大小一致。';
  return [head, ...lines, media];
}
