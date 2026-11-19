// @ts-nocheck -- Real registry/store tests with controlled media-job adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createCreationCaptions } from '../creation-captions.mjs';
import { createProjectRegistry } from '../projects.mjs';
import { createEventHub } from '../events.mjs';
import { createFilmDocIo } from '../film-io.mjs';
import { readSubtitles, saveSubtitles } from '../subtitle-store.mjs';
import { startStudio } from '../studio-server.mjs';

const HTML = `<!doctype html><html><head><meta name="viewport" content="width=1280,height=720"></head><body><section><video id="v" src="assets/main.mp4#t=2,8" at="4" speed="2"></video></section><section><audio id="a" src="assets/voice.wav#t=5,9" at="10" speed="2"></audio></section></body></html>`;
const io = { async snapshot(){return{ok:true,commit:'caption-history-test'};} };
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'opencut-captions-'));
  await fs.mkdir(path.join(dir,'assets'));await fs.writeFile(path.join(dir,'film.html'),HTML);
  await fs.writeFile(path.join(dir,'assets/main.mp4'),'test placeholder, no process reads media');await fs.writeFile(path.join(dir,'assets/voice.wav'),'test audio placeholder');
  const registry=createProjectRegistry({hub:createEventHub(),io:createFilmDocIo(),history:false,watchImpl:()=>({close(){}})});
  const opened=await registry.open(dir);assert.equal(opened.ok,true);
  const project=registry.get(opened.project.projectId),pending=[],jobs=[];
  const mediaServices={async start(input){const job={id:`job-${jobs.length}`,projectId:project.projectId,state:'queued'};jobs.push(job);pending.push(input);return{ok:true,job};},list(){return jobs;}};
  const service=createCreationCaptions({registry,mediaServices,io});
  const state=()=>registry.docOf(project.projectId);
  const act=(action,params={},extra={})=>service.action({action,params,opId:`op-${Math.random().toString(16).slice(2)}`,expectedHash:state().hash,...extra},{project,doc:state().doc,hash:state().hash});
  t.after(async()=>{await registry.closeAll();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,project,registry,service,mediaServices,pending,state,act};
}
const SRT='1\n00:00:02,000 --> 00:00:03,000\n第一句\n';

test('import/add/update/remove/export reuse companion format and source clock; film stays byte-identical',async t=>{
  const f=await fixture(t);
  assert.equal((await f.act('caption.import',{content:SRT,fileName:'source.srt'})).ok,true);
  let read=await readSubtitles({project:f.project,src:'assets/main.mp4'});assert.equal(read.format,'srt');assert.equal(read.file,'assets/main.srt');
  const snap=await f.service.snapshot({project:f.project,doc:f.state().doc});assert.equal(snap.captions.timelineCues[0].start,4);assert.equal(snap.captions.mapping.speed,2);assert.equal(snap.audio.sources.length,2);
  const added=await f.act('caption.add',{start:5,end:5.5,text:'映射到源',timeBase:'timeline'},{target:{clipId:'v'},expectedSubtitleHash:read.hash});assert.equal(added.ok,true,JSON.stringify(added));
  read=await readSubtitles({project:f.project,src:'assets/main.mp4'});assert.deepEqual(read.cues[1],{start:4,end:5,text:'映射到源'});
  assert.equal((await f.act('caption.update',{index:1,text:'只改字',timeBase:'timeline'},{target:{clipId:'v'}})).ok,true);
  read=await readSubtitles({project:f.project,src:'assets/main.mp4'});assert.deepEqual(read.cues[1],{start:4,end:5,text:'只改字'});
  assert.equal((await f.act('caption.remove',{index:0})).ok,true);
  const exported=await f.act('caption.export',{format:'vtt'});assert.equal(exported.ok,true);assert.equal(exported.roundTrip.byteIdentical,true);assert.match(exported.text,/只改字/);
  assert.equal(await fs.readFile(path.join(f.dir,'film.html'),'utf8'),HTML);
});

