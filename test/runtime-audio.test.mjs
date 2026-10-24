import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeManager} from '../lib/runtime.mjs';

async function setup(t, config={}) {
  const directory=await mkdtemp(join(tmpdir(),'mijia-audio-runtime-'));
  await mkdir(join(directory,'.micam'));
  await writeFile(join(directory,'.micam/credentials.json'),'{}');
  let child, argv;
  const runtime=new RuntimeManager({storagePath:directory,javaPath:'java',jarPath:'vendor',bridgePath:'own',
    choosePort:async()=>32188, ...config,
    spawn:(_,args)=>{
      argv=args;child=new EventEmitter();child.stdout=new PassThrough();child.json=value=>child.stdout.write(JSON.stringify(value)+'\n');
      process.nextTick(()=>child.json({success:true,event:'ready',port:32188,videoReceived:true,codec:'H264'}));return child;
    },terminateProcess:async item=>item?.emit('close',0)});
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  await runtime.select({deviceId:'803',homeId:'202',homeOwner:'22',model:'chuangmi.camera.061a01'});
  await runtime.start();
  return {runtime,child,argv};
}
const ready={success:true,event:'audio_ready',audioPort:32189,audioCodec:'OPUS',sampleRate:48000,channels:2,
  talkFormat:'ogg',talkSampleRate:48000,talkChannels:2,talkPath:'/talk.ogg'};

test('audio is exposed only after actual supported receipt and descriptors use owned loopback paths',async t=>{
  const {runtime,child}=await setup(t);
  assert.equal(runtime.audioSource(),undefined);
  child.json({...ready,audioPort:80,url:'https://PRIVATE_HOST'});
  assert.equal(runtime.audioSource(),undefined);
  child.json({...ready,audioCodec:'PRIVATE_CODEC'});
  assert.equal(runtime.audioSource(),undefined);
  child.json({...ready,url:'https://PRIVATE_HOST',talkUrl:'https://PRIVATE_HOST',passToken:'PRIVATE_TOKEN'});
  assert.deepEqual(runtime.audioSource(),{url:'http://127.0.0.1:32189/audio.ogg',format:'ogg',codec:'OPUS',sampleRate:48000,channels:2,
    talkUrl:'http://127.0.0.1:32189/talk.ogg',talkFormat:'ogg',talkSampleRate:48000,talkChannels:2});
  assert.equal(runtime.talkSource().url,'http://127.0.0.1:32189/talk.ogg');
  assert.equal(runtime.status().audio.received,true);
  assert.doesNotMatch(JSON.stringify(runtime.status().audio),/PRIVATE|url|Url/);
  child.json({success:true,event:'audio_status',audioReceived:false});
  assert.equal(runtime.audioSource(),undefined);
  assert.equal(runtime.status().ready,true);
  child.json({success:true,event:'audio_status',audioReceived:true});
  assert.equal(runtime.audioSource().codec,'OPUS');
  await runtime.stop();
  assert.equal(runtime.audioSource(),undefined);
  assert.equal(runtime.talkSource(),undefined);
});

test('stale audio, mismatched talkback formats and disabled configuration fail closed without stopping video',async t=>{
  const {runtime,child}=await setup(t);
  child.json({...ready,talkPath:'/PRIVATE_TALK'});
  assert.equal(runtime.audioSource().codec,'OPUS');
  assert.equal(runtime.talkSource(),undefined);
  runtime.audioSeenAt=Date.now()-21000;
  assert.equal(runtime.audioSource(),undefined);
  assert.equal(runtime.ready,true);
  const disabled=await setup(t,{enableAudio:false,enableTalkback:true});
  assert.equal(disabled.argv.at(-1),'0');
  disabled.child.json(ready);
  assert.equal(disabled.runtime.audioSource(),undefined);
  assert.equal(disabled.runtime.status().audio.talkbackEnabled,false);
  assert.equal(disabled.runtime.ready,true);
});
