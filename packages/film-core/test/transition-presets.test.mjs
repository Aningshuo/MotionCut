// @ts-nocheck -- Runtime JSON contract tests use intentional malformed inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse, writeValue } from '../film-doc.mjs';
import { applyOpsDetailed } from '../ops.mjs';
import { listTransitionPresets, planTransitionPreset, planRemoveTransitionPreset, transitionSpecOf, requiresTransitionStage } from '../transition-presets.mjs';
import { transitionFrame } from '../../scene-runtime/transition-runtime.mjs';
import { assertRenderable } from '../../render/film-export.mjs';
import { createEditSession } from '../../studio/server/edit-session.mjs';

const HTML = `<!doctype html><html><head><meta name="viewport" content="width=1280, height=720"></head><body><section id="v1"><video id="a" src="assets/a.mp4#t=1,5" at="0"></video><video id="b" src="assets/b.mp4#t=2,6" at="4"></video></section></body></html>`;
const doc = () => { const { sourceHash, ...value } = parse(HTML).doc; return structuredClone(value); };
const apply = (d, ops) => applyOpsDetailed(d, ops).value;
const find = (d, id) => d.tracks.flatMap(t => t.clips).find(c => c.id === id);
const plan = (presetId, extra = {}) => planTransitionPreset({ doc: doc(), presetId, from: 'a', to: 'b', duration: 0.6, ...extra });

test('every ready preset produces real time-varying frames across all three mechanisms', () => {
  const presets = listTransitionPresets();
  assert.ok(presets.length >= 35);
  assert.equal(new Set(presets.map(p => p.id)).size, presets.length);
  assert.deepEqual(new Set(presets.map(p => p.mechanism)), new Set(['fade', 'motion', 'overlay']));
  for (const preset of presets) {
    const result = plan(preset.id);
    assert.equal(result.ok, true, `${preset.id}: ${result.message}`);
    const d = apply(doc(), result.ops), spec = transitionSpecOf(find(d, 'b'));
    assert.ok(spec && requiresTransitionStage(d));
    const a = transitionFrame(spec, spec.start + spec.duration * 0.2, d.stage);
    const b = transitionFrame(spec, spec.start + spec.duration * 0.8, d.stage);
    assert.equal(a.active, true); assert.equal(b.active, true);
    assert.notDeepEqual(a, b, preset.id);
    assert.deepEqual(a, transitionFrame(spec, spec.start + spec.duration * 0.2, d.stage), 'seek must be deterministic');
  }
  presets[0].name = 'mutated';
  assert.notEqual(listTransitionPresets()[0].name, 'mutated');
});