test('durable receipts prevent duplicate add, reject a changed payload, and stale film/sidecar hashes do not write',async t=>{
  const f=await fixture(t),request={action:'caption.add',params:{start:2,end:3,text:'一条'},opId:'stable-caption',expectedHash:f.state().hash};
  const first=await f.service.action(request,{project:f.project});assert.equal(first.ok,true);
  const newService=createCreationCaptions({registry:f.registry,mediaServices:f.mediaServices,io});
  const replay=await newService.action(request,{project:f.project});assert.equal(replay.replayed,true);
  assert.equal((await readSubtitles({project:f.project,src:'assets/main.mp4'})).cues.length,1);
  assert.equal((await f.service.action({...request,params:{...request.params,text:'不同'}},{project:f.project})).code,'OP_ID_REUSED');
  assert.equal((await f.act('caption.add',{start:4,end:5,text:'不写'},{expectedHash:'0'.repeat(64)})).code,'CONFLICT');
  assert.equal((await f.act('caption.add',{start:4,end:5,text:'不写'},{expectedSubtitleHash:'0'.repeat(64)})).code,'SUBTITLE_CONFLICT');
  assert.equal((await f.act('caption.add',{start:4,end:5,text:'不写'},{expectedSubtitleHash:null})).code,'SUBTITLE_CONFLICT');
  assert.equal((await readSubtitles({project:f.project,src:'assets/main.mp4'})).cues.length,1);
});

test('selected audio recognition adds source offset and exposes the correct timeline mapping',async t=>{
  const f=await fixture(t);
  const started=await f.act('caption.recognize',{}, {target:{clipId:'a'}});assert.equal(started.ok,true);
  const input=f.pending[0];assert.equal(input.request.src,'assets/voice.wav');assert.equal(input.request.params.sourceStart,5);assert.equal(input.request.params.sourceEnd,9);
  const completed=await input.complete({cues:[{start:0,end:2,text:'音轨识别'}],timeBase:'clip',sourceStart:5},new AbortController().signal);
  assert.equal(completed.ok,true,JSON.stringify(completed));
  const read=await f.act('caption.read',{}, {target:{clipId:'a'}});
  assert.deepEqual(read.captions.cues,[{start:5,end:7,text:'音轨识别'}]);
  assert.deepEqual(read.captions.timelineCues.map(c=>[c.start,c.end]),[[10,11]]);
});

test('resource audioIds and selectedClipIds follow the UI contract without bypassing source validation',async t=>{
  const f=await fixture(t);
  const started=await f.act('caption.recognize',{audioIds:['project:assets/voice.wav']});assert.equal(started.ok,true);
  assert.equal(f.pending[0].request.src,'assets/voice.wav');
  assert.equal((await f.act('caption.recognize',{audioIds:['project:assets/main.mp4','project:assets/voice.wav']})).code,'MULTI_SOURCE_UNSUPPORTED');
  assert.equal((await f.act('caption.recognize',{audioIds:['project:../outside.wav']})).code,'PATH_ESCAPE');
  assert.equal((await f.act('caption.recognize',{audioIds:['voice:external']})).code,'CAPTION_SOURCE_INVALID');
  const added=await f.act('caption.add',{start:4.5,end:5,text:'时间线输入',timeBase:'timeline'},{target:{selectedClipIds:['v']}});assert.equal(added.ok,true);
  let read=await readSubtitles({project:f.project,src:'assets/main.mp4'});assert.deepEqual(read.cues,[{start:3,end:4,text:'时间线输入'}]);
  const edited=await f.act('caption.update',{index:0,start:5,end:5.5,text:'移动时间',timeBase:'timeline'},{target:{selectedClipIds:['v']}});assert.equal(edited.ok,true);
  read=await readSubtitles({project:f.project,src:'assets/main.mp4'});assert.deepEqual(read.cues,[{start:4,end:5,text:'移动时间'}]);
});

