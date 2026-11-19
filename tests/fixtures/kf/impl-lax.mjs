/**
 * K 系列自测夹具 · 一份「宽松实现」：不校验、什么都放行。
 *
 * 用途（历史）：`--subject=fixture` 的另一半对照 —— 判据必须能抓住它（K04/K05 应当红）。
 * `fixture` 档已被取代，现在没有脚本引用；保留只为追溯判据的区分度。
 * 如果宽松实现也全绿，说明判据只是把「有没有 kf」当成了全部，没测到五条拒绝。
 */
import crypto from 'node:crypto';

export { parse } from './impl-correct.mjs';

export function validateEntry() {
  return { ok: true };
}

export function write(text, edits, baseHash) {
  if (baseHash !== undefined && baseHash !== crypto.createHash('sha256').update(text, 'utf8').digest('hex')) {
    return { ok: false, code: 'CONFLICT', diagnostics: [{ code: 'CONFLICT' }] };
  }
  if (!Array.isArray(edits)) return { ok: false, code: 'INVALID', diagnostics: [{ code: 'INVALID' }] };
  if (edits.length === 0) return { ok: true, text, bytes: Buffer.byteLength(text), changed: false };

  const tag = /<iframe\b[^>]*>/i.exec(text)?.[0] ?? '';
  const value = edits[0]?.value;
  const replacement = `overrides='${JSON.stringify(value).replace(/'/g, '&#39;')}'`;
  const nextTag = /\boverrides='[^']*'/i.test(tag) ? tag.replace(/\boverrides='[^']*'/i, replacement) : `${tag.slice(0, -1)} ${replacement}>`;
  return { ok: true, text: text.replace(tag, nextTag), bytes: Buffer.byteLength(text), changed: nextTag !== tag };
}
