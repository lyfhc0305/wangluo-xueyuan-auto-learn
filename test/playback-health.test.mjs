import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as app from '../auto-learn.mjs';

test('media reload restores exact watched position after metadata, without advancing it', async () => {
  assert.equal(typeof app.reloadPlaybackMedia,'function');
  const video=new EventTarget();
  Object.assign(video,{currentTime:41.25,duration:300,ended:false,playbackRate:1,muted:false,
    load(){this.currentTime=0;queueMicrotask(()=>this.dispatchEvent(new Event('loadedmetadata')));},
    play:async()=>{}});
  const page={evaluate:(fn,mute)=>vm.runInNewContext(`(${fn.toString()})(mute)`,{document:{querySelector:()=>video},setTimeout,clearTimeout,mute})};
  const result=await app.reloadPlaybackMedia(page,true);
  assert.equal(result.ok,true);
  assert.equal(video.currentTime,41.25);
  assert.equal(video.playbackRate,1);
  video.play=async()=>{throw Error('blocked');};
  assert.equal((await app.reloadPlaybackMedia(page,true)).ok,false);
});

test('resumed slow course confirms speed recovery only after two healthy windows', () => {
  const m=app.createPlaybackMonitor({now:0,currentTime:100,recoveryPending:true});
  const actions=[];
  for(let t=2000;t<=150000;t+=2000){const d=m.sample({now:t,currentTime:100+t/1000,hasVideo:true});if(d.action!=='none')actions.push(d.action);}
  assert.deepEqual(actions,['recovered']);
});

test('continuous fractional progress cannot hide two consecutive slow windows', () => {
  assert.equal(typeof app.createPlaybackMonitor, 'function');
  const monitor = app.createPlaybackMonitor({ now: 0, currentTime: 0 });
  let action;
  for (let t = 2000; t <= 150000; t += 2000) action = monitor.sample({ now: t, currentTime: t / 1000 * 0.3, hasVideo: true });
  assert.equal(action.action, 'reload');
  assert.equal(action.ratio, 0.3);
  assert.equal(monitor.sample({ now: 152000, currentTime: 45.6, hasVideo: true }).action, 'none');
});

test('failed media reload escalates only after two new slow windows', () => {
  const m = app.createPlaybackMonitor({ now: 0, currentTime: 0 });
  const actions=[];
  for(let t=2000;t<=300000;t+=2000) {const d=m.sample({now:t,currentTime:t/1000*0.3,hasVideo:true});if(d.action!=='none')actions.push(d.action);}
  assert.deepEqual(actions,['reload','restart']);
});

test('recovery needs two normal windows, and quiz or seeks never fake recovery', () => {
  const m=app.createPlaybackMonitor({now:0,currentTime:0});
  for(let t=2000;t<=150000;t+=2000)m.sample({now:t,currentTime:t/1000*0.3,hasVideo:true});
  assert.equal(m.sample({now:152000,currentTime:45.6,hasVideo:true,quizOpen:true}).action,'none');
  const actions=[];
  for(let t=154000;t<=302000;t+=2000){const d=m.sample({now:t,currentTime:45.6+(t-152000)/1000,hasVideo:true});if(d.action!=='none')actions.push(d.action);}
  assert.deepEqual(actions,['recovered']);
  assert.equal(m.sample({now:304000,currentTime:500,hasVideo:true}).action,'none');
});
