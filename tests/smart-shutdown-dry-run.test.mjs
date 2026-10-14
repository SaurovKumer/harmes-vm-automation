// Dry-run integration tests for the ACTUAL Worker scheduler and Telegram callbacks.
// No real network, Telegram API, Azure credentials or VM state are touched.
// Run: node --test tests/smart-shutdown-dry-run.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { HermesTaskState } from '../src/hermes-task-state.js';

function dryRun() {
  const originalFetch = globalThis.fetch;
  const originalClock = Date.now;
  let clock = 1_800_500_000_000;
  const epoch = () => Math.floor(clock / 1000);
  Date.now = () => clock;
  const tags = {
    AutoStartEnabled: 'false',
    AutoStartTime: '06:00',
    LastPowerState: 'running',
    RunUntilEpoch: String(epoch() + 1800),
    WarningForEpoch: '0'
  };
  const sent = [];
  const callbackAnswers = [];
  let deallocations = 0;
  let vmRunning = true;
  const stateStorage = new Map();
  const durable = new HermesTaskState({
    storage: {
      async get(k) { return structuredClone(stateStorage.get(k)); },
      async put(k, v) { stateStorage.set(k, structuredClone(v)); }
    }
  });
  const env = {
    SMART_DEALLOCATE_ENABLED: 'true',
    HERMES_TASK_STATE: {
      idFromName(name) { assert.equal(name, 'single-vm'); return name; },
      get() { return { fetch(req) { return durable.fetch(req); } }; }
    },
    AZURE_CLIENT_ID: 'fake-client',
    AZURE_CLIENT_SECRET: 'fake-secret',
    AZURE_TENANT_ID: 'fake-tenant',
    AZURE_SUBSCRIPTION_ID: 'fake-sub',
    RESOURCE_GROUP: 'fake-group',
    VM_NAME: 'fake-vm',
    TELEGRAM_BOT_TOKEN: 'fake-bot',
    TELEGRAM_CHAT_ID: '123456',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-token'
  };

  // Only these fake endpoints are reachable. Unknown requests fail closed.
  globalThis.fetch = async (input, init={}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init.method || 'GET';
    if (url.startsWith('https://login.microsoftonline.com/')) {
      return Response.json({access_token:'fake-azure-token',expires_in:3600});
    }
    if (url.startsWith('https://api.telegram.org/botfake-bot/')) {
      const api = url.split('/').at(-1);
      const payload = JSON.parse(init.body || '{}');
      if (api === 'sendMessage') sent.push(payload);
      else if (api === 'answerCallbackQuery') callbackAnswers.push(payload);
      else throw Error('Unknown fake Telegram method: '+api);
      return Response.json({ok:true});
    }
    if (url.startsWith('https://management.azure.com/')) {
      if (url.includes('/instanceView?') && method === 'GET') {
        return Response.json({statuses:[{
          code: vmRunning ? 'PowerState/running' : 'PowerState/deallocated',
          displayStatus: vmRunning ? 'VM running' : 'VM deallocated'
        }]});
      }
      if (url.includes('/providers/Microsoft.Resources/tags/default?')) {
        if (method === 'GET') return Response.json({properties:{tags:{...tags}}});
        if (method === 'PATCH') {
          Object.assign(tags,JSON.parse(init.body).properties.tags);
          return Response.json({properties:{tags:{...tags}}});
        }
      }
      if (url.includes('/deallocate?') && method === 'POST') {
        deallocations++;
        vmRunning = false;
        return Response.json({status:'accepted'},{status:202});
      }
    }
    throw Error('Unsafe/unexpected network call: '+method+' '+url);
  };

  async function rpc(path, payload={}) {
    const response = await durable.fetch(new Request('https://internal'+path,{
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    }));
    assert.equal(response.status,200,path);
    return response.json();
  }
  let deliveryCounter=0;
  async function event(kind,id='chat') {
    return rpc('/event',{
      event:'agent:'+kind,session_id:id,
      delivery_id:'dryrun'+String(++deliveryCounter).padStart(8,'0')
    });
  }
  async function tick() {
    const jobs=[];
    await worker.scheduled({},env,{waitUntil(p){jobs.push(p);}});
    await Promise.all(jobs);
  }
  async function click(action,token) {
    const jobs=[];
    const request = new Request('https://fake-worker.test/telegram',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'X-Telegram-Bot-Api-Secret-Token':env.TELEGRAM_WEBHOOK_SECRET
      },
      body:JSON.stringify({
        callback_query:{
          id:'callback-'+(callbackAnswers.length+1),
          message:{chat:{id:Number(env.TELEGRAM_CHAT_ID)}},
          data:action+'|'+token
        }
      })
    });
    const res=await worker.fetch(request,env,{waitUntil(p){jobs.push(p);}});
    assert.equal(res.status,200);
    await Promise.all(jobs);
  }
  async function command(text) {
    const jobs=[];
    const res=await worker.fetch(new Request('https://fake-worker.test/telegram',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'X-Telegram-Bot-Api-Secret-Token':env.TELEGRAM_WEBHOOK_SECRET
      },
      body:JSON.stringify({message:{chat:{id:Number(env.TELEGRAM_CHAT_ID)},text}})
    }),env,{waitUntil(p){jobs.push(p);}});
    assert.equal(res.status,200);
    await Promise.all(jobs);
  }
  return {
    tags,sent,callbackAnswers,env,event,rpc,tick,click,command,
    epoch, now:()=>clock,
    advance(ms){clock+=ms;},
    setTime(ms){clock=ms;},
    countStops(){return deallocations;},
    restore(){globalThis.fetch=originalFetch;Date.now=originalClock;}
  };
}
const minutes=(x)=>x*60*1000;

