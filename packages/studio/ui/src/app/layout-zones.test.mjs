// @ts-nocheck —— 单测：分栏边界的夹取 / 存储 / 复位（纯函数，不起浏览器）
/**
 * R37 · B 批（批注 1）的量具自证：分栏可拖的**算术**在这里验，DOM 在
 * `scripts/s192-r37-zones.mjs` 里验。两边各管一段，互不替代：
 *
 *   ① 夹取：各条边的上下限、以及为相邻区保留空间的联动上限；
 *   ② 存储：只存拖过的那几条、读坏了当没存过、复位删键（删到空时整个键都不留）；
 *   ③ 度量：`measureZone` 的 width/height 取法（timeline 取 height，其余取 width）；
 *   ④ 防漂移：`ZONE_VAR` / `ZONE_AXIS` 必须覆盖 `ZONE_IDS`（少一条 = 手柄静默不动）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_MAX,
  ZONE_AXIS,
  ZONE_IDS,
  ZONE_MIN,
  ZONE_STAGE_MIN,
  ZONE_STORAGE_KEY,
  ZONE_TOP_MIN,
  ZONE_VAR,
  applyZones,
  clampZone,
  clearZones,
  loadZones,
  measureZone,
  persistZones,
  saveZone,
} from './layout-zones.mjs';

/** 最小 localStorage 替身（只实现用到的那三个方法）。 */
function memoryStore(seed) {
  /** @type {Map<string,string>} */
  const map = new Map(seed === undefined ? [] : Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    raw: (key) => (map.has(key) ? map.get(key) : null),
  };
}

test('分栏手柄各有变量名与轴，没有漏项', () => {
  assert.deepEqual([...ZONE_IDS], ['left', 'right', 'agent', 'timeline']);
  for (const id of ZONE_IDS) {
    assert.equal(typeof ZONE_VAR[id], 'string', `${id} 缺 CSS 变量`);
    assert.ok(ZONE_VAR[id].startsWith('--'), `${id} 的变量名要是自定义属性`);
    assert.ok(ZONE_AXIS[id] === 'col' || ZONE_AXIS[id] === 'row', `${id} 缺轴`);
    assert.equal(typeof ZONE_MIN[id], 'number', `${id} 缺下限`);
  }
  assert.equal(ZONE_AXIS.left, 'col');
  assert.equal(ZONE_AXIS.right, 'col');
  assert.equal(ZONE_AXIS.agent, 'col');
  assert.equal(ZONE_AXIS.timeline, 'row');
});

test('left library ranges from 220 to 800 with room reserved for the inspector and stage', () => {
  assert.equal(ZONE_STAGE_MIN, 420);
  const box = { w: 1440, h: 900, right: 280 };
  assert.equal(clampZone('left', 100, box), 220);
  assert.equal(clampZone('left', 320, box), 320);
  assert.equal(clampZone('left', 9999, box), 740);
  assert.equal(clampZone('left', 9999, { ...box, agent: 300 }), 440, 'opening the 300px Agent reduces room');
  assert.equal(clampZone('left', 9999, { ...box, w: 1920 }), 800);
  assert.equal(clampZone('left', 9999, { ...box, w: 700 }), 220);
});

test('R37-B · 检查器：低于 220 夹到 220，高于「舞台留 420」夹住', () => {
  const box = { w: 1280, h: 800, left: 208 };
  assert.equal(clampZone('right', 120, box), 220);
  assert.equal(clampZone('right', 300, box), 300);
  // 1280 − 208 − 420 = 652
  assert.equal(clampZone('right', 640, box), 640);
  assert.equal(clampZone('right', 9999, box), 1280 - 208 - ZONE_STAGE_MIN);
  assert.equal(clampZone('right', 652, box), 652);
  assert.equal(clampZone('right', 9999, { ...box, agent: 300 }), 352);
});

test('Agent leaves room for the inspector, the library minimum and the preview', () => {
  const box = { w: 1280, h: 800, left: 320, right: 248, agent: 232 };
  assert.equal(clampZone('agent', 100, box), 220);
  assert.equal(clampZone('agent', 360, box), 360, 'the library can temporarily fit into less space');
  assert.equal(clampZone('agent', 9999, box), 392);
  assert.equal(clampZone('agent', 9999, { ...box, w: 1920 }), AGENT_MAX);
  assert.equal(clampZone('agent', 9999, { ...box, w: 900 }), 220);
});

test('R37-B · 时间线：160 下限、上区留 240 上限', () => {
  const box = { w: 1280, h: 900 };
  assert.equal(clampZone('timeline', 40, box), 160);
  assert.equal(clampZone('timeline', 240, box), 240);
  // 900 − 240 = 660：拖到 900 会被夹到 660（上区至少留 240）
  assert.equal(clampZone('timeline', 900, box), 900 - ZONE_TOP_MIN);
  // 窗口太矮时上限低于下限 → 取下限（不返回一个比下限还小的数）
  assert.equal(clampZone('timeline', 400, { w: 1280, h: 300 }), 160);
});

test('R37-B · 非数字 / 缺 box：只夹下限，不返回 NaN', () => {
  assert.equal(clampZone('left', 'abc', { w: 1280, h: 800 }), 220);
  assert.equal(clampZone('left', undefined, { w: 1280, h: 800 }), 220);
  assert.equal(clampZone('left', 400, { w: 1280, h: 800 }), 400);
  assert.equal(clampZone('timeline', '300', { w: 1280, h: 800 }), 300);
});

