// Run: node --test tests/hermes-task-state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { HermesTaskState } from '../src/hermes-task-state.js';

function setup() {
  const map = new Map();
  const actor = new HermesTaskState({
    storage: {
      async get(k) { return structuredClone(map.get(k)); },
      async put(k, v) { map.set(k, structuredClone(v)); }
    }
  });
  const post = async (path, body={}) => {
    const res = await actor.fetch(new Request('https://internal'+path,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
    }));
    assert.equal(res.status,200);
    return res.json();
  };
  const status = async () => (await (await actor.fetch(new Request('https://internal/status'))).json());
  return {post,status};
}
const event = (kind, id, delivery) => ({
  event: 'agent:'+kind, session_id:id, delivery_id:delivery
});
test('unmanaged worker preserves legacy behavior',async()=>{
  const {post}=setup();
  assert.equal((await post('/tick')).action,'legacy');
});
test('active task overrides 30m timer and completed task waits 30m',async()=>{
  const old=Date.now;
  try {
    let current=1_800_000_000_000;
    Date.now=()=>current;
    const {post,status}=setup();
    await post('/event',event('start','chat-1','delivery111'));
    current+=29*60*1000;
    await post('/event',event('step','chat-1','delivery222'));
    current+=2*60*1000;
    assert.equal((await post('/tick')).action,'active');
    await post('/event',event('end','chat-1','delivery333'));
    assert.equal((await status()).activeCount,0);
    assert.equal((await post('/tick')).action,'idle');
    current+=30*60*1000;
    const prompt=await post('/tick');
    assert.equal(prompt.action,'prompt');
    const delivered=await post('/prompt-delivered',{token:prompt.token});
    assert.equal(delivered.ok,true);
    current+=4*60*1000;
    assert.equal((await post('/tick')).action,'awaiting');
    current+=61*1000;
    assert.equal((await post('/tick')).action,'due');
    assert.equal((await post('/claim',{token:prompt.token})).ok,true);
  } finally {Date.now=old;}
});
test('keep15 cancels pending deallocation; old buttons expire',async()=>{
  const old=Date.now;
  try{
    let current=1_800_100_000_000;Date.now=()=>current;
    const {post}=setup();
    await post('/event',event('start','session','delivery111'));
    await post('/event',event('end','session','delivery222'));
    current+=30*60*1000;
    const first=await post('/tick');
    await post('/prompt-delivered',{token:first.token});
    assert.equal((await post('/keep',{token:first.token})).ok,true);
    assert.equal((await post('/manual-stop',{token:first.token})).ok,false);
    assert.equal((await post('/tick')).action,'idle');
    current+=15*60*1000;
    const second=await post('/tick');
    assert.equal(second.action,'prompt');
    assert.notEqual(second.token,first.token);
  }finally{Date.now=old;}
});
test('new task cancels pending deallocation and blocks stale manual stop',async()=>{
  const old=Date.now;
  try{
    let current=1_800_200_000_000;Date.now=()=>current;
    const {post}=setup();
    await post('/event',event('start','session','delivery111'));
    await post('/event',event('end','session','delivery222'));
    current+=30*60*1000;
    const prompt=await post('/tick');
    await post('/prompt-delivered',{token:prompt.token});
    await post('/event',event('start','session','delivery333'));
    assert.equal((await post('/tick')).action,'active');
    assert.equal((await post('/manual-stop',{token:prompt.token})).ok,false);
    assert.equal((await post('/claim',{token:prompt.token})).ok,false);
  }finally{Date.now=old;}
});
test('duplicate delivery is ignored and late step cannot reactivate session',async()=>{
  const {post,status}=setup();
  await post('/event',event('start','session','delivery111'));
  assert.equal((await post('/event',event('start','session','delivery111'))).duplicate,true);
  await post('/event',event('end','session','delivery222'));
  await post('/event',event('step','session','delivery333'));
  assert.equal((await status()).activeCount,0);
  assert.equal((await status()).receivedCount,3);
});

test('periodic heartbeat keeps a long-running session active; stale session prompts',async()=>{
  const old=Date.now;
  try {
    let current=1_800_300_000_000;
    Date.now=()=>current;
    const {post,status}=setup();
    await post('/event',event('start','long-task','delivery111'));
    for(let i=0;i<60;i++){
      current+=60*1000;
      await post('/event',event('heartbeat','long-task','beatnumber'+i+'abc'));
    }
    assert.equal((await status()).activeCount,1);
    assert.equal((await status()).heartbeatCount,60);
    assert.ok((await status()).lastHeartbeatAt > 0);
    assert.equal((await post('/tick')).action,'active');
    current+=46*60*1000;
    const stale=await post('/tick');
    assert.equal(stale.action,'prompt');
    assert.equal(stale.stale,true);
  } finally {Date.now=old;}
});
