import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { MijiaCameraDelegate } from '../lib/camera.mjs';
const require = createRequire(import.meta.url);
const hostRequire = createRequire(require.resolve('homebridge'));
let hap;
if (process.env.MIJIA_CAMERA_HAP_MODULE) hap = hostRequire(process.env.MIJIA_CAMERA_HAP_MODULE);
else { try { hap = hostRequire('@homebridge/hap-nodejs'); } catch { hap = hostRequire('hap-nodejs'); } }
const log={info(){},warn(){},error(){}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const invoke=fn=>new Promise((resolve,reject)=>fn((failure,value)=>failure?reject(failure):resolve(value)));
async function eventually(check){for(let n=0;n<200;n++){if(check())return;await delay(5);}assert.fail('Audio condition did not settle');}
class FakeFFmpeg extends EventEmitter {
 constructor(){super();this.stdin=new PassThrough();this.stdout=new PassThrough();this.stderr=new PassThrough();this.exitCode=null;this.signalCode=null;}
 kill(signal){if(this.exitCode!==null||this.signalCode!==null)return true;this.signalCode=signal;queueMicrotask(()=>this.emit('close',null,signal));return true;}
}
const prepare=()=>({sessionID:randomUUID(),targetAddress:'127.0.0.1',addressVersion:'ipv4',video:{port:5000,srtpCryptoSuite:0,srtp_key:randomBytes(16),srtp_salt:randomBytes(14)},audio:{port:5100,srtpCryptoSuite:0,srtp_key:randomBytes(16),srtp_salt:randomBytes(14)}});
const start=input=>({type:'start',sessionID:input.sessionID,audio:{codec:'AAC-eld',sample_rate:16,channel:1,pt:110,max_bit_rate:24}});
function fixture({source,talkSource,config={}}={}){
 const children=[],args=[];
 const runtime={ensureReady:async()=> 'http://127.0.0.1:23456/cam.ts',audioSource:()=>source,...(talkSource?{talkSource}:{})};
 const delegate=new MijiaCameraDelegate({api:{hap},runtime,config,log,spawnProcess:(_,value)=>{const p=new FakeFFmpeg();children.push(p);args.push(value);return p;}});
 return {delegate,children,args,runtime};
}
async function active(f,input){await invoke(cb=>f.delegate.prepareStream(input,cb));const waiting=invoke(cb=>f.delegate.handleStreamRequest(start(input),cb));await eventually(()=>f.children[0]?.stdout.listenerCount('data'));f.children[0].stdout.write('frame=1\n');await waiting;}

test('camera audio uses real loopback input and separate AAC-ELD/SRTP key material',async()=>{
 const f=fixture({source:{url:'http://127.0.0.1:23457/audio.wav',sampleRate:8000,channels:1,codec:'PCMA'}}),input=prepare();
 try{await active(f,input);await eventually(()=>f.children.length===2);const audio=f.args[1];
  assert.equal(audio[audio.indexOf('-i')+1],'http://127.0.0.1:23457/audio.wav');assert.equal(audio[audio.indexOf('-c:a')+1],'libfdk_aac');assert.equal(audio[audio.indexOf('-profile:a')+1],'aac_eld');
  assert.ok(audio.includes(Buffer.concat([input.audio.srtp_key,input.audio.srtp_salt]).toString('base64')));assert.ok(!audio.includes(Buffer.concat([input.video.srtp_key,input.video.srtp_salt]).toString('base64')));
  assert.ok(!audio.some(arg=>arg.includes('anullsrc')||arg.includes('sine=')));
  assert.equal(f.delegate.getMediaDiagnostics().audio.state,'starting');f.children[1].stdout.write('out_time_us=30000\n');assert.equal(f.delegate.getMediaDiagnostics().audio.state,'streaming');
  const video=f.children[0],encoder=f.children[1];let commands='';encoder.stdin.on('data',bytes=>{commands+=bytes.toString();});
  f.delegate.controller.emit('microphone-change',true,50);assert.equal(f.delegate.getMediaDiagnostics().audio.muted,true);assert.equal(video.signalCode,null);assert.equal(f.delegate.sessions.size,1);
  f.delegate.controller.emit('microphone-change',false,50);await delay(10);assert.equal(f.children.length,2);assert.equal(encoder.signalCode,null);assert.equal(commands,'cvolume -1 volume 0\ncvolume -1 volume 0.5\n');assert.equal(video.signalCode,null);
  const saved=f.delegate.sessions.get(input.sessionID);f.delegate.shutdown();assert.ok(saved.audioCrypto.every(v=>v===0));assert.equal(f.delegate.jobs.size,0);
 }finally{f.delegate.shutdown();}
});

test('missing or unsafe camera audio never stops a working video session or exposes source details',async()=>{
 for(const source of [undefined,{url:'http://SECRET.invalid/audio.wav',sampleRate:8000,channels:1},{url:'http://127.0.0.1:23457/audio.wav?SECRET',sampleRate:8000,channels:1}]){
  const f=fixture({source}),input=prepare();
  try{await active(f,input);await delay(10);assert.equal(f.children.length,1);assert.equal(f.children[0].signalCode,null);assert.equal(f.delegate.sessions.size,1);assert.ok(!JSON.stringify(f.delegate.getMediaDiagnostics()).includes('SECRET'));assert.equal(f.delegate.getMediaDiagnostics().audio.sourceReceived,false);}
  finally{f.delegate.shutdown();}
 }
});

test('audio process failure is isolated from video and stderr stays sanitized',async()=>{
 const f=fixture({source:{url:'http://127.0.0.1:23457/audio.ogg',sampleRate:48000,channels:2,codec:'OPUS'}}),input=prepare();
 try{await active(f,input);await eventually(()=>f.children.length===2);const audio=f.children[1];audio.stderr.write('PRIVATE_KEY -srtp_out_params SECRET\nUnknown encoder');audio.exitCode=1;audio.emit('close',1,null);assert.equal(f.delegate.getMediaDiagnostics().audio.lastFailure,'encoder_unavailable');assert.equal(f.children[0].signalCode,null);assert.equal(f.delegate.sessions.size,1);assert.ok(!JSON.stringify(f.delegate.getMediaDiagnostics()).includes('PRIVATE_KEY'));}
 finally{f.delegate.shutdown();}
});

test('mute and unmute cancel a pending audio source without creating a late duplicate encoder',async()=>{
 const f=fixture(),input=prepare();let resolveSource,calls=0;
 const source={url:'http://127.0.0.1:23457/audio.wav',sampleRate:8000,channels:1,codec:'PCMA'};
 f.runtime.audioSource=()=>++calls===1?new Promise(resolve=>{resolveSource=resolve;}):source;
 try{await active(f,input);await eventually(()=>!!resolveSource);
  f.delegate.controller.emit('microphone-change',true,100);f.delegate.controller.emit('microphone-change',false,100);
  await eventually(()=>f.children.length===2);resolveSource(source);await delay(10);
  assert.equal(f.children.length,2);assert.equal(f.delegate.jobs.size,2);assert.equal(f.children[0].signalCode,null);
 }finally{f.delegate.shutdown();}
});

test('disabled audio keeps the compatibility microphone muted and cannot start audio processes',async()=>{
 const f=fixture({config:{enableAudio:false},source:{url:'http://127.0.0.1:23457/audio.wav',sampleRate:8000,channels:1,codec:'PCMA'}}),input=prepare();
 try{await active(f,input);f.delegate.controller.emit('microphone-change',false,100);await delay(10);
  assert.equal(f.children.length,1);assert.equal(f.delegate.audioEnabled,false);assert.equal(f.delegate.talkbackEnabled,false);
  assert.equal(f.delegate.getMediaDiagnostics().audio.state,'disabled');assert.equal(f.delegate.getMediaDiagnostics().audio.muted,true);
 }finally{f.delegate.shutdown();}
});

test('talkback validation failures and speaker mute cannot interrupt a running video',async()=>{
 const f=fixture(),input=prepare();f.delegate.talkbackEnabled=true;
 f.runtime.talkSource=()=>({url:'http://PRIVATE.invalid/talk.pcm',format:'s16le',sampleRate:8000,channels:1});
 try{await active(f,input);const session=f.delegate.sessions.get(input.sessionID);const packet=Buffer.alloc(24);packet[0]=0x80;packet[1]=110;
  session.audioSocket.emit('message',packet,{address:'127.0.0.2'});session.audioSocket.emit('message',Buffer.from([0x80,109,...Buffer.alloc(22)]),{address:'127.0.0.1'});
  await delay(10);assert.equal(session.talkback,undefined);
  session.audioSocket.emit('message',packet,{address:'127.0.0.1'});await eventually(()=>f.delegate.getMediaDiagnostics().talkback.failures===1);
  assert.equal(f.delegate.getMediaDiagnostics().talkback.lastFailure,'talkback_invalid');assert.equal(f.children.length,1);assert.equal(f.children[0].signalCode,null);
  f.delegate.controller.emit('speaker-change',true,100);session.audioSocket.emit('message',packet,{address:'127.0.0.1'});await delay(10);assert.equal(session.talkback,undefined);
  assert.ok(!JSON.stringify(f.delegate.getMediaDiagnostics()).includes('PRIVATE'));
 }finally{f.delegate.shutdown();}
});

test('public HAP initialization and actual microphone/speaker characteristic writes control forwarding',async()=>{
 const f=fixture({talkSource:()=>undefined});
 const accessory=new hap.Accessory('Audio QA',hap.uuid.generate(randomUUID()));
 try{accessory.configureController(f.delegate.controller);
  f.delegate.controller.setMicrophoneMuted(false);f.delegate.controller.setSpeakerMuted(false);
  const microphone=accessory.getService(hap.Service.Microphone),speaker=accessory.getService(hap.Service.Speaker);
  assert.ok(microphone);assert.ok(speaker);
  assert.equal(await microphone.getCharacteristic(hap.Characteristic.Mute).handleGetRequest(),false);
  assert.equal(await speaker.getCharacteristic(hap.Characteristic.Mute).handleGetRequest(),false);
  assert.equal(f.delegate.microphoneMuted,false);assert.equal(f.delegate.speakerMuted,false);
  await invoke(cb=>microphone.getCharacteristic(hap.Characteristic.Mute).setValue(true,cb));
  await invoke(cb=>microphone.getCharacteristic(hap.Characteristic.Volume).setValue(42,cb));
  assert.equal(f.delegate.microphoneMuted,true);assert.equal(f.delegate.microphoneVolume,42);
  await invoke(cb=>speaker.getCharacteristic(hap.Characteristic.Mute).setValue(true,cb));
  await invoke(cb=>speaker.getCharacteristic(hap.Characteristic.Volume).setValue(67,cb));
  assert.equal(f.delegate.speakerMuted,true);assert.equal(f.delegate.speakerVolume,67);
  await invoke(cb=>microphone.getCharacteristic(hap.Characteristic.Mute).setValue(false,cb));
  await invoke(cb=>speaker.getCharacteristic(hap.Characteristic.Mute).setValue(false,cb));
  assert.equal(f.delegate.microphoneMuted,false);assert.equal(f.delegate.speakerMuted,false);
 }finally{f.delegate.shutdown();}
});