test('late recognition cannot replace a subtitle or film edited while the job was running',async t=>{
  const f=await fixture(t);
  await f.act('caption.import',{content:SRT,fileName:'source.srt'});
  await f.act('caption.recognize',{}, {target:{clipId:'v'}});
  await saveSubtitles({project:f.project,src:'assets/main.mp4',cues:[{start:2,end:3,text:'人工修改'}],io});
  const completed=await f.pending[0].complete({cues:[{start:0,end:1,text:'旧识别结果'}],timeBase:'clip',sourceStart:2},new AbortController().signal);
  assert.equal(completed.code,'SUBTITLE_CONFLICT');assert.equal((await readSubtitles({project:f.project,src:'assets/main.mp4'})).cues[0].text,'人工修改');
  await f.act('caption.recognize',{}, {target:{clipId:'v'}});
  const before=f.state();await f.registry.applyOps(f.project.projectId,{expectedHash:before.hash,opId:'manual-film',by:'person'},[{op:'props',edits:[{clip:'v',prop:'at',value:6}]}]);
  const stale=await f.pending[1].complete({cues:[{start:0,end:1,text:'不写'}],timeBase:'clip',sourceStart:2},new AbortController().signal);
  assert.equal(stale.code,'CONFLICT');
});

test('translation takes cues from the actual source, writes a separate file by default and retains original on invalid result',async t=>{
  const f=await fixture(t);await f.act('caption.import',{content:SRT,fileName:'source.srt'});
  await f.act('caption.translate',{language:'English',cues:[{start:0,end:1,text:'伪造输入'}]});
  assert.deepEqual(f.pending[0].request.params.cues,[{start:2,end:3,text:'第一句'}]);
  const result=await f.pending[0].complete({cues:[{start:2,end:3,text:'First line'}]},new AbortController().signal);
  assert.equal(result.ok,true,JSON.stringify(result));assert.match(result.file,/translated-English\.srt$/);assert.equal(result.src,result.file);
  assert.equal((await readSubtitles({project:f.project,src:'assets/main.mp4'})).cues[0].text,'第一句');
  const separate=await f.act('caption.read',{}, {src:result.src,target:{clipId:'v'}});assert.equal(separate.captions.cues[0].text,'First line');assert.equal(separate.captions.timelineCues[0].start,4);
  await f.act('caption.translate',{language:'English',replace:true});
  const invalid=await f.pending[1].complete({cues:[{start:0,end:1,text:'wrong timing'}]},new AbortController().signal);
  assert.equal(invalid.code,'TRANSLATION_INVALID');assert.equal((await readSubtitles({project:f.project,src:'assets/main.mp4'})).cues[0].text,'第一句');
});

test('explicit translation replacement keeps an original backup; cancellation and multi-source inputs never write',async t=>{
  const f=await fixture(t);await f.act('caption.import',{content:SRT,fileName:'source.srt'});
  const original=await fs.readFile(path.join(f.dir,'assets/main.srt'),'utf8');
  await f.act('caption.translate',{language:'en',replace:true});
  assert.equal((await f.pending[0].complete({cues:[{start:2,end:3,text:'First line'}]},new AbortController().signal)).ok,true);
  const backup=path.join(f.dir,'.film/caption-originals',createHash('sha256').update(original).digest('hex')+'.srt');assert.equal(await fs.readFile(backup,'utf8'),original);
  assert.equal((await f.act('caption.recognize',{}, {selectedClipIds:['v','a']})).code,'MULTI_SOURCE_UNSUPPORTED');
  await f.act('caption.recognize',{}, {target:{clipId:'v'}});
  const controller=new AbortController();controller.abort();
  const cancelled=await f.pending[1].complete({cues:[{start:0,end:1,text:'不可写'}],timeBase:'clip',sourceStart:2},controller.signal);
  assert.equal(cancelled.ok,false);assert.equal(cancelled.code,'CANCELLED');assert.equal((await readSubtitles({project:f.project,src:'assets/main.mp4'})).cues[0].text,'First line');
});

