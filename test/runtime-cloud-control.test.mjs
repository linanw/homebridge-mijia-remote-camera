import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {RuntimeManager} from '../lib/runtime.mjs';

const selection={homeId:'202',homeOwner:'22',deviceId:'803',model:'chuangmi.camera.061a01',region:'cn'};
const tick=()=>new Promise(setImmediate);
async function fixture(t,cloudControl,onSpawn){
 const directory=await mkdtemp(join(tmpdir(),'mijia-control-runtime-'));
 await mkdir(join(directory,'.micam'));await writeFile(join(directory,'.micam/credentials.json'),'{}');
 const calls=[];
 const runtime=new RuntimeManager({storagePath:directory,javaPath:'java',jarPath:'vendor',bridgePath:'own',cloudControl,
  spawn:(_command,args)=>{const child=new EventEmitter();child.stdout=new PassThrough();calls.push({child,args});process.nextTick(()=>onSpawn?.(child,args));return child;},
  terminateProcess:async child=>child?.emit('close',0)});
 t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
 await runtime.select(selection);return{runtime,calls};
}
const reply=(child,value,code=0)=>{child.stdout.end(JSON.stringify(value));child.emit('close',code);};
const nightAction=args=>args[args.indexOf('mijia.bridge.NightVisionControl')+1];

test('night properties use direct cloud client and selected context without spawning a JVM',async t=>{
 const requests=[];const cloud={getNightVision:async(...args)=>{requests.push(args);return{mode:'auto',raw:'PRIVATE_TOKEN'};},
  setNightVision:async(...args)=>{requests.push(args);return{mode:args[2],raw:'PRIVATE_VALUE'};}};
 const {runtime,calls}=await fixture(t,cloud);
 assert.deepEqual(await runtime.getNightVision(),{mode:'auto'});
 assert.deepEqual(await runtime.setNightVision('off'),{mode:'off'});
 assert.equal(calls.length,0);assert.equal(requests[0][0].deviceId,selection.deviceId);assert.equal(requests[0][1],'cn');
 assert.ok(requests[0][2].signal instanceof AbortSignal);
 await runtime.pause();await assert.rejects(runtime.getNightVision(),{reason:'auth_in_progress'});
 assert.equal(requests.length,2);
});

test('changing selection aborts in-flight direct property requests and discards old results',async t=>{
 let entered,aborted=false;
 const started=new Promise(resolve=>entered=resolve);
 const cloud={getNightVision:async(_selection,_region,{signal})=>new Promise((resolve,reject)=>{
  signal.addEventListener('abort',()=>{aborted=true;reject(Object.assign(Error('cancelled'),{reason:'query_cancelled'}));},{once:true});entered();
 })};
 const {runtime}=await fixture(t,cloud);
 const request=runtime.getNightVision().catch(error=>error.reason);await started;
 await runtime.select({...selection,deviceId:'804'});
 assert.equal(await request,'query_cancelled');assert.equal(aborted,true);
});

test('expired direct control session schedules one bounded Java renewal behind the failed operation',async t=>{
 const cloud={getNightVision:async()=>{throw Object.assign(Error('expired'),{reason:'session_expired'});}};
 const {runtime,calls}=await fixture(t,cloud);
 await assert.rejects(runtime.getNightVision(),{reason:'session_expired'});await tick();await tick();
 assert.equal(calls.length,1);assert.equal(calls[0].args.at(-2),'homes');
 calls[0].child.stdout.end('{"success":true,"homes":[]}');calls[0].child.emit('close',0);await tick();
 assert.equal(runtime.controlRenewal,null);
});

test('expired authoritative capability schedules one read-only revalidation and closes persistent client on shutdown',async t=>{
 let closes=0;
 const cloud={getNightVision:async()=>{throw Object.assign(Error('missing'),{reason:'night_vision_unavailable',capabilityRequired:true});},close:()=>{closes++;}};
 const {runtime,calls}=await fixture(t,cloud);runtime.ready=true;
 await assert.rejects(runtime.getNightVision(),{reason:'night_vision_unavailable'});await tick();await tick();
 assert.equal(calls.length,1);assert.equal(calls[0].args[calls[0].args.indexOf('mijia.bridge.NightVisionControl')+1],'get');
 calls[0].child.stdout.end('{"success":true,"mode":"on"}');calls[0].child.emit('close',0);await tick();
 assert.equal(runtime.controlVerification,null);await runtime.close();assert.equal(closes,1);
});

test('mode switches reject unsupported modes and nonboolean values before any query',async t=>{
 let requests=0;
 const {runtime,calls}=await fixture(t,{getNightVision:async()=>{requests++;return{mode:'auto'};}});
 for(const [mode,enabled] of [['off',false],['toggle',true],['ON',true],['on',1],['auto','false'],['on',undefined]])
  await assert.rejects(runtime.setNightVisionSwitch(mode,enabled),{reason:'invalid_request'});
 assert.equal(requests,0);assert.equal(calls.length,0);
});

