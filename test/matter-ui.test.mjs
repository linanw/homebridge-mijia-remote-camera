import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { safeDiagnostics } from '../lib/diagnostics.mjs';

class Element {
  constructor(){this.value='';this.checked=false;this.disabled=false;this.textContent='';this.children=[];this.dataset={};const set=new Set();this.classList={add:x=>set.add(x),remove:x=>set.delete(x),contains:x=>set.has(x),toggle:(x,on)=>on?set.add(x):set.delete(x)};}
  replaceChildren(){this.children=[];this.value='';}append(child){this.children.push(child);if(this.children.length===1)this.value=child.value;}removeAttribute(name){delete this[name];}
}
const ready={enabled:true,running:true,commissioned:false,commissioningWindowOpen:true,state:'ready',deviceType:322,activeSessions:0,media:{sessions:1,videoPackets:12,audioPackets:10,talkBytes:1600,active:false,microphoneMuted:false,speakerMuted:false}};
const codes={manualPairingCode:'12345678901',qrPairingCode:'MT:0123456789ABCDEF'};
async function screen({configs=[{platform:'MijiaRemoteCamera',enableMatter:true}],matter=ready,pairing=async()=>codes}={}){
  const html=await readFile(new URL('../homebridge-ui/public/index.html',import.meta.url),'utf8'),elements=new Map(),intervals=[],calls=[],saved=[];
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  for(const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){const e=get(match[1]);e.disabled=/\sdisabled(?:\s|>)/.test(match[0]);for(const c of(match[0].match(/class="([^"]*)"/)?.[1]||'').split(/\s+/).filter(Boolean))e.classList.add(c);}
  get('region').value='cn';let currentMatter=structuredClone(matter),failure;
  const runtime=()=>({state:'ready',ready:true,videoReceived:true,region:'cn',matter:currentMatter});
  const homebridge={hideSchemaForm(){},getPluginConfig:async()=>configs,updatePluginConfig:async value=>saved.push(structuredClone(value)),savePluginConfig:async()=>{},request:async(path,payload)=>{
    calls.push({path,payload});if(path==='/status'){if(failure)throw failure;return runtime();}if(path==='/components')return{ready:true};if(path==='/auth/status')return{state:'idle'};
    if(path==='/matter/pairing')return pairing();if(path==='/matter/open-window'){currentMatter={...currentMatter,commissioningWindowOpen:true};return currentMatter;}if(path==='/matter/close-window'){currentMatter={...currentMatter,commissioningWindowOpen:false};return currentMatter;}
    if(path==='/auth/start')return{loginId:'test',loginUrl:'https://account.xiaomi.com/login'};if(path==='/homes')return[{id:'1',ownerId:'2',name:'家庭'}];if(path==='/devices')return[{deviceId:'3',name:'摄像头'}];return{success:true};}};
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1],{homebridge,URL,document:{getElementById:get,createElement:()=>new Element()},window:{addEventListener(){}},setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval(){},setTimeout:()=>1,clearTimeout(){}});
  await new Promise(setImmediate);await new Promise(setImmediate);
  return{get,calls,saved,html,runtime,poll:()=>intervals[0](),setMatter:value=>currentMatter=value,fail:value=>failure=value};
}

test('Matter schema defaults are opt-in and UI describes real development/LAN constraints',async()=>{
  const schema=JSON.parse(await readFile(new URL('../config.schema.json',import.meta.url),'utf8')).schema.properties;
  assert.equal(schema.enableMatter.default,false);assert.equal(schema.matterPort.default,5540);assert.equal(schema.matterInterface.default,'eth0');
  const ui=await screen({configs:[{platform:'MijiaRemoteCamera'}]});assert.equal(ui.get('enableMatter').checked,false);assert.equal(ui.get('matterPort').value,'5540');assert.equal(ui.get('matterInterface').value,'eth0');assert.equal(ui.get('matterPairing').disabled,true);
  assert.match(ui.html,/MatterDesk.*开发证书/);assert.match(ui.html,/不承诺 Apple/);assert.match(ui.html,/不使用 STUN 或 TURN/);assert.match(ui.html,/<input id="matterManualCode" readonly/);
});

