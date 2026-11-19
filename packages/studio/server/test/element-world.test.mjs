/**
 * R143 / SUB1 · M14-R2 · A —— 元素世界（源码 → 观察值）的六条真值。
 *
 * 守卫是纯函数，它判得对不对，取决于「观察值是不是真的」。这一份测观察值本身：
 * 删掉元素、同 ref 换节点、父级卸载、页面重写但节点没变、源码截断、路径越界。
 *
 * 跑法：node --test packages/studio/server/test/element-world.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isMounted, observationFromSource, pagePathOf } from '../element-world.mjs';
import { parseScene, resolveAt } from '../../../layers/scene-tree.mjs';
import { checkElementIntent, createGuardState } from '../../../film-core/element-guard.mjs';

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>p</title></head>
<body>
  <div class="page" id="page">
    <h1 id="title">季度复盘</h1>
    <p class="lead" id="lead">这一页是夹具</p>
    <div class="cards" id="cards"><div class="card" id="card-1"><h2>入轨</h2></div></div>
  </div>
</body></html>
`;

const KEY = 'card-a::#title';

/** @param {string} source @param {string[]} [keys] */
const observe = (source, keys = [KEY, 'card-a::#lead']) => {
  const result = observationFromSource({ projectId: 'proj-a', source, keys });
  assert.equal(result.ok, true, JSON.stringify(result));
  return /** @type {any} */ (result).observation;
};

test('W1 元素在 → present + mounted + 稳定签名', () => {
  const first = observe(PAGE);
  const second = observe(PAGE.replace(/\n/g, '\n'));
  assert.equal(first.elements[KEY].present, true);
  assert.equal(first.elements[KEY].mounted, true);
  assert.equal(first.elements[KEY].signature, second.elements[KEY].signature);
  assert.equal(first.instanceId.length, 64, 'instanceId 是页面源码 sha256');
});

test('W2 删掉元素 → present:false（守卫据此 ELEMENT_GONE）', () => {
  const obs = observe(PAGE.replace('<h1 id="title">季度复盘</h1>', ''));
  assert.equal(obs.elements[KEY].present, false);
  const verdict = checkElementIntent(
    { projectId: 'proj-a', instanceId: obs.instanceId, elementKey: KEY, signature: 'whatever', epoch: 1 },
    obs,
    createGuardState(),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'ELEMENT_GONE');
});

test('W3 同 ref 换节点（同 id、内容变了）→ 签名变（守卫据此 ELEMENT_REPLACED）', () => {
  const before = observe(PAGE);
  const after = observe(PAGE.replace('<h1 id="title">季度复盘</h1>', '<h1 id="title">季度复盘（新版）</h1>'));
  assert.notEqual(before.elements[KEY].signature, after.elements[KEY].signature);
  const verdict = checkElementIntent(
    { projectId: 'proj-a', instanceId: before.instanceId, elementKey: KEY, signature: before.elements[KEY].signature, epoch: 1 },
    after,
    createGuardState(),
  );
  assert.equal(verdict.ok, false);
  assert.equal(/** @type {any} */ (verdict).code, 'ELEMENT_REPLACED');
});

test('W4 父级 hidden / display:none / template → mounted:false（守卫据此 ELEMENT_UNMOUNTED）', () => {
  const hidden = observe(PAGE.replace('<div class="page" id="page">', '<div class="page" id="page" hidden>'));
  const displayNone = observe(PAGE.replace('<div class="page" id="page">', '<div class="page" id="page" style="display: none">'));
  const template = observe(PAGE.replace('<div class="page" id="page">', '<template id="parking"><div class="page" id="page">').replace('</div>\n</body>', '</div></template>\n</body>'));
  for (const [label, obs] of [['hidden', hidden], ['display:none', displayNone], ['template', template]]) {
    assert.equal(obs.elements[KEY].present, true, `${label}：元素还在源码里`);
    assert.equal(obs.elements[KEY].mounted, false, `${label}：应当判未挂载`);
    const verdict = checkElementIntent(
      { projectId: 'proj-a', instanceId: obs.instanceId, elementKey: KEY, signature: obs.elements[KEY].signature, epoch: 1 },
      obs,
      createGuardState(),
    );
    assert.equal(/** @type {any} */ (verdict).code, 'ELEMENT_UNMOUNTED', label);
  }
});

test('W5 页面重写但节点没变 → 同签名、不同实例（守卫据此「重建中」放行）', () => {
  const before = observe(PAGE);
  const after = observe(PAGE.replace('<meta charset="utf-8">', '<meta charset="utf-8"><!-- rebuilt 2026-11-16 -->'));
  assert.notEqual(before.instanceId, after.instanceId, '实例变了');
  assert.equal(before.elements[KEY].signature, after.elements[KEY].signature, '节点没变');
  const verdict = checkElementIntent(
    { projectId: 'proj-a', instanceId: before.instanceId, elementKey: KEY, signature: before.elements[KEY].signature, epoch: 1 },
    after,
    createGuardState(),
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.rebuilding, true);
});

test('W6 源码截断 / 路径越界 → 明确拒绝，不在半个树上判', () => {
  const broken = observationFromSource({ projectId: 'proj-a', source: '<html><body><div id="page"><h1 id="title">x', keys: [KEY] });
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'PAGE_UNREADABLE');
  assert.equal(pagePathOf('/p/one', '../two/x.html').ok, false);
  assert.equal(pagePathOf('/p/one', '/etc/passwd').ok, false);
  assert.equal(pagePathOf('/p/one', 'scenes/./a.html').ok, false);
  assert.equal(pagePathOf('/p/one', '.film/x.html').ok, false);
  const ok = pagePathOf('/p/one', 'scenes/card-a.html#t=0,4');
  assert.equal(ok.ok, true);
  assert.equal(/** @type {any} */ (ok).path, '/p/one/scenes/card-a.html');
});

test('W7 未挂载判定只看祖先链上的标志，不拿「不可见」当卸载', () => {
  const tree = parseScene('<html><body><div id="a"><h1 id="t" style="opacity: 0">x</h1></div></body></html>');
  const node = resolveAt(tree, '#t');
  assert.equal(isMounted(tree, node), true, 'opacity:0 是可见性问题，不是卸载（隐藏元素照样能写覆盖）');
});