test('direct mode switches freshly read all three modes and only change their own active mode',async t=>{
 let actual='off';const requests=[],events=[];
 const cloud={
  getNightVision:async(current,region,{signal})=>{requests.push({action:'get',current,region,signal});return{mode:actual,raw:'PRIVATE_TOKEN'};},
  setNightVision:async(current,region,mode,{signal})=>{requests.push({action:'set',mode,current,region,signal});actual=mode;return{mode,raw:'PRIVATE_TOKEN'};},
 };
 const {runtime,calls}=await fixture(t,cloud);runtime.on('night-mode',value=>events.push(value));
 for(const mode of ['on','auto']) for(const enabled of [true,false]) for(const before of ['off','on','auto']){
  actual=before;requests.length=0;
  const expected=enabled?mode:before===mode?'off':before;
  assert.deepEqual(await runtime.setNightVisionSwitch(mode,enabled),{mode:expected});
  assert.equal(actual,expected);assert.deepEqual(events.at(-1),{mode:expected});
  assert.deepEqual(requests.map(value=>value.action),expected===before?['get']:['get','set']);
  assert.ok(requests.every(value=>value.current.deviceId===selection.deviceId&&value.region==='cn'));
  assert.ok(requests[0].signal instanceof AbortSignal);
  if(requests.length===2) assert.equal(requests[0].signal,requests[1].signal);
 }
 assert.equal(events.length,12);assert.equal(calls.length,0);
});

test('Java fallback mode switches preserve selected scope and conditional no-write behavior',async t=>{
 let actual='off';
 const {runtime,calls}=await fixture(t,undefined,(child,args)=>{
  if(nightAction(args)==='set') actual=args.at(-1);
  reply(child,{success:true,mode:actual,raw:'PRIVATE_TOKEN'});
 });
 for(const mode of ['on','auto']) for(const enabled of [true,false]) for(const before of ['off','on','auto']){
  actual=before;calls.length=0;
  const expected=enabled?mode:before===mode?'off':before;
  assert.deepEqual(await runtime.setNightVisionSwitch(mode,enabled),{mode:expected});
  assert.deepEqual(calls.map(value=>nightAction(value.args)),expected===before?['get']:['get','set']);
  assert.deepEqual(calls[0].args.slice(-5),['get','cn','202','22','803']);
  if(calls.length===2) assert.deepEqual(calls[1].args.slice(-6),['set','cn','202','22','803',expected]);
 }
});

test('fresh read and conditional write stay atomic before queued UI and Matter mode requests',async t=>{
 let release,entered;
 const started=new Promise(resolve=>entered=resolve),requests=[];
 let actual='off',first=true;
 const cloud={getNightVision:async()=>{
  requests.push('get');
  if(first){first=false;entered();await new Promise(resolve=>release=resolve);}
  return{mode:actual};
 },setNightVision:async(_selection,_region,mode)=>{requests.push(`set:${mode}`);actual=mode;return{mode};}};
 const {runtime}=await fixture(t,cloud);
 const hap=runtime.setNightVisionSwitch('on',true);await started;
 const ui=runtime.setNightVision('auto'),matter=runtime.getNightVision();
 release();
 assert.deepEqual(await hap,{mode:'on'});assert.deepEqual(await ui,{mode:'auto'});assert.deepEqual(await matter,{mode:'auto'});
 assert.deepEqual(requests,['get','set:on','set:auto','get']);
});

test('Java fallback read and conditional write also occupy one shared queue task',async t=>{
 let actual='off',firstChild;
 const {runtime,calls}=await fixture(t,undefined,(child,args)=>{
  if(calls.length===1){firstChild=child;return;}
  if(nightAction(args)==='set') actual=args.at(-1);
  reply(child,{success:true,mode:actual});
 });
 const hap=runtime.setNightVisionSwitch('auto',true);
 for(let attempt=0;attempt<10&&!firstChild;attempt++) await tick();
 assert.ok(firstChild);
 const ui=runtime.setNightVision('on'),matter=runtime.getNightVision();
 reply(firstChild,{success:true,mode:'off'});
 assert.deepEqual(await hap,{mode:'auto'});assert.deepEqual(await ui,{mode:'on'});assert.deepEqual(await matter,{mode:'on'});
 assert.deepEqual(calls.map(value=>[nightAction(value.args),nightAction(value.args)==='set'?value.args.at(-1):'']),
  [['get',''],['set','auto'],['set','on'],['get','']]);
});

test('selection, region and lifecycle changes after the fresh read prevent the conditional write',async t=>{
 for(const change of ['selection','region','generation','pause','close']){
  let runtime,writes=0;
  const cloud={getNightVision:async()=>{
   if(change==='selection') await runtime.select({...selection,deviceId:'804'});
   else if(change==='region') runtime.region='sg';
   else if(change==='generation') runtime.generation++;
   else if(change==='pause') await runtime.pause();
   else await runtime.close();
   return{mode:'off'};
  },setNightVision:async()=>{writes++;return{mode:'on'};}};
  ({runtime}=await fixture(t,cloud));
  await assert.rejects(runtime.setNightVisionSwitch('on',true),{reason:change==='close'?'runtime_closed':change==='pause'?'auth_in_progress':'query_cancelled'});
  assert.equal(writes,0,change);
 }
});