test('dissolve uses a full outgoing image and an incoming opacity, while push and mask have different pixels', () => {
  const dissolve = plan('dissolve').transition;
  const push = plan('push-left').transition;
  const iris = plan('iris').transition;
  const mid = s => transitionFrame(s, (s.start + s.end) / 2, { w: 100, h: 50 });
  assert.equal(mid(dissolve).from.opacity, 1);
  assert.ok(Math.abs(mid(dissolve).to.opacity - 0.5) < 1e-12);
  assert.equal(mid(push).to.opacity, 1);
  assert.match(mid(push).to.transform, /translate\(50px/);
  assert.match(mid(iris).to.clipPath, /circle/);
  assert.equal(find(apply(doc(), plan('dissolve').ops), 'b').time[0], 2, 'source-in is not silently reset');
});

test('one op batch supports inverse, persisted reopen, and exact removal', () => {
  for (const id of ['dissolve', 'push-left', 'dip-white', 'confetti', 'fade-out']) {
    const initial = doc(), planned = plan(id), applied = applyOpsDetailed(initial, planned.ops);
    assert.deepEqual(apply(applied.value, applied.inverse), initial, id);
    const wrote = writeValue(HTML, applied.value, createHash('sha256').update(HTML).digest('hex'));
    assert.equal(wrote.ok, true, `${id}: ${JSON.stringify(wrote.diagnostics)}`);
    const { sourceHash, ...reopened } = parse(wrote.text).doc;
    assert.ok(requiresTransitionStage(reopened));
    const removed = planRemoveTransitionPreset({ doc: reopened, to: 'b' });
    assert.equal(removed.ok, true, `${id}: ${removed.message}`);
    const restored = apply(reopened, removed.ops);
    assert.deepEqual(restored, initial, id);
    const removalWrite = writeValue(wrote.text, restored, createHash('sha256').update(wrote.text).digest('hex'));
    assert.equal(removalWrite.ok, true, `${id}: ${JSON.stringify(removalWrite.diagnostics)}`);
    assert.equal(removalWrite.text.includes('data-opencut-transition'), false);
    assert.equal(requiresTransitionStage(parse(removalWrite.text).doc), false);
    assert.equal(writeValue(wrote.text, reopened, '0'.repeat(64)).code, 'CONFLICT');
  }
});

test('removal preserves unrelated attributes/styles and refuses changed timing/source', () => {
  const d = apply(doc(), plan('iris').ops), b = find(d, 'b');
  b.attrs['data-user-note'] = 'keep'; b.style = 'border-radius: 7px';
  const removed = planRemoveTransitionPreset({ doc: d, to: 'b' });
  assert.equal(removed.ok, true);
  const out = find(apply(d, removed.ops), 'b');
  assert.equal(out.attrs['data-user-note'], 'keep'); assert.equal(out.style, 'border-radius: 7px');
  b.at += 0.1;
  const conflict = planRemoveTransitionPreset({ doc: d, to: 'b' });
  assert.equal(conflict.code, 'TRANSITION_BASE_CONFLICT'); assert.deepEqual(conflict.ops, []);
});

test('replace is one reversible batch and cannot overwrite a stale snapshot', () => {
  const initial = doc(), withFirst = apply(initial, plan('dissolve').ops);
  const next = plan('push-down', { doc: withFirst });
  assert.equal(next.ok, true); assert.ok(next.replaced);
  const replaced = applyOpsDetailed(withFirst, next.ops);
  assert.deepEqual(apply(replaced.value, replaced.inverse), withFirst);
  assert.equal(transitionSpecOf(find(replaced.value, 'b')).effect, 'push');
  find(withFirst, 'a').time = [0, 4];
  assert.equal(plan('push-left', { doc: withFirst }).code, 'TRANSITION_BASE_CONFLICT');
});

test('invalid cut, unsupported preset, invalid duration, short source and locked target are refused without ops', () => {
  const gap = doc();find(gap,'b').at=5;
  for(const result of [plan('not-real'), plan('iris',{doc:gap}), plan('iris',{duration:-1}), plan('iris',{duration:100})]) {
    assert.equal(result.ok,false);assert.deepEqual(result.ops,[]);
  }
  const locked=doc();locked.tracks[0].locked=true;
  assert.equal(plan('iris',{doc:locked}).code,'LOCKED');
  const short=doc();find(short,'a').time=[1,1.01];find(short,'b').at=.01;
  assert.equal(plan('iris',{doc:short}).code,'TRANSITION_NO_HEADROOM');
});

test('generic insert/move cannot enter locked tracks, props guard remains intact', () => {
  const d=doc();d.tracks.push({index:1,role:'picture',locked:true,clips:[]});
  for(const ops of [[{op:'insert',track:1,clip:{id:'c',kind:'video',src:'assets/c.mp4',time:[0,1]}}], [{op:'move',clip:'a',at:0,track:1}], [{op:'props',edits:[{clip:'a',prop:'track',value:1}]}]]) {
    assert.throws(()=>apply(d,ops),e=>e.code==='LOCKED');
  }
  assert.equal(d.tracks[0].clips.length,2,'failure must leave input untouched');
});

test('a pure-media transition explicitly refuses the media-only exporter', () => {
  const d=apply(doc(),plan('blur-dissolve').ops);
  assert.ok(requiresTransitionStage(d));
  const p={visualClips:[{id:'a',kind:'video'}],sceneClips:[],requiresStage:true};
  assert.throws(()=>assertRenderable(p),e=>e.code==='UNSUPPORTED');
  assert.doesNotThrow(()=>assertRenderable(p,{allowScenes:true}));
  assert.equal(requiresTransitionStage({requiresStage:true}),true);
});

test('fractional fps durations are whole frames; source speed/time mapping survives roundtrip', () => {
  const d=doc();d.fps={num:30000,den:1001};find(d,'a').speed=2;find(d,'b').at=2;
  const result=plan('zoom-in',{doc:d,duration:.63});
  assert.equal(result.ok,true);
  assert.ok(Math.abs(result.transition.duration*30000/1001-Math.round(result.transition.duration*30000/1001))<.0001);
  const changed=apply(d,result.ops);assert.deepEqual(find(changed,'a').time,[1,5]);assert.equal(find(changed,'a').speed,2);
});

test('the real edit session commits one history step, Undo/Redo restores source, and external CAS change is retained', async () => {
  const hash = text => createHash('sha256').update(text).digest('hex');
  let disk = HTML, writes = 0;
  const io = {
    async read(){ return {text:disk,sourceHash:hash(disk)}; },
    async commit(path,text,expectedHash){
      if(hash(disk)!==expectedHash)return{ok:false,code:'CONFLICT',actualHash:hash(disk)};
      disk=text;writes++;return{ok:true,sourceHash:hash(disk)};
    },
    async snapshot(){return{ok:true,commit:'memory-history'};},
  };
  const session = createEditSession({path:'/virtual/transition-test/film.html',io});
  assert.equal((await session.load()).ok,true);
  const p=planTransitionPreset({doc:session.value,presetId:'transition/iris',from:'a',to:'b',duration:.6});
  assert.equal((await session.apply(p.ops,{opId:'one-gesture'})).ok,true);
  const changed=disk;
  assert.notEqual(disk,HTML);assert.equal(writes,1);assert.equal(session.depths().undo,1);
  assert.equal((await session.undo()).ok,true);assert.equal(disk,HTML);
  assert.equal((await session.redo()).ok,true);assert.equal(disk,changed);
  const replacement=planTransitionPreset({doc:session.value,presetId:'transition/dip-white',from:'a',to:'b',duration:.6});
  disk+='<!-- external edit -->';const external=disk;
  const rejected=await session.apply(replacement.ops,{opId:'second-gesture'});
  assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'CONFLICT');assert.equal(disk,external);
});
