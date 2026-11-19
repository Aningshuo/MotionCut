// @ts-nocheck -- Browser factory is exercised with a minimal owned DOM/canvas adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { transitionFrame, createTransitionRuntime } from './transition-runtime.mjs';
import { listTransitionPresets, planTransitionPreset, transitionPreviewHtml } from '../film-core/transition-presets.mjs';

function environment(spec) {
  const commands = [], canvases = [];
  const css = () => {
    const m = new Map();
    return { setProperty(k,v,p=''){m.set(k,{value:v,priority:p});},removeProperty(k){m.delete(k);},getPropertyValue(k){return m.get(k)?.value??'';},getPropertyPriority(k){return m.get(k)?.priority??'';} };
  };
  const context = new Proxy({}, { get(target,key){
    if(key==='createLinearGradient'||key==='createRadialGradient')return(...args)=>{commands.push([key,...args]);return{addColorStop(...x){commands.push(['stop',...x]);}};};
    return (...args)=>commands.push([key,...args]);
  },set(target,key,value){commands.push(['set',key,value]);return true;} });
  const document = { defaultView:{getComputedStyle(el){return {opacity:el.style.getPropertyValue('opacity')||'1',transform:el.style.getPropertyValue('transform')||'none',filter:el.style.getPropertyValue('filter')||'none'};}}, body:{appendChild(c){canvases.push(c);}}, createElement(){return {style:{},setAttribute(){},getContext(){return context;},remove(){}};} };
  const clips=['a','b'].map(id=>({id,kind:'video',baseOpacity:1,z:1,el:{ownerDocument:document,style:css(),getAttribute(){return id==='b'?JSON.stringify(spec):null;}}}));
  return {document,clips,commands,canvases};
}
const doc = {stage:{w:320,h:180},fps:{num:30,den:1},tracks:[{index:0,role:'picture',clips:[{id:'a',kind:'video',src:'a.mp4',at:0,time:[0,2]},{id:'b',kind:'video',src:'b.mp4',at:2,time:[0,2]}]}]};

test('serialized runtime and every generated DOM preview are valid standalone JavaScript',()=>{
  new Script(`(${createTransitionRuntime.toString()})(${transitionFrame.toString()})`);
  for(const preset of listTransitionPresets()){
    const html=transitionPreviewHtml(preset.id);
    assert.ok(html.includes('window.film=')&&!html.includes('<svg'));
    new Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  }
});

test('all overlay presets execute canvas drawing commands and seeking is reproducible',()=>{
  for(const preset of listTransitionPresets().filter(p=>p.mechanism==='overlay')){
    const spec=planTransitionPreset({doc,presetId:preset.id,from:'a',to:'b',duration:.6}).transition;
    const env=environment(spec), runtime=createTransitionRuntime(transitionFrame);
    const t=spec.start+(spec.end-spec.start)*.3;
    runtime.beforeFrame(env.clips);runtime.apply(env.clips,t,doc.stage,env.document);
    const first=JSON.parse(JSON.stringify(env.commands.filter(x=>x[0]!=='clearRect')));
    assert.ok(first.some(x=>['fillRect','fill','arc'].includes(x[0])),preset.id);
    env.commands.length=0;runtime.beforeFrame(env.clips);runtime.apply(env.clips,t,doc.stage,env.document);
    assert.deepEqual(JSON.parse(JSON.stringify(env.commands.filter(x=>x[0]!=='clearRect'))),first,preset.id);
    env.commands.length=0;runtime.beforeFrame(env.clips);runtime.apply(env.clips,spec.end+1,doc.stage,env.document);
    assert.ok(env.commands.some(x=>x[0]==='clearRect'));
    assert.equal(env.commands.some(x=>x[0]==='fillRect'),false,'overlay must disappear outside its interval');
    runtime.dispose();
  }
});

test('transient motion composes manual styles and restores them after leaving the transition',()=>{
  const spec=planTransitionPreset({doc,presetId:'transition/blur-dissolve',from:'a',to:'b',duration:.6}).transition;
  const env=environment(spec),runtime=createTransitionRuntime(transitionFrame),b=env.clips[1];
  b.el.style.setProperty('filter','grayscale(.4)');b.el.style.setProperty('z-index','9');
  runtime.beforeFrame(env.clips);runtime.apply(env.clips,(spec.start+spec.end)/2,doc.stage,env.document);
  assert.match(b.el.style.getPropertyValue('filter'),/blur\(7px\) grayscale\(\.4\)/);
  assert.ok(Math.abs(Number(b.el.style.getPropertyValue('opacity'))-.5)<1e-12);
  runtime.beforeFrame(env.clips);runtime.apply(env.clips,spec.end+1,doc.stage,env.document);
  assert.equal(b.el.style.getPropertyValue('filter'),'grayscale(.4)');
  assert.equal(b.el.style.getPropertyValue('z-index'),'9');
  assert.equal(b.el.style.getPropertyValue('opacity'),'');
});

test('preview video gains use the same linear envelopes as the existing audio export mixer',()=>{
  const spec=planTransitionPreset({doc,presetId:'transition/push-right',from:'a',to:'b',duration:.6}).transition;
  const env=environment(spec),runtime=createTransitionRuntime(transitionFrame);runtime.beforeFrame(env.clips);
  const t=spec.start+(spec.end-spec.start)*.25;
  assert.ok(Math.abs(runtime.audioGain(env.clips[0],t)-.75)<1e-12);
  assert.ok(Math.abs(runtime.audioGain(env.clips[1],t)-.25)<1e-12);
  assert.equal(runtime.audioGain({...env.clips[1],kind:'sound'},t),1,'detached sound fade must not be applied twice');
});

test('a manually transparent clip stays transparent throughout a transition',()=>{
  const spec=planTransitionPreset({doc,presetId:'transition/dissolve',from:'a',to:'b',duration:.6}).transition;
  const env=environment(spec),runtime=createTransitionRuntime(transitionFrame);
  env.clips[1].baseOpacity=0;env.clips[1].el.style.setProperty('opacity','0');
  for(const progress of [.1,.5,.9]){
    runtime.beforeFrame(env.clips);runtime.apply(env.clips,spec.start+(spec.end-spec.start)*progress,doc.stage,env.document);
    assert.equal(env.clips[1].el.style.getPropertyValue('opacity'),'0');
  }
  runtime.beforeFrame(env.clips);runtime.apply(env.clips,spec.end+1,doc.stage,env.document);
  assert.equal(env.clips[1].el.style.getPropertyValue('opacity'),'0');
});
