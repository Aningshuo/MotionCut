// @ts-nocheck -- Runtime FilmDoc/render-plan boundary and actual source fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { creationClipStyle, requiresCreationStyleStage } from '../creation-style-stage.mjs';
import { parse } from '../film-doc.mjs';
import { planFromFilm } from '../../render/film-plan.mjs';
import { assertRenderable } from '../../render/film-export.mjs';

test('clip CSS requiring the browser is found in source documents and serialized plans',()=>{
  for(const style of ['filter: grayscale(1)','backdrop-filter: blur(5px)','border-radius: 14px','opacity: .4','transform: rotate(5deg)']){
    const clip={id:'v',kind:'video',style};
    assert.equal(requiresCreationStyleStage({tracks:[{clips:[clip]}]}),true,style);
    assert.equal(requiresCreationStyleStage({visualClips:[clip]}),true,style);
    assert.equal(creationClipStyle({attrs:{style}}),style);
  }
  assert.equal(requiresCreationStyleStage({tracks:[{clips:[{kind:'video',style:'  '}]}]}),false);
  assert.equal(requiresCreationStyleStage({tracks:[{hidden:true,clips:[{kind:'video',style:'filter:blur(3px)'}]}]}),false);
  assert.equal(requiresCreationStyleStage({tracks:[{clips:[{kind:'sound',style:'filter:blur(3px)'}]}]}),false);
});

test('pure video inline filter survives the real planner and forces stage without inserting a fake page',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'opencut-style-stage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'assets'));
  await fs.copyFile(new URL('../../../tests/fixtures/media/bars-3s-720p30.mp4',import.meta.url),path.join(dir,'assets','video.mp4'));
  const source='<!doctype html><html><head><meta name="viewport" content="width=640,height=360"></head><body><section><video id="v" src="assets/video.mp4#t=0,1" muted style="filter: grayscale(1)"></video></section></body></html>';
  const parsed=parse(source);assert.ok(parsed.doc);
  const plan=await planFromFilm(parsed.doc,{projectRoot:dir,fps:30});
  assert.equal(plan.sceneClips.length,0);assert.equal(plan.visualClips.length,1);
  assert.equal(plan.visualClips[0].style,'filter: grayscale(1)');
  assert.equal(plan.requiresStage,true);assert.equal(requiresCreationStyleStage(JSON.parse(JSON.stringify(plan))),true);
  assert.throws(()=>assertRenderable(plan),error=>error.code==='UNSUPPORTED');
  assert.doesNotThrow(()=>assertRenderable(plan,{allowScenes:true}));
});

test('a hand-built media plan cannot evade the CSS guard by dropping requiresStage',()=>{
  const plan={visualClips:[{id:'v',kind:'video',src:'a.mp4',at:0,time:[0,1],style:'filter:sepia(.5)'}],sceneClips:[]};
  assert.throws(()=>assertRenderable(plan),error=>error.code==='UNSUPPORTED');
  assert.doesNotThrow(()=>assertRenderable({...plan,visualClips:[{...plan.visualClips[0],style:''}]}));
});