test('recognizing a selected source window preserves older cue portions outside that window',async t=>{
  const f=await fixture(t);
  await saveSubtitles({project:f.project,src:'assets/main.mp4',cues:[{start:0,end:10,text:'原来长句'},{start:11,end:12,text:'原来末句'}],io});
  await f.act('caption.recognize',{}, {target:{clipId:'v'}});
  const completed=await f.pending[0].complete({cues:[{start:0,end:2,text:'窗口新句'}],timeBase:'clip',sourceStart:2},new AbortController().signal);
  assert.equal(completed.ok,true);
  assert.deepEqual((await readSubtitles({project:f.project,src:'assets/main.mp4'})).cues,[{start:0,end:2,text:'原来长句'},{start:2,end:4,text:'窗口新句'},{start:8,end:10,text:'原来长句'},{start:11,end:12,text:'原来末句'}]);
});

test('symlink companion captions and path escapes are refused',async t=>{
  const f=await fixture(t),outside=path.join(f.dir,'outside.srt');await fs.writeFile(outside,SRT);await fs.symlink(outside,path.join(f.dir,'assets/main.srt'));
  assert.equal((await f.act('caption.add',{start:2,end:3,text:'no'})).code,'PATH_ESCAPE');
  assert.equal((await f.act('caption.read',{}, {src:'../outside.srt'})).code,'PATH_ESCAPE');
  assert.equal(await fs.readFile(outside,'utf8'),SRT);
});

test('two HTTP-style factories share the real project transaction gate across person/agent identities and aliases',async t=>{
  const f=await fixture(t);await f.act('caption.import',{content:SRT,fileName:'source.srt'},{src:'assets/voice.wav'});
  const initial=await readSubtitles({project:f.project,src:'assets/voice.wav'}),file=path.join(f.dir,initial.file);
  const original=await fs.readFile(file,'utf8'),rename=fs.rename;
  let releaseFirst,firstRename,secondRename,firstVerified;
  const blocked=new Promise(resolve=>{releaseFirst=resolve;});
  const reached=new Promise(resolve=>{firstRename=resolve;});
  const secondReached=new Promise(resolve=>{secondRename=resolve;});
  const verified=new Promise(resolve=>{firstVerified=resolve;});
  let arrivals=0;
  fs.rename=async(source,target)=>{
    if(target===file){
      arrivals++;
      if(arrivals===1){firstRename();await blocked;}
      else {secondRename();await verified;}
    }
    return rename(source,target);
  };
  const person=createCreationCaptions({registry:f.registry,by:'person',io:{async snapshot(){firstVerified();return{ok:true};}}});
  // The same real directory can appear under another project/sequence alias.
  const alias={...f.project,projectId:'alias-same-source',dir:path.join(f.dir,'.')};
  const agent=createCreationCaptions({registry:{docOf:()=>f.state()},by:'agent',io});
  const request={action:'caption.update',src:'assets/voice.wav',expectedHash:f.state().hash,expectedSubtitleHash:initial.hash,params:{index:0,text:'writer-one'},opId:'concurrent-one'};
  try {
    const first=person.action(request,{project:f.project});await reached;
    const second=agent.action({...request,params:{index:0,text:'writer-two'},opId:'concurrent-two'},{project:alias});
    // A broken per-factory lock lets the second writer reach rename with the
    // same old hash. The repaired lock keeps it outside the transaction.
    await Promise.race([secondReached,new Promise(resolve=>setTimeout(resolve,100))]);
    releaseFirst();
    const results=await Promise.all([first,second]);
    assert.equal(results.filter(r=>r.ok).length,1,JSON.stringify(results));
    assert.equal(results.find(r=>!r.ok)?.code,'SUBTITLE_CONFLICT');
    assert.equal(arrivals,1,'the losing transaction never renames a subtitle');
    assert.equal((await readSubtitles({project:f.project,src:'assets/voice.wav'})).cues[0].text,'writer-one');
    const receipts=JSON.parse(await fs.readFile(path.join(f.dir,'.film/creation-caption-receipts.json'),'utf8'));
    assert.equal(receipts.entries['concurrent-one'].state,'done');
    assert.equal(await fs.readFile(path.join(f.dir,'film.html'),'utf8'),HTML);
    assert.match(original,/第一句/,'the starting source evidence remains available to the assertion');
    t.diagnostic(`winner=concurrent-one; loser=SUBTITLE_CONFLICT; sourceBefore=${initial.hash}; sourceAfter=${results[0].hash}; renameCount=${arrivals}`);
  } finally {releaseFirst();firstVerified();fs.rename=rename;}
});

