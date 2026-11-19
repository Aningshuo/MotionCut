/**
 * R178 · 字段底账自动回归（SUB1）
 *
 * 读两份 ledger JSON：
 *   - current：本轮探针 `scripts/r171-field-ledger.mjs` 在候选上的输出
 *     （默认 `evidence/rounds/R50-SUB1/field-ledger/current.json`）
 *   - baseline：126 基线，`171c528e` 上用同一把尺子实跑
 *     （默认 `evidence/rounds/R50-SUB1/field-ledger/baseline-126.json`）
 *
 * 只要「页 / 组 / 字段」任一计数与基线不同，或字段换了组/页，测试就红。
 * 路径可用环境变量覆盖：OPENCUT_LEDGER / OPENCUT_LEDGER_BASELINE。
 *
 * 跑法：node --test packages/layers/test/r178-field-ledger.test.mjs
 * （`npm test` 的 `packages/* /test/*.test.mjs` 也会带上它。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** @param {string} envKey @param {string} fallback */
const resolve = (envKey, fallback) => {
  const given = process.env[envKey];
  return given === undefined || given === '' ? path.join(ROOT, fallback) : path.resolve(given);
};
const CURRENT = resolve('OPENCUT_LEDGER', 'evidence/rounds/R50-SUB1/field-ledger/current.json');
const BASELINE = resolve('OPENCUT_LEDGER_BASELINE', 'evidence/rounds/R50-SUB1/field-ledger/baseline-126.json');

/** @param {string} file @param {string} label */
const readLedger = (file, label) => {
  assert.ok(fs.existsSync(file), `${label} ledger 不存在：${file}`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(data.pages), `${label} ledger 缺 pages[]：${file}`);
  assert.ok(Number.isFinite(data.total), `${label} ledger 缺 total：${file}`);
  return data;
};

/** 把 ledger 压成「页 → 字段数」「页|组 → 字段数」「id → {group,page}」。
 * @param {{ pages: any[], total: number }} ledger
 */
const index = (ledger) => {
  const pageCounts = new Map();
  const groupCounts = new Map();
  const fields = new Map();
  for (const page of ledger.pages) {
    pageCounts.set(page.id, (page.fields ?? []).length);
    for (const field of page.fields ?? []) {
      const gkey = `${page.id}|${field.group}`;
      groupCounts.set(gkey, (groupCounts.get(gkey) ?? 0) + 1);
      fields.set(field.id, { group: field.group, page: field.page ?? page.id, name: field.name });
    }
  }
  return { pageCounts, groupCounts, fields };
};

/** @param {Map<string, number>} actual @param {Map<string, number>} expected @param {string} what */
const diffMaps = (actual, expected, what) => {
  const problems = [];
  for (const [key, value] of expected) {
    if (!actual.has(key)) problems.push(`${what} 缺 ${key}（基线 ${value}，当前 0）`);
    else if (actual.get(key) !== value) problems.push(`${what} ${key} 基线 ${value} → 当前 ${actual.get(key)}`);
  }
  for (const [key, value] of actual) {
    if (!expected.has(key)) problems.push(`${what} 多出 ${key}（基线 0，当前 ${value}）`);
  }
  return problems;
};

const current = readLedger(CURRENT, 'current');
const baseline = readLedger(BASELINE, 'baseline');
const cur = index(current);
const base = index(baseline);

test('页集合与每页字段数与 126 基线一致', () => {
  const basePages = [...base.pageCounts.keys()];
  const curPages = [...cur.pageCounts.keys()];
  assert.deepEqual(curPages, basePages, `页顺序/集合变了：基线 ${basePages.join(',')} → 当前 ${curPages.join(',')}`);
  const problems = diffMaps(cur.pageCounts, base.pageCounts, '页字段数');
  assert.deepEqual(problems, [], problems.join('；'));
  assert.equal(current.total, baseline.total, `字段总数：基线 ${baseline.total} → 当前 ${current.total}`);
});

test('每页每组字段数与 126 基线一致', () => {
  const problems = diffMaps(cur.groupCounts, base.groupCounts, '组字段数');
  assert.deepEqual(problems, [], problems.join('；'));
});

test('字段 id 集合无缺失、无新增、无重复', () => {
  const ids = [...cur.fields.keys()];
  assert.equal(new Set(ids).size, ids.length, `字段 id 有重复：${ids.filter((id, i) => ids.indexOf(id) !== i).join(',')}`);
  const missing = [...base.fields.keys()].filter((id) => !cur.fields.has(id));
  const added = [...cur.fields.keys()].filter((id) => !base.fields.has(id));
  assert.deepEqual(missing, [], `相对 126 基线缺字段：${missing.join(',')}`);
  assert.deepEqual(added, [], `相对 126 基线多字段：${added.join(',')}`);
});

test('每个字段的组与页未变', () => {
  const changed = [];
  for (const [id, b] of base.fields) {
    const c = cur.fields.get(id);
    if (!c) continue;
    if (c.group !== b.group) changed.push(`${id} 组 ${b.group} → ${c.group}`);
    if (c.page !== b.page) changed.push(`${id} 页 ${b.page} → ${c.page}`);
  }
  assert.deepEqual(changed, [], `字段归属变了：${changed.join('；')}`);
});

test('ledger 自带的 compare 块（若存在）与「零缺失/零新增/零变化」一致', () => {
  if (current.compare === null || current.compare === undefined) return;
  assert.deepEqual(current.compare.missing ?? [], [], `ledger.compare.missing=${JSON.stringify(current.compare.missing)}`);
  assert.deepEqual(current.compare.added ?? [], [], `ledger.compare.added=${JSON.stringify(current.compare.added)}`);
  assert.deepEqual(current.compare.changed ?? [], [], `ledger.compare.changed=${JSON.stringify(current.compare.changed)}`);
});
