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
async function fixture(t,cloudControl){
 const directory=await mkdtemp(join(tmpdir(),'mijia-control-runtime-'));
 await mkdir(join(directory,'.micam'));await writeFile(join(directory,'.micam/credentials.json'),'{}');
 const calls=[];
 const runtime=new RuntimeManager({storagePath:directory,javaPath:'java',jarPath:'vendor',bridgePath:'own',cloudControl,
  spawn:(_command,args)=>{const child=new EventEmitter();child.stdout=new PassThrough();calls.push({child,args});return child;},
  terminateProcess:async child=>child?.emit('close',0)});
 t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
 await runtime.select(selection);return{runtime,calls};
}

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
