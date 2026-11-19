/**
 * K 系列自测夹具 · 一份**独立写的**「正确实现」。
 *
 * 它不是产品代码，也不被产品引用。R18 时给 `scripts/uir-k-series.mjs --subject=fixture` 用，
 * **该档已被取代**（合并后只剩 default|p1），现在没有任何脚本引用它，保留只为追溯。
 * 证明「判据本身能判」——同一套断言喂给正确实现应当全绿，喂给墙钟/宽松实现必须红。
 *
 * 接口（K 脚本的 fixture adapter 只认这三个）：
 *   parse(text)                  → { doc, diagnostics }
 *   write(text, edits, baseHash) → { ok:true, text, changed } | { ok:false, code, diagnostics }
 *   validateEntry(entry, dur)    → { ok:true } | { ok:false, code, detail }
 *
 * 语义照 `E05-KEYFRAMES-SPEC.md` §2/§3，码名逐字。
 */

import crypto from 'node:crypto';

const NOT_INTERPOLABLE = new Set([
  'background-image',
  'display',
  'position',
  'float',
  'overflow',
  'overflow-x',
  'overflow-y',
  'font-family',
  'animation',
  'transition',
  'content',
  'visibility',
]);

function fail(code, detail) {
  return { ok: false, code, detail };
}

/** 独立实现（故意不抄 oracle 的循环结构）。 */
export function validateEntry(entry, duration) {
  const frames = entry?.kf;
  if (frames === undefined) return { ok: true };
  if (!Array.isArray(frames)) return fail('KF_SHAPE', 'kf 必须是数组');
  if (frames.length <= 1) return fail('KF_TOO_SHORT', `帧数 ${frames.length}`);

  let last = -Infinity;
  const keysOfFirst = Object.keys(frames[0]?.style ?? {}).sort();
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const t = frame?.t;
    if (typeof t !== 'number' || !Number.isFinite(t)) return fail('KF_ORDER', `第 ${index} 帧 t 非有限数`);
    if (!(t > last)) return fail('KF_ORDER', `第 ${index} 帧 t=${t} 未严格大于 ${last}`);
    last = t;

    const keys = Object.keys(frame?.style ?? {}).sort();
    if (keys.join('|') !== keysOfFirst.join('|')) {
      return fail('KF_PROPS_MISMATCH', `第 ${index} 帧属性集与第 0 帧不同`);
    }
    for (const key of keys) {
      if (NOT_INTERPOLABLE.has(key)) return fail('KF_NOT_INTERPOLABLE', `${key} 不可插值`);
    }
    if (t < 0 || t > duration) return fail('KF_OUT_OF_RANGE', `第 ${index} 帧 t=${t} 不在 [0, ${duration}]`);
  }

  const staticKeys = Object.keys(entry.style ?? {});
  const overlapped = keysOfFirst.filter((key) => staticKeys.includes(key));
  if (overlapped.length > 0) return fail('KF_STATIC_CONFLICT', `静态与 kf 同属性：${overlapped.join(',')}`);
  return { ok: true };
}

function unescapeAttr(value) {
  return value.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function parseOverrides(text) {
  const tag = /<iframe\b[^>]*>/i.exec(text);
  if (tag === null) return { overrides: [], duration: 0, tag: '' };
  const raw = /\boverrides='([^']*)'/i.exec(tag[0]);
  const src = /\bsrc="([^"]*)"/i.exec(tag[0]);
  let overrides = [];
  if (raw !== null) {
    try {
      const decoded = JSON.parse(unescapeAttr(raw[1]));
      if (Array.isArray(decoded)) overrides = decoded;
    } catch {
      overrides = [];
    }
  }
  const span = src === null ? null : /#t=([\d.]+),([\d.]+)/.exec(src[1]);
  const duration = span === null ? 0 : Number(span[2]) - Number(span[1]);
  return { overrides, duration, tag: tag[0] };
}

export function parse(text) {
  const { overrides, duration } = parseOverrides(text);
  return {
    doc: {
      tracks: [{ clips: [{ id: 'scene-k', duration, overrides }] }],
    },
    diagnostics: [],
  };
}

export function write(text, edits, baseHash) {
  if (baseHash !== undefined && baseHash !== sha256(text)) {
    return { ok: false, code: 'CONFLICT', diagnostics: [{ code: 'CONFLICT' }] };
  }
  if (!Array.isArray(edits)) return { ok: false, code: 'INVALID', diagnostics: [{ code: 'INVALID' }] };
  if (edits.length === 0) return { ok: true, text, bytes: Buffer.byteLength(text), changed: false };

  const { overrides, duration, tag } = parseOverrides(text);
  let next = overrides;
  for (const edit of edits) {
    if (edit?.field !== 'overrides' || !Array.isArray(edit.value)) {
      return { ok: false, code: 'UNKNOWN_FIELD', diagnostics: [{ code: 'UNKNOWN_FIELD' }] };
    }
    for (const entry of edit.value) {
      const verdict = validateEntry(entry, duration);
      if (!verdict.ok) {
        return { ok: false, code: verdict.code, diagnostics: [{ code: verdict.code }] };
      }
    }
    next = edit.value;
  }
  const replacement = `overrides='${escapeAttr(JSON.stringify(next))}'`;
  const nextTag = /\boverrides='[^']*'/i.test(tag) ? tag.replace(/\boverrides='[^']*'/i, replacement) : `${tag.slice(0, -1)} ${replacement}>`;
  return { ok: true, text: text.replace(tag, nextTag), bytes: Buffer.byteLength(text), changed: nextTag !== tag };
}

function escapeAttr(value) {
  return value.replace(/'/g, '&#39;');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
