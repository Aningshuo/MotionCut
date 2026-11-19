/**
 * 检查器极简渲染（副线1 · WP14）
 *
 * 只负责把 InspectorModel 变成可断言的 DOM 片段（字符串）。真正的样式/交互由主线
 * 的 UI 骨架接；这里保证「多选状态」「字段来源」「锁定不可编辑」在 DOM 上可见，
 * 而不是只在内存里。
 */
import type { InspectorAny } from '../../../../../layers/inspector';

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESC[ch] ?? ch);
}

/** 单层：按组渲染字段；多选：明确显示数量与「不支持多选编辑」。 */
export function renderInspector(model: InspectorAny): string {
  if (model.mode === 'multi') {
    return (
      `<div class="inspector" data-mode="multi" data-count="${model.count}" data-editable="false">` +
      `<div class="inspector-multi" data-note="${escapeHtml(model.note)}">` +
      `已选 ${model.count} 项 · ${escapeHtml(model.note)}` +
      `</div></div>`
    );
  }
  const groups = model.groups
    .map(
      (g) =>
        `<section class="inspector-group" data-group="${g.id}">` +
        `<h3>${escapeHtml(g.label)}</h3>` +
        g.fields
          .map(
            (f) =>
              `<div class="inspector-field" data-field="${escapeHtml(f.id)}" data-source="${f.source}" ` +
              `data-editable="${f.editable}" data-unit="${escapeHtml(f.unit)}" ` +
              `data-locked="${f.lockedReason ?? ''}">` +
              `<span class="label">${escapeHtml(f.label)}</span>` +
              `<span class="value">${escapeHtml(f.current)}</span>` +
              `</div>`
          )
          .join('') +
        `</section>`
    )
    .join('');
  return (
    `<div class="inspector" data-mode="single" data-clip="${escapeHtml(model.ref.clipId)}" ` +
    `data-at="${escapeHtml(model.ref.at)}" data-locked="${model.locked}" data-editable="${!model.locked}">` +
    groups +
    `</div>`
  );
}

export default renderInspector;