test('DRY RUN: active task blocks expired legacy timer; completed task warns at minute 5 and deallocates at minute 10', async()=>{
  const x=dryRun();
  try {
    await x.event('start');
    x.advance(minutes(31));
    await x.tick();
    assert.equal(x.countStops(),0,'active Hermes must override legacy shutdown');
    assert.equal(x.sent.length,0,'no warning while Hermes active');

    await x.event('end');
    x.advance(minutes(4));
    await x.tick();
    assert.equal(x.sent.length,0);
    x.advance(minutes(1));
    await x.tick();
    assert.equal(x.sent.length,1,'one Telegram confirmation');
    assert.match(x.sent[0].text,/5 minutes/);
    assert.equal(x.countStops(),0);
    x.advance(minutes(4));
    await x.tick();
    assert.equal(x.countStops(),0);
    x.advance(minutes(1));
    await x.tick();
    assert.equal(x.countStops(),1,'fake Azure deallocation requested');
  } finally{x.restore();}
});

test('DRY RUN: Telegram Keep Alive +15m cancels original deallocation', async()=>{
  const x=dryRun();
  try {
    await x.event('start');
    await x.event('end');
    x.advance(minutes(5));
    await x.tick();
    assert.equal(x.sent.length,1);
    const token=x.sent[0].reply_markup.inline_keyboard[0][0].callback_data.split('|')[1];
    await x.click('smartkeep15',token);
    assert.equal(x.countStops(),0);
    assert.equal(x.callbackAnswers.at(-1).text,'Kept alive 15 minutes');
    x.advance(minutes(6));
    await x.tick();
    assert.equal(x.countStops(),0);
    x.advance(minutes(9));
    await x.tick();
    const warnings=x.sent.filter(m=>m.text?.includes('Hermes is inactive'));
    assert.equal(warnings.length,2,'new prompt after 15 more minutes');
    assert.notEqual(warnings[0].reply_markup.inline_keyboard[0][0].callback_data,
      warnings[1].reply_markup.inline_keyboard[0][0].callback_data);
    await x.click('smartkeep15',token);
    assert.equal(x.callbackAnswers.at(-1).text,'Confirmation expired');
    assert.equal(x.countStops(),0);
  } finally{x.restore();}
});

test('DRY RUN: fresh Hermes task cancels a pending warning', async()=>{
  const x=dryRun();
  try {
    await x.event('start');
    await x.event('end');
    x.advance(minutes(5));
    await x.tick();
    const token=x.sent[0].reply_markup.inline_keyboard[0][0].callback_data.split('|')[1];
    x.advance(minutes(2));
    await x.event('start','new-task');
    await x.click('smartstop',token);
    assert.equal(x.countStops(),0,'old stop button must fail');
    x.advance(minutes(6));
    await x.tick();
    assert.equal(x.countStops(),0,'new task blocks timeout');
    await x.event('end','new-task');
    x.advance(minutes(4));
    await x.tick();
    assert.equal(x.countStops(),0);
    assert.equal(x.sent.filter(m=>m.text?.includes('Hermes is inactive')).length,1);
  } finally{x.restore();}
});

test('DRY RUN: manual Telegram /keep60 survives agent end', async()=>{
  const x=dryRun();
  try {
    await x.event('start');
    await x.command('/keep60');
    const manualEnd=Number(x.tags.RunUntilEpoch);
    await x.event('end');
    const state=await x.rpc('/tick');
    assert.equal(state.action,'idle');
    assert.ok(state.idleUntil>=manualEnd);
    x.advance(minutes(30));
    await x.tick();
    assert.equal(x.countStops(),0);
    assert.equal(x.sent.filter(m=>m.text?.includes('Hermes is inactive')).length,0);
  } finally{x.restore();}
});

test('DRY RUN: smart automation remains disabled until explicit opt-in',async()=>{
  const x=dryRun();
  try{
    x.env.SMART_DEALLOCATE_ENABLED='false';
    await x.event('start');
    x.advance(minutes(31));
    await x.tick();
    assert.equal(x.countStops(),1,
      'legacy Azure deallocation deadline remains active when smart mode disabled');
    assert.equal(x.sent.filter(m=>m.text?.includes('Hermes is inactive')).length,0);
  }finally{x.restore();}
});