test('Matter diagnostics exactly match server whitelist without pairing, SDP, IDs or arbitrary counters',async()=>{
  const secret='PRIVATE_PAIRING_SDP',matter={...ready,manualPairingCode:secret,qrPairingCode:secret,sdp:secret,nodeId:secret,activeSessions:101,videoStreams:1,session:secret,media:{...ready.media,sessions:secret,failures:2,talkPackets:11,lastFailure:'negotiation_failed',lastFailureStage:'replace_video_track',lastFailureType:'InvalidModificationError',raw:secret,localUrl:secret,key:secret}};
  const ui=await screen({matter});const report=JSON.parse(ui.get('diagnosticsReport').textContent);assert.deepEqual(report,safeDiagnostics(ui.runtime()));assert.equal(ui.get('diagnosticsReport').textContent.includes(secret),false);assert.match(ui.get('matterMedia').textContent,/视频包 12/);
});

test('saving Matter settings preserves bridge identity, advanced fields and additional configs',async()=>{
  const configs=[{platform:'MijiaRemoteCamera',name:'子桥',_bridge:{username:'AA:BB:CC:DD:EE:FF',port:52000},quality:3,runtimeDirectory:'/private',videoConfig:{maxWidth:1920},enableAudio:false}, {platform:'MijiaRemoteCamera',name:'第二配置',_bridge:{port:52001}}],before=structuredClone(configs);
  const ui=await screen({configs});ui.get('enableMatter').checked=true;ui.get('enableMatter').onchange();ui.get('matterPort').value='5541';ui.get('matterInterface').value='eno1';await ui.get('saveMatter').onclick();
  assert.deepEqual(ui.saved,[[{...before[0],enableMatter:true,matterPort:5541,matterInterface:'eno1'},before[1]]]);assert.deepEqual(configs,before);assert.match(ui.get('matterConfigState').textContent,/重启摄像头子桥/);assert.equal(ui.get('matterPairing').disabled,true);
});

test('private pairing appears only on explicit action and clears on account, camera, config and status changes',async()=>{
  for(const kind of ['login','region','camera','disabled','failure','window']){
    const ui=await screen();assert.equal(ui.calls.some(x=>x.path==='/matter/pairing'),false);await ui.get('matterPairing').onclick();assert.equal(ui.get('matterManualCode').value,codes.manualPairingCode);assert.equal(ui.get('matterQrCode').value,codes.qrPairingCode);assert.equal(ui.get('diagnosticsReport').textContent.includes(codes.manualPairingCode),false);
    if(kind==='login')await ui.get('login').onclick();if(kind==='region'){ui.get('region').value='sg';ui.get('region').onchange();}if(kind==='camera')await ui.get('load').onclick();if(kind==='disabled'){ui.get('enableMatter').checked=false;ui.get('enableMatter').onchange();}if(kind==='failure'){ui.fail({reason:'plugin_not_running',sdp:'PRIVATE'});await ui.poll();}if(kind==='window'){ui.setMatter({...ready,commissioningWindowOpen:false});await ui.poll();}
    assert.equal(ui.get('matterManualCode').value,'',kind);assert.equal(ui.get('matterQrCode').value,'',kind);assert.equal(ui.get('matterPairingPanel').classList.contains('hide'),true,kind);
  }
});

test('stale or malformed pairing responses cannot expose private content after context changes',async()=>{
  let release;const ui=await screen({pairing:()=>new Promise(resolve=>release=resolve)});const pending=ui.get('matterPairing').onclick();ui.get('region').value='sg';ui.get('region').onchange();release(codes);await pending;assert.equal(ui.get('matterManualCode').value,'');
  const invalid=await screen({pairing:async()=>({manualPairingCode:'<img src=x onerror=alert(1)>',qrPairingCode:'PRIVATE_SDP'})});await invalid.get('matterPairing').onclick();assert.equal(invalid.get('matterManualCode').value,'');assert.equal(invalid.get('matterActionState').textContent.includes('PRIVATE_SDP'),false);
});

test('explicit commissioning actions use dedicated routes and clear pairing when closing',async()=>{
  const ui=await screen({matter:{...ready,commissioningWindowOpen:false}});assert.equal(ui.get('matterOpen').disabled,false);await ui.get('matterOpen').onclick();assert.equal(ui.get('matterPairing').disabled,false);await ui.get('matterPairing').onclick();await ui.get('matterClose').onclick();assert.equal(ui.get('matterManualCode').value,'');assert.equal(ui.get('matterPairing').disabled,true);assert.deepEqual(ui.calls.filter(x=>x.path.startsWith('/matter/')).map(x=>x.path),['/matter/open-window','/matter/pairing','/matter/close-window']);
});