test('a background ASR completion cannot overtake a concurrent manual write from another factory',async t=>{
  const f=await fixture(t);await f.act('caption.import',{content:SRT,fileName:'source.srt'});
  await f.act('caption.recognize',{}, {target:{clipId:'v'}});
  const before=await readSubtitles({project:f.project,src:'assets/main.mp4'});
  let unblock,entered;
  const barrier=new Promise(resolve=>{unblock=resolve;}),inside=new Promise(resolve=>{entered=resolve;});
  const manual=createCreationCaptions({registry:f.registry,by:'person',io:{async snapshot(){entered();await barrier;return{ok:true};}}});
  const request={action:'caption.update',src:'assets/main.mp4',params:{index:0,text:'并发人工稿'},expectedHash:f.state().hash,expectedSubtitleHash:before.hash,opId:'manual-during-asr'};
  const write=manual.action(request,{project:f.project});await inside;
  const completed=f.pending[0].complete({cues:[{start:0,end:1,text:'过期识别稿'}],timeBase:'clip',sourceStart:2},new AbortController().signal);
  unblock();
  const [written,stale]=await Promise.all([write,completed]);
  assert.equal(written.ok,true);assert.equal(stale.code,'SUBTITLE_CONFLICT');
  assert.equal((await readSubtitles({project:f.project,src:'assets/main.mp4'})).cues[0].text,'并发人工稿');
  const receipts=JSON.parse(await fs.readFile(path.join(f.dir,'.film/creation-caption-receipts.json'),'utf8'));
  assert.equal(receipts.entries['manual-during-asr'].state,'done');
  assert.ok(Object.values(receipts.entries).some(r=>r.result?.code==='SUBTITLE_CONFLICT'),'the rejected ASR receipt is retained alongside the manual receipt');
});

test('concurrent factories writing different sources retain both project-wide receipt entries',async t=>{
  const f=await fixture(t);
  const second=createCreationCaptions({registry:f.registry,mediaServices:f.mediaServices,by:'agent',io});
  const request=(src,opId)=>({action:'caption.add',src,opId,expectedHash:f.state().hash,expectedSubtitleHash:null,params:{start:2,end:3,text:opId}});
  const results=await Promise.all([f.service.action(request('assets/main.mp4','source-main'),{project:f.project}),second.action(request('assets/voice.wav','source-voice'),{project:f.project})]);
  assert.ok(results.every(r=>r.ok),JSON.stringify(results));
  const receipts=JSON.parse(await fs.readFile(path.join(f.dir,'.film/creation-caption-receipts.json'),'utf8'));
  assert.equal(receipts.entries['source-main'].state,'done');assert.equal(receipts.entries['source-voice'].state,'done');
  assert.equal((await readSubtitles({project:f.project,src:'assets/main.mp4'})).cues[0].text,'source-main');
  assert.equal((await readSubtitles({project:f.project,src:'assets/voice.wav'})).cues[0].text,'source-voice');
});