test('a changed Java fallback selection is rejected before its second helper can spawn',async t=>{
 let runtime;const events=[];
 const {runtime:manager,calls}=await fixture(t,undefined,(child)=>{
  runtime.generation++;
  reply(child,{success:true,mode:'off'});
 });runtime=manager;runtime.on('night-mode',value=>events.push(value));
 await assert.rejects(runtime.setNightVisionSwitch('on',true),{reason:'query_cancelled'});
 assert.equal(calls.length,1);assert.deepEqual(events,[]);
});

test('timeout during an abort-ignoring fresh read cannot issue a delayed conditional write',async t=>{
 let release,signal,writes=0;
 const {runtime}=await fixture(t,{getNightVision:async(_selection,_region,options)=>{
  signal=options.signal;await new Promise(resolve=>release=resolve);return{mode:'off'};
 },setNightVision:async()=>{writes++;return{mode:'on'};}});
 const events=[];runtime.on('night-mode',value=>events.push(value));
 t.mock.timers.enable({apis:['Date','setTimeout']});
 try{
  const request=runtime.setNightVisionSwitch('on',true),rejected=assert.rejects(request,{reason:'query_timeout'});
  for(let attempt=0;attempt<10&&!release;attempt++) await Promise.resolve();
  assert.ok(release);t.mock.timers.tick(6501);await rejected;assert.equal(signal.aborted,true);
  release();await runtime.queryChain;assert.equal(writes,0);assert.deepEqual(events,[]);
 }finally{t.mock.timers.reset();}
});

test('conditional direct write shares the fresh read deadline rather than receiving a new budget',async t=>{
 let readSignal,writeSignal,releaseRead,releaseWrite;
 const {runtime}=await fixture(t,{getNightVision:async(_selection,_region,{signal})=>{
  readSignal=signal;await new Promise(resolve=>releaseRead=resolve);return{mode:'off'};
 },setNightVision:async(_selection,_region,_mode,{signal})=>{
  writeSignal=signal;await new Promise(resolve=>releaseWrite=resolve);return{mode:'auto'};
 }});
 t.mock.timers.enable({apis:['Date','setTimeout']});
 try{
  const request=runtime.setNightVisionSwitch('auto',true),rejected=assert.rejects(request,{reason:'query_timeout'});
  for(let attempt=0;attempt<10&&!releaseRead;attempt++) await Promise.resolve();
  assert.ok(releaseRead);t.mock.timers.tick(6400);releaseRead();
  for(let attempt=0;attempt<20&&!releaseWrite;attempt++) await Promise.resolve();
  assert.ok(releaseWrite);assert.equal(readSignal,writeSignal);
  t.mock.timers.tick(101);await rejected;assert.equal(writeSignal.aborted,true);
  releaseWrite();await runtime.queryChain;
 }finally{t.mock.timers.reset();}
});

test('timing out a Java fallback fresh read terminates it without spawning a conditional write',async t=>{
 const {runtime,calls}=await fixture(t);
 t.mock.timers.enable({apis:['Date','setTimeout']});
 try{
  const request=runtime.setNightVisionSwitch('on',true),rejected=assert.rejects(request,{reason:'query_timeout'});
  for(let attempt=0;attempt<20&&!calls.length;attempt++) await Promise.resolve();
  assert.equal(calls.length,1);t.mock.timers.tick(6501);await rejected;await runtime.queryChain;
  assert.equal(calls.length,1);assert.equal(runtime.helpers.size,0);
 }finally{t.mock.timers.reset();}
});

test('conditional writes reject mismatched readback and never emit an unconfirmed mode',async t=>{
 for(const direct of [true,false]){
  const cloud=direct?{getNightVision:async()=>({mode:'off'}),setNightVision:async()=>({mode:'off'})}:undefined;
  const {runtime,calls}=await fixture(t,cloud,(child)=>reply(child,{success:true,mode:'off'}));
  const events=[];runtime.on('night-mode',value=>events.push(value));
  await assert.rejects(runtime.setNightVisionSwitch('on',true),{reason:'night_vision_not_applied'});
  assert.deepEqual(events,[]);assert.equal(calls.length,direct?0:2);
 }
});

test('a failed or malformed initial observation never becomes a write or leaks backend text',async t=>{
 for(const failure of ['error','malformed']){
  let writes=0;
  const {runtime}=await fixture(t,{getNightVision:async()=>{
   if(failure==='error') throw Error('PRIVATE_TOKEN');
   return{mode:'PRIVATE_TOKEN'};
  },setNightVision:async()=>{writes++;return{mode:'on'};}});
  await assert.rejects(runtime.setNightVisionSwitch('on',true),error=>error.reason===(failure==='error'?'backend_failed':'invalid_backend_response')&&!String(error).includes('PRIVATE'));
  assert.equal(writes,0);
 }
});
