import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack } from 'werift';
import { createMatterMedia } from '../lib/matter-media.mjs';

const ffmpeg = process.env.MATTER_TEST_FFMPEG || fileURLToPath(new URL('../assets/runtime/ffmpeg', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15000) { const start=Date.now(); while(!check()) { if(Date.now()-start>timeout) assert.fail('media condition timed out'); await delay(25); } }
const config = { bundlePolicy:'max-bundle', iceServers: [], iceUseTcp: false, iceUseIpv6: false, iceAdditionalHostAddresses: ['127.0.0.1'],
  codecs: { video: [new RTCRtpCodecParameters({ mimeType:'video/H264',clockRate:90000,payloadType:96,parameters:'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' })],
  audio: [new RTCRtpCodecParameters({ mimeType:'audio/opus',clockRate:48000,channels:2,payloadType:111,parameters:'minptime=10;useinbandfec=1' })] } };
function launch(args) { const child=spawn(ffmpeg,['-hide_banner','-loglevel','error',...args],{stdio:['pipe','pipe','pipe']}); child.stderr.resume(); child.stdin.on('error',()=>{}); return child; }
async function socket() { const value=createSocket('udp4'); await new Promise(resolve=>value.bind(0,'127.0.0.1',resolve)); return value; }
async function fixture({videoCodec='h264',audioCodec='opus',talkFormat='s16le'}={}) {
  const jobs=new Set(), connections=new Set(), talkChunks=[]; let talkBytes=0;
  const server=createServer((request,response)=>{
    if(request.url===(talkFormat==='ogg'?'/talk.ogg':'/talk.pcm')&&request.method==='POST') { response.writeHead(200);response.flushHeaders();request.on('data',b=>{talkBytes+=b.length;talkChunks.push(b);});request.on('end',()=>response.end());return; }
    const videoArgs=videoCodec==='h265'?['-c:v','libx265','-x265-params','pools=1:frame-threads=1:log-level=error:repeat-headers=1']:['-c:v','libx264','-tune','zerolatency'];
    const args=request.url==='/cam.ts' ? ['-re','-f','lavfi','-i','testsrc=size=320x180:rate=15',...videoArgs,'-pix_fmt','yuv420p','-preset','ultrafast','-g','15','-f','mpegts','pipe:1']
      : request.url==='/audio.ogg' ? ['-re','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-c:a','libopus','-ar','48000','-ac','2','-f','ogg','-page_duration','20000','pipe:1']
      : request.url==='/audio.wav' ? ['-re','-f','lavfi','-i','sine=frequency=440:sample_rate=8000','-c:a','pcm_alaw','-ar','8000','-ac','1','-f','wav','pipe:1'] : undefined;
    if(!args) { response.writeHead(404);response.end();return; }
    const child=launch(args);jobs.add(child);response.writeHead(200);response.flushHeaders();child.stdout.pipe(response);
    response.on('close',()=>child.kill('SIGTERM'));child.once('close',()=>jobs.delete(child));
  });
  server.on('connection',connection=>{connections.add(connection);connection.once('close',()=>connections.delete(connection));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const base=`http://127.0.0.1:${server.address().port}`;
  return { runtime:{ensureReady:async()=>`${base}/cam.ts`,audioSource:()=>audioCodec==='opus'?({url:`${base}/audio.ogg`,format:'ogg',sampleRate:48000,channels:2}):({url:`${base}/audio.wav`,format:'wav',sampleRate:8000,channels:1}),talkSource:()=>talkFormat==='s16le'?({url:`${base}/talk.pcm`,format:'s16le',sampleRate:8000,channels:1}):({url:`${base}/talk.ogg`,format:'ogg',sampleRate:48000,channels:2})},talkBytes:()=>talkBytes,talkData:()=>Buffer.concat(talkChunks),
    async close(){for(const child of jobs)child.kill('SIGTERM');for(const connection of connections)connection.destroy();await new Promise(resolve=>server.close(resolve));} };
}
function h264Decoder() {
  const child=launch(['-f','h264','-i','pipe:0','-f','framemd5','pipe:1']); let output='';child.stdout.on('data',b=>output+=b);let fragmented=false;
  const start=Buffer.from([0,0,0,1]);
  return { child, write(packet){const p=packet.payload,type=p[0]&31;if(type>=1&&type<=23)child.stdin.write(Buffer.concat([start,p]));
    else if(type===24){for(let i=1;i+2<=p.length;){const n=p.readUInt16BE(i);i+=2;if(!n||i+n>p.length)break;child.stdin.write(Buffer.concat([start,p.subarray(i,i+n)]));i+=n;}}
    else if(type===28&&p.length>2){if(p[1]&128){fragmented=true;child.stdin.write(Buffer.concat([start,Buffer.from([(p[0]&224)|(p[1]&31)]),p.subarray(2)]));}else if(fragmented)child.stdin.write(p.subarray(2));if(p[1]&64)fragmented=false;}},
    async finish(){child.stdin.end();await new Promise(resolve=>child.once('close',resolve));return output.split('\n').filter(l=>l&&!l.startsWith('#')).length;} };
}

test('Matter WebRTC sends decodable H264/Opus and posts decoded controller talk, with actual mute and cleanup', {timeout:35000}, async t=>{
  try {await access(ffmpeg);}catch{t.skip('bundled FFmpeg not available');return;}
  const source=await fixture(), media=createMatterMedia({runtime:source.runtime,ffmpegPath:ffmpeg,config:{matterLoopbackIce:true,maxStreams:1}}), remote=new RTCPeerConnection(config);
  const decoder=h264Decoder(), talkSocket=await socket(), forward=await socket(); const audioSinkPort=await socket(), audioPort=audioSinkPort.address().port;await new Promise(resolve=>audioSinkPort.close(resolve));
  const audioSink=launch(['-protocol_whitelist','pipe,udp,rtp','-analyzeduration','0','-probesize','32768','-f','sdp','-i','pipe:0','-c:a','pcm_s16le','-f','s16le','pipe:1']);let audioBytes=0;audioSink.stdout.on('data',b=>audioBytes+=b.length);
  audioSink.stdin.end(`v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Audio\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio ${audioPort} RTP/AVP 111\r\na=rtpmap:111 opus/48000/2\r\n`);
  const talk=new MediaStreamTrack({kind:'audio',codec:config.codecs.audio[0]}),received={video:0,audio:0};let talkSource;
  remote.onTrack.subscribe(track=>track.onReceiveRtp.subscribe(packet=>{received[track.kind]++;if(track.kind==='video')decoder.write(packet);else {const copy=packet.clone();copy.header.payloadType=111;copy.header.extensions=[];forward.send(copy.serialize(),audioPort,'127.0.0.1');}}));
  try {
    const {offer}=await media.createSession({id:'actual-media',video:{width:320,height:180,frameRate:15,bitRate:256000},audio:{bitRate:24000}});
    await assert.rejects(media.createSession({id:'busy',video:{}}),{reason:'session_busy'});
    await remote.setRemoteDescription({type:'offer',sdp:offer});const at=remote.getTransceivers().find(t=>t.kind==='audio');await at.sender.replaceTrack(talk);at.direction='sendrecv';
    await remote.setLocalDescription(await remote.createAnswer());await media.provideAnswer('actual-media',remote.localDescription.sdp);
    await until(()=>remote.connectionState==='connected'&&media.status().state==='connected');
    talkSocket.on('message',b=>talk.writeRtp(b));
    talkSource=launch(['-re','-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-c:a','libopus','-ar','48000','-ac','1','-application','lowdelay','-frame_duration','20','-f','rtp',`rtp://127.0.0.1:${talkSocket.address().port}?pkt_size=1200`]);talkSource.stdout.resume();
    await until(()=>received.video>35&&audioBytes>60000&&source.talkBytes()>16000);
    const beforeMic=media.status().audioPackets,beforeTalk=source.talkBytes();media.setMicrophoneMuted(true);media.setSpeakerMuted(true);await delay(500);
    assert.equal(media.status().audioPackets,beforeMic,'microphone mute stops outgoing RTP');const settledTalk=source.talkBytes();await delay(400);assert.equal(source.talkBytes(),settledTalk,'speaker mute stops talk POST');assert.ok(settledTalk>=beforeTalk);
    media.setMicrophoneVolume(50);media.setSpeakerVolume(50);media.setMicrophoneMuted(false);media.setSpeakerMuted(false);
    await until(()=>media.status().audioPackets>beforeMic+10&&source.talkBytes()>settledTalk+4000);
    const session=media.session;await media.closeSession('actual-media');assert.equal(media.status().active,false);assert.equal(session.jobs.size,0);assert.equal(session.sockets.size,0);
    const frames=await decoder.finish();assert.ok(frames>10,`decoded ${frames} H264 frames`);assert.ok(audioBytes>60000);assert.ok(media.status().talkBytes>16000);
  } finally {
    talkSource?.kill('SIGTERM');decoder.child.kill('SIGTERM');audioSink.kill('SIGTERM');talkSocket.close();forward.close();await media.close();await remote.close();await source.close();
  }
});

test('Matter media accepts remote offers, bounds candidates and snapshots, and closes negotiation timeout', {timeout:10000}, async()=>{
  const remote=new RTCPeerConnection(config),media=createMatterMedia({runtime:{},config:{matterLoopbackIce:true},connectTimeoutMs:250,snapshotDelegate:{handleSnapshotRequest:(_request,callback)=>callback(undefined,Buffer.from([255,216,255,192,0,8,8,0,180,1,64,1]))}});
  try {
    await assert.rejects(media.createSession({id:'relay',video:{},iceTransportPolicy:'relay'}),{reason:'relay_unavailable'});
    await assert.rejects(media.createSession({id:'servers',video:{},iceServers:[{urls:'stun:example.com'}]}),{reason:'ice_servers_unsupported'});
    remote.addTransceiver('video',{direction:'recvonly'});await remote.setLocalDescription(await remote.createOffer());
    const {answer}=await media.createSession({id:'answer',offer:remote.localDescription.sdp,video:{}});assert.match(answer,/a=sendonly/);
    await assert.rejects(media.addCandidates('answer',Array(33).fill({candidate:''})),{reason:'invalid_candidates'});
    await assert.rejects(media.provideAnswer('answer','v=0\r\n'),{reason:'invalid_sdp'});
    const image=await media.snapshot({width:320,height:180});assert.equal(image.width,320);assert.ok(Buffer.isBuffer(image.data));
    await until(()=>!media.status().active,2000);assert.equal(media.status().lastFailure,'webrtc_timeout');assert.ok(!JSON.stringify(media.status()).includes('candidate:'));
  } finally {await media.close();await remote.close();}
});

test('controller offers accept HEVC/PCMA sources, send H264/Opus, and return decodable Ogg talk', {timeout:25000}, async t=>{
  try {await access(ffmpeg);}catch{t.skip('bundled FFmpeg not available');return;}
  const source=await fixture({videoCodec:'h265',audioCodec:'pcma',talkFormat:'ogg'}),media=createMatterMedia({runtime:source.runtime,ffmpegPath:ffmpeg,config:{matterLoopbackIce:true}}),remote=new RTCPeerConnection(config),decoder=h264Decoder();let packets=0,audioPackets=0,talkSource;
  const talk=new MediaStreamTrack({kind:'audio',codec:config.codecs.audio[0]}),talkSocket=await socket();talkSocket.on('message',bytes=>talk.writeRtp(bytes));
  remote.onTrack.subscribe(track=>track.onReceiveRtp.subscribe(packet=>{if(track.kind==='video'){packets++;decoder.write(packet);}else audioPackets++;}));
  try {remote.addTransceiver('video',{direction:'recvonly'});remote.addTransceiver(talk,{direction:'sendrecv'});await remote.setLocalDescription(await remote.createOffer());
    const {answer}=await media.createSession({id:'controller-offer',offer:remote.localDescription.sdp,video:{width:320,height:180,frameRate:15,bitRate:256000},audio:{}});
    await remote.setRemoteDescription({type:'answer',sdp:answer});await until(()=>remote.connectionState==='connected');
    talkSource=launch(['-re','-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-c:a','libopus','-ar','48000','-ac','1','-application','lowdelay','-frame_duration','20','-f','rtp',`rtp://127.0.0.1:${talkSocket.address().port}?pkt_size=1200`]);talkSource.stdout.resume();
    await until(()=>packets>20&&audioPackets>10&&source.talkBytes()>2000);await media.closeSession('controller-offer');
    assert.ok(await decoder.finish()>5,'controller-offer media must decode H264');
    const oggDecoder=launch(['-f','ogg','-i','pipe:0','-c:a','pcm_s16le','-f','s16le','pipe:1']);let decoded=0;oggDecoder.stdout.on('data',bytes=>decoded+=bytes.length);oggDecoder.stdin.end(source.talkData());await new Promise(resolve=>oggDecoder.once('close',resolve));assert.ok(decoded>8000,'Ogg talk must decode into audio samples');
  } finally {talkSource?.kill('SIGTERM');talkSocket.close();decoder.child.kill('SIGTERM');await media.close();await remote.close();await source.close();}
});

test('Matter media rejects non-loopback source before starting FFmpeg', {timeout:10000}, async()=>{
  let spawns=0;const remote=new RTCPeerConnection(config),media=createMatterMedia({runtime:{ensureReady:async()=> 'http://example.com:23456/cam.ts'},config:{matterLoopbackIce:true},spawnProcess:()=>{spawns++;throw Error('must not spawn');}});
  try {const {offer}=await media.createSession({id:'unsafe',video:{}});await remote.setRemoteDescription({type:'offer',sdp:offer});await remote.setLocalDescription(await remote.createAnswer());await media.provideAnswer('unsafe',remote.localDescription.sdp);
    await until(()=>!media.status().active);assert.equal(spawns,0);assert.equal(media.status().lastFailure,'media_unavailable');
  } finally {await media.close();await remote.close();}
});

test('negotiation failures preserve fixed stage and type after session cleanup without SDP or raw errors', {timeout:5000}, async()=>{
  const media=createMatterMedia({runtime:{},config:{matterLoopbackIce:true}});
  try {await assert.rejects(media.createSession({id:'malformed',offer:'v=0\r\na=fingerprint:PRIVATE_FINGERPRINT\r\na=ice-ufrag:PRIVATE_USERNAME\r\n',video:{}}),{reason:'media_not_offered'});
    const status=media.status();assert.equal(status.failures,1);assert.equal(status.lastFailure,'media_not_offered');assert.equal(status.lastFailureStage,'remote_description');assert.equal(typeof status.lastFailureType,'string');assert.equal(status.active,false);
    assert.equal(JSON.stringify(status).includes('PRIVATE'),false);
  } finally {await media.close();}
});

test('browser-style multiple H264 profiles negotiate the constrained-baseline source and offered payload type', {timeout:10000}, async()=>{
  const videoCodecs=[new RTCRtpCodecParameters({mimeType:'video/H264',clockRate:90000,payloadType:100,parameters:'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f'}),new RTCRtpCodecParameters({mimeType:'video/rtx',clockRate:90000,payloadType:101,parameters:'apt=100'}),new RTCRtpCodecParameters({mimeType:'video/H264',clockRate:90000,payloadType:102,parameters:'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'}),new RTCRtpCodecParameters({mimeType:'video/rtx',clockRate:90000,payloadType:103,parameters:'apt=102'})];
  const remote=new RTCPeerConnection({...config,codecs:{...config.codecs,video:videoCodecs}}),media=createMatterMedia({runtime:{},config:{matterLoopbackIce:true}});
  try {remote.addTransceiver('video',{direction:'recvonly'});remote.addTransceiver('audio',{direction:'sendrecv'});await remote.setLocalDescription(await remote.createOffer());
    const {answer}=await media.createSession({id:'browser-codecs',offer:remote.localDescription.sdp,video:{},audio:{}});
    assert.match(answer,/a=fmtp:102 [^\r\n]*profile-level-id=42e01f/);assert.match(answer,/a=rtpmap:102 H264\/90000/);assert.doesNotMatch(answer,/profile-level-id=42001f/);
    assert.equal(media.session.videoSender.codec.payloadType,102);assert.equal(media.status().failures,0);
  } finally {await media.close();await remote.close();}
});