test('legacy subtitle PUT and save-import HTTP routes share the new ASR lock and reject changes while waiting',async t=>{
  const f=await fixture(t);
  const home=path.join(f.dir,'test-home');await fs.mkdir(home,{recursive:true});
  const studio=await startStudio({port:0,vitePort:59379,home,history:false,watchImpl:()=>({close(){}}),logger:()=>{}});
  try {
    const opened=await studio.registry.open(f.dir);assert.equal(opened.ok,true);
    const project=studio.registry.get(opened.project.projectId),pending=[];
    const service=createCreationCaptions({registry:studio.registry,io,mediaServices:{async start(input){pending.push(input);return{ok:true,job:{id:'legacy-lock-job',state:'queued'}};}}});
    const src='assets/main.mp4',file=path.join(project.dir,'assets/main.srt'),prefix=`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}`;
    for(const method of ['legacy-put','legacy-import']){
      await saveSubtitles({project,src,cues:[{start:2,end:3,text:'原始字幕'}],format:'srt',io});
      const compatible=method==='legacy-put'
        ?await fetch(prefix+'/subtitles',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({src,cues:[{start:2,end:3,text:'原始字幕'}]})})
        :await fetch(prefix+'/subtitles/import?save=1&src='+encodeURIComponent(src)+'&name=legacy.srt',{method:'POST',headers:{'content-type':'application/octet-stream'},body:SRT.replace('第一句','原始字幕')});
      assert.equal(compatible.status,200,JSON.stringify(await compatible.json()));
      const before=await readSubtitles({project,src}),hash=studio.registry.docOf(project.projectId).hash;
      assert.equal((await service.action({action:'caption.recognize',target:{clipId:'v'},expectedHash:hash,expectedSubtitleHash:before.hash,opId:`asr-${method}`},{project})).ok,true);
      const rename=fs.rename,read=fs.readFile;
      let release,arrived,captured;
      const blocked=new Promise(resolve=>{release=resolve;}),atRename=new Promise(resolve=>{arrived=resolve;}),baselineRead=new Promise(resolve=>{captured=resolve;});
      let captureLegacy=false,renames=0;
      fs.rename=async(source,target)=>{if(target===file){renames++;if(renames===1){arrived();await blocked;}}return rename(source,target);};
      fs.readFile=async(...args)=>{const result=await read(...args);if(captureLegacy&&String(args[0])===file)captured();return result;};
      try {
        const complete=pending.shift().complete({cues:[{start:0,end:1,text:`识别结果-${method}`}],timeBase:'clip',sourceStart:2},new AbortController().signal);
        await atRename;captureLegacy=true;
        const request=method==='legacy-put'
          ?fetch(prefix+'/subtitles',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({src,cues:[{start:2,end:3,text:'过期人工稿'}]})})
          :fetch(prefix+'/subtitles/import?save=1&src='+encodeURIComponent(src)+'&name=legacy.srt',{method:'POST',headers:{'content-type':'application/octet-stream'},body:SRT.replace('第一句','过期导入稿')});
        let timer;
        try { await Promise.race([baselineRead,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('legacy route did not capture its ingress baseline')),3000);})]); }
        finally {clearTimeout(timer);}
        captureLegacy=false;release();
        const done=await complete;assert.equal(done.ok,true,JSON.stringify(done));
        const response=await request,body=await response.json();
        assert.equal(response.status,409,JSON.stringify(body));
        assert.equal((body.saved??body).code,'SUBTITLE_CONFLICT');
        assert.equal(renames,1,'the waiting legacy writer must not rename over the ASR result');
        assert.equal((await readSubtitles({project,src})).cues[0].text,`识别结果-${method}`);
        const stale=await fetch(prefix+'/subtitles',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({src,cues:[{start:2,end:3,text:'旧hash稿'}],expectedHash:hash,expectedSubtitleHash:before.hash})});
        assert.equal(stale.status,409);assert.equal((await stale.json()).code,'SUBTITLE_CONFLICT');
      }finally{release();fs.rename=rename;fs.readFile=read;}
    }
  }finally{await studio.close();}
});