test('R37-B · 存一条不会丢另一条，且落盘的是夹过的值', () => {
  const store = memoryStore();
  saveZone('left', 260, { w: 1440, h: 900, right: 280 }, store);
  saveZone('timeline', 300, { w: 1440, h: 900 }, store);
  const saved = JSON.parse(store.raw(ZONE_STORAGE_KEY));
  assert.deepEqual(saved, { left: 260, timeline: 300 });

  // 越界值落盘前就被夹住（不是把 900 写进去、显示时才夹）
  saveZone('right', 9000, { w: 1440, h: 900, left: 260 }, store);
  assert.equal(JSON.parse(store.raw(ZONE_STORAGE_KEY)).right, 1440 - 260 - ZONE_STAGE_MIN);
});

test('R37-B · 读坏了当没存过（坏 JSON / 数组 / 字符串 / 未知键）', () => {
  assert.deepEqual(loadZones(memoryStore()), {});
  assert.deepEqual(loadZones(memoryStore({ [ZONE_STORAGE_KEY]: '{oops' })), {});
  assert.deepEqual(loadZones(memoryStore({ [ZONE_STORAGE_KEY]: '[1,2]' })), {});
  assert.deepEqual(loadZones(memoryStore({ [ZONE_STORAGE_KEY]: '"text"' })), {});
  assert.deepEqual(loadZones(memoryStore({ [ZONE_STORAGE_KEY]: '{"left":"abc","foo":1}' })), {});
  assert.deepEqual(loadZones(memoryStore({ [ZONE_STORAGE_KEY]: '{"left":260.4}' })), { left: 260 });
});

test('R37-B · 复位单条只删那一条；全复位把键也删掉', () => {
  const store = memoryStore({
    [ZONE_STORAGE_KEY]: JSON.stringify({ left: 260, right: 300, timeline: 280 }),
  });
  assert.deepEqual(clearZones('left', store), { right: 300, timeline: 280 });
  assert.deepEqual(JSON.parse(store.raw(ZONE_STORAGE_KEY)), { right: 300, timeline: 280 });

  assert.deepEqual(clearZones('right', store), { timeline: 280 });
  assert.deepEqual(clearZones('timeline', store), {});
  assert.equal(store.raw(ZONE_STORAGE_KEY), null, '删到空时不该留一个 "{}"');
});

test('保存和复位对话框宽度会保留其他布局偏好', () => {
  const store = memoryStore({ [ZONE_STORAGE_KEY]: JSON.stringify({ left: 320, timeline: 280 }) });
  const box = { w: 1280, h: 800, right: 248 };
  assert.deepEqual(saveZone('agent', 500, box, store), { left: 320, agent: 392, timeline: 280 });
  assert.deepEqual(loadZones(store), { left: 320, agent: 392, timeline: 280 });
  assert.deepEqual(clearZones('agent', store), { left: 320, timeline: 280 });
});

test('R37-B · applyZones 先清后写（复位靠的就是「清」）', () => {
  /** @type {Map<string,string>} */
  const props = new Map([
    ['--col-left', '260px'],
    ['--col-inspector', '300px'],
    ['--row-timeline', '280px'],
  ]);
  const host = {
    style: {
      setProperty: (name, value) => void props.set(name, value),
      removeProperty: (name) => void props.delete(name),
    },
  };
  const written = applyZones({ left: 300, right: 260, agent: 370 }, host);
  assert.equal(written, host);
  assert.equal(props.get('--col-left'), '300px');
  assert.equal(props.get('--col-inspector'), '260px');
  assert.equal(props.get('--col-agent'), '370px');
  assert.equal(props.has('--row-timeline'), false, '没值的边必须被清掉');

  applyZones({}, host);
  assert.equal(props.size, 0, '全复位后清除所有已写入的内联变量');
});

test('R37-B · measureZone：竖边取 width、横边取 height', () => {
  const rects = {
    stageDock: { width: 224, height: 608 },
    inspector: { width: 280, height: 608 },
    agentPanel: { width: 360, height: 848 },
    timelineRow: { width: 1440, height: 240 },
  };
  assert.equal(measureZone('left', rects), 224);
  assert.equal(measureZone('right', rects), 280);
  assert.equal(measureZone('agent', rects), 360);
  assert.equal(measureZone('timeline', rects), 240);
  assert.equal(measureZone('left', null), null);
  assert.equal(measureZone('timeline', {}), null);
});

test('R37-B · persistZones 一次写整表，空表连键一起删（不留 {}）', () => {
  const store = memoryStore();
  const written = persistZones({ left: 260, timeline: 300.4 }, store);
  assert.deepEqual(written, { left: 260, timeline: 300 }, '返回值 = 真正落盘的那一份（取整）');
  assert.deepEqual(JSON.parse(store.raw(ZONE_STORAGE_KEY)), { left: 260, timeline: 300 });

  // 非有限值不落盘
  const cleaned = persistZones({ left: 300, right: Number.NaN }, store);
  assert.deepEqual(cleaned, { left: 300 });
  assert.deepEqual(JSON.parse(store.raw(ZONE_STORAGE_KEY)), { left: 300 });

  assert.deepEqual(persistZones({}, store), {});
  assert.equal(store.raw(ZONE_STORAGE_KEY), null, '尺寸偏好为空时键要消失');
});
