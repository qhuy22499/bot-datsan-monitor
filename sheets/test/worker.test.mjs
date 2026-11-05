import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync,constants as sqlite} from 'node:sqlite';
import worker,{SheetsCoordinator,SHEETS_CRON,validScheduledEvent} from '../src/index.mjs';
import {SLOT_TIMES} from '../src/read-model.mjs';

const NOW=Date.parse('2026-11-05T07:02:00+09:00');
const ID='offline_spreadsheet_identifier_only';
const token=['123456789',':','OFFLINE_ONLY_'.repeat(4)].join('');
const secret='OFFLINE_WEBHOOK_'.repeat(3);
const clone=value=>structuredClone(value);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};

function sqliteStorage() {
  const db=new DatabaseSync(':memory:');
  const sql={exec(text,...args){
    const statement=db.prepare(text);
    const rows=statement.columns().length?statement.all(...args):(statement.run(...args),[]);
    return{toArray:()=>rows};
  }};
  return{db,sql};
}

function sourceBinding() {
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../worker/migrations/0001_monitor.sql',import.meta.url),'utf8'));
  const id='a'.repeat(32),start='2026-11-05T07:00:00+09:00',finish='2026-11-05T07:01:00+09:00';
  db.prepare(`INSERT INTO scans VALUES(?,?,?,'COMPLETE','VERIFIED','2026-11-05','2026-11-05',1,14,1)`).run(id,start,finish);
  db.prepare(`UPDATE source SET revision=1,baseline='QUIET',last_scan=?,last_status='COMPLETE',last_success=? WHERE id=1`).run(id,finish);
  for(const court of ['A','B'])for(const [time,end] of SLOT_TIMES)
    db.prepare('INSERT INTO slots VALUES(?,?,?,?,?,?,?,?,?)').run(
      `2026-11-05:${court}:${time}:${end}`,'2026-11-05',court,time,end,'AVAILABLE',
      '2026-11-05T07:00:30+09:00',1,id);
  const before=Buffer.from(db.serialize());let calls=0;
  db.setAuthorizer(action=>[sqlite.SQLITE_SELECT,sqlite.SQLITE_READ,sqlite.SQLITE_FUNCTION].includes(action)?sqlite.SQLITE_OK:sqlite.SQLITE_DENY);
  return{db,before,get calls(){return calls;},binding:{prepare(text){calls++;return{async all(){
    return{success:true,results:db.prepare(text).all()};
  }}}}};
}

async function serviceAccount() {
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',hash:'SHA-256',modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1])},true,['sign','verify']);
  const bytes=new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey));
  const pem=btoa(String.fromCharCode(...bytes)).match(/.{1,64}/g).join('\n');
  const delimiter=action=>[`-----${action}`,'PRIVATE KEY-----'].join(' ');
  return JSON.stringify({type:'service_account',client_email:'offline@offline.iam.gserviceaccount.com',
    token_uri:'https://oauth2.googleapis.com/token',private_key:`${delimiter('BEGIN')}\n${pem}\n${delimiter('END')}\n`});
}

async function fixture(t) {
  t.mock.method(Date,'now',()=>NOW);
  const own=sqliteStorage(),source=sourceBinding(),background=[],alarms=[];
  const env={DB:source.binding,GOOGLE_SERVICE_ACCOUNT_JSON:await serviceAccount(),GOOGLE_SPREADSHEET_ID:ID,
    TG_WEBHOOK_SECRET:secret,TELEGRAM_TEST_CHAT_ID:'-1001',TELEGRAM_BOT_USERNAME:'OfflineTest_bot',
    TELEGRAM_BOT_TOKEN:token,TELEGRAM_WEBHOOK_ENABLED:'true',SHEETS_SCHEDULE_ENABLED:'true'};
  const ctx={storage:{sql:own.sql,async setAlarm(at){alarms.push(at);}},
    blockConcurrencyWhile:fn=>fn(),waitUntil:p=>background.push(p)};
  const sheet={values:[],writes:0,reads:0},telegram=[];let gate=null;
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    const parsed=new URL(url);
    if(parsed.origin==='https://oauth2.googleapis.com')return Response.json({access_token:'offline_access_value',token_type:'Bearer',expires_in:3600});
    if(parsed.origin==='https://sheets.googleapis.com') {
      if(options.method==='POST') {
        sheet.writes++;
        if(gate)await gate.promise;
        const body=JSON.parse(options.body);
        sheet.values=body.requests.find(r=>r.updateCells).updateCells.rows.map(r=>r.values.map(v=>v.userEnteredValue.stringValue));
        return Response.json({spreadsheetId:ID,replies:body.requests.map(()=>({}))});
      }
      sheet.reads++;
      return Response.json({spreadsheetId:ID,sheets:[{properties:{sheetId:0,title:'AVAILABLE',gridProperties:{rowCount:1000,columnCount:5}},
        data:[{startRow:0,startColumn:0,rowData:sheet.values.map(row=>({values:row.map(v=>({userEnteredValue:{stringValue:v}}))}))}]}]});
    }
    assert.equal(parsed.origin,'https://api.telegram.org');
    assert.equal(parsed.pathname,`/bot${token}/sendMessage`);
    const payload=JSON.parse(options.body);telegram.push(payload);
    return Response.json({ok:true,result:{message_id:telegram.length,chat:{id:-1001}}});
  });
  let instance=new SheetsCoordinator(ctx,env);await instance.ready;
  env.SHEETS_COORDINATOR={idFromName(name){assert.equal(name,'AVAILABLE-v1');return name;},get(){return{fetch:r=>instance.fetch(r)}}};
  t.after(()=>{source.db.close();own.db.close();});
  const request=(id=1,{chat=-1001,auth=secret,text='/available'}={})=>new Request('https://sheets.test/telegram/webhook',{
    method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':auth},
    body:JSON.stringify({update_id:id,message:{chat:{id:chat,type:'supergroup'},from:{id:7,is_bot:false},text}})});
  return{env,ctx,sheet,telegram,source,alarms,request,
    get instance(){return instance;},
    setGate(value){gate=value;},
    async drain(){while(background.length)await Promise.all(background.splice(0));},
    async restart(){instance=new SheetsCoordinator(ctx,env);await instance.ready;},
    assertReadOnly(){
      // serialize() internally uses a backup operation, not the application SQL
      // read path. Keep the authorizer for every request, then lift it only to
      // compare the entire database after all processing has finished.
      source.db.setAuthorizer(null);
      assert.deepEqual(Buffer.from(source.db.serialize()),source.before);
    }};
}

test('phase1 config matches existing binding and has no live cron/webhook; 16 UTC/JST ticks including new year',()=>{
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(config.name,'bot-datsan-sheets');assert.equal(config.vars.SHEETS_SCHEDULE_ENABLED,'false');
  assert.equal(config.vars.TELEGRAM_WEBHOOK_ENABLED,'false');assert.deepEqual(config.triggers.crons,[]);
  assert.equal(config.d1_databases[0].binding,'DB');
  assert.equal(config.d1_databases[0].database_id,'b0e8dfdb-42d6-410c-b950-e3fd31710c11');
  assert.deepEqual(config.migrations,[{tag:'sheets-coordinator-v1',new_sqlite_classes:['SheetsCoordinator']}]);
  assert.equal(SHEETS_CRON,'10 0-13,22-23 * * *');
  const times=[];
  for(const h of [...Array(14).keys(),22,23]){
    const ms=Date.UTC(2026,11,31,h,10);
    assert.equal(validScheduledEvent({cron:SHEETS_CRON,scheduledTime:ms},ms+1),true);
    times.push(new Date(ms+9*3600000).toISOString());
  }
  assert.equal(times.length,16);
  assert.equal(times.filter(v=>v.startsWith('2027-01-01')).length,2);
  const jst=times.map(v=>v.slice(11,16)).sort();
  assert.equal(jst[0],'07:10');assert.equal(jst.at(-1),'22:10');
  for(const iso of ['2026-11-04T21:10:00Z','2026-11-05T14:10:00Z','2026-11-05T15:10:00Z']){
    const ms=Date.parse(iso);assert.equal(validScheduledEvent({cron:SHEETS_CRON,scheduledTime:ms},ms+1),false);
  }
  assert.equal(validScheduledEvent({cron:SHEETS_CRON,scheduledTime:NOW},NOW),false); // minute02
  const last=Date.parse('2026-11-05T22:10:00+09:00');
  assert.equal(validScheduledEvent({cron:SHEETS_CRON,scheduledTime:last},last+59999),true);
  assert.equal(validScheduledEvent({cron:SHEETS_CRON,scheduledTime:last},last+60000),false);
  assert.equal(validScheduledEvent({cron:SHEETS_CRON,scheduledTime:last},NaN),false);
});

test('webhook acknowledges durable inbox without waiting for Google; confirmed reply and sheet have no D1 writes',async t=>{
  const f=await fixture(t),gate=deferred();f.setGate(gate);
  const response=await worker.fetch(f.request(),f.env);
  assert.equal(response.status,200);
  assert.ok(f.instance.store.getUpdate(1));assert.equal(f.telegram.length,0);
  gate.resolve();await f.drain();
  assert.equal(f.sheet.writes,1);assert.equal(f.telegram.length,1);
  assert.equal(f.instance.store.getUpdate(1).state,'SENT');
  assert.equal(f.source.calls,1);f.assertReadOnly();
  assert.equal(f.sheet.values[5][1],'14');assert.equal(f.sheet.values[9][0],'T5');
  assert.match(f.telegram[0].text,/14 slot AVAILABLE/);
  assert.ok(!f.telegram[0].text.includes('08:00–10:00'));
});

test('duplicate Telegram updates, new members and scheduled sync share one write; restart preserves receipt',async t=>{
  const f=await fixture(t),gate=deferred();f.setGate(gate);
  const responses=await Promise.all([worker.fetch(f.request(1),f.env),worker.fetch(f.request(1),f.env),worker.fetch(f.request(2),f.env)]);
  assert.ok(responses.every(r=>r.status===200));
  const scheduled=f.instance.fetch(new Request('https://coordinator.internal/sync',{method:'POST'}));
  gate.resolve();await f.drain();await scheduled;
  assert.equal(f.sheet.writes,1);assert.equal(f.telegram.length,2);
  await f.restart();await worker.fetch(f.request(1),f.env);await f.drain();
  assert.equal(f.telegram.length,2);assert.equal(f.sheet.writes,1);f.assertReadOnly();
});

test('invalid webhook secret/chat/command cannot reach coordinator; public sync endpoint unavailable',async t=>{
  const f=await fixture(t);
  assert.equal((await worker.fetch(f.request(1,{auth:'wrong_secret'}),f.env)).status,403);
  assert.equal((await worker.fetch(f.request(1,{chat:-2222}),f.env)).status,403);
  assert.equal((await worker.fetch(f.request(1,{text:'/available@Different_bot'}),f.env)).status,200);
  assert.equal((await worker.fetch(new Request('https://sheets.test/sync',{method:'POST'}),f.env)).status,404);
  assert.equal(f.instance.store.getUpdate(1),null);assert.equal(f.source.calls,0);assert.equal(f.sheet.reads,0);
  assert.equal(f.telegram.length,0);
});

test('persisted PENDING update survives alarm registration failure; retry wakes it once',async t=>{
  const f=await fixture(t);let failed=false;
  const real=f.ctx.storage.setAlarm;
  f.ctx.storage.setAlarm=async at=>{if(!failed){failed=true;throw new Error('offline alarm failure');}return real(at);};
  assert.equal((await worker.fetch(f.request(),f.env)).status,503);
  assert.equal(f.instance.store.getUpdate(1).state,'PENDING');assert.equal(f.telegram.length,0);
  assert.equal((await worker.fetch(f.request(),f.env)).status,200);await f.drain();
  assert.equal(f.telegram.length,1);assert.equal(f.sheet.writes,1);f.assertReadOnly();
});

test('pending accepted update recovers after restart; interrupted Telegram send never resends',async t=>{
  const f=await fixture(t);
  f.instance.store.accept({updateId:5,chatId:'-1001',receivedAt:NOW-16000,deadlineAt:NOW-1000});
  await f.restart();await f.instance.alarm();
  assert.equal(f.telegram.length,1);assert.match(f.telegram[0].text,/Không thể xác nhận cập nhật/);
  assert.equal(f.sheet.writes,0);
  f.instance.store.accept({updateId:6,chatId:'-1001',receivedAt:NOW,deadlineAt:NOW+15000});
  f.instance.store.claimUpdate(6);f.instance.store.claimReply(6);
  await f.restart();await worker.fetch(f.request(6),f.env);await f.drain();await f.instance.alarm();
  assert.equal(f.instance.store.getUpdate(6).state,'UNCERTAIN');assert.equal(f.telegram.length,1);
});

test('alarm does not spin on WORKING and scheduled handler never replies to Telegram',async t=>{
  const f=await fixture(t);
  f.instance.store.accept({updateId:1,chatId:'-1001',receivedAt:NOW-16000,deadlineAt:NOW-1000});
  f.instance.store.claimUpdate(1);const before=f.alarms.length;
  await f.instance.alarm();assert.equal(f.alarms.length,before);
  t.mock.method(Date,'now',()=>Date.parse('2026-11-05T07:10:00+09:00'));
  const logs=[];t.mock.method(console,'log',v=>logs.push(JSON.parse(v)));
  let noRetry=false;
  await worker.scheduled({cron:SHEETS_CRON,scheduledTime:Date.now(),noRetry(){noRetry=true;}},f.env);
  assert.equal(noRetry,true);assert.equal(f.telegram.length,0);assert.equal(f.sheet.writes,1);
  assert.equal(logs[0].status,'UPDATED');f.assertReadOnly();
});

test('disabled Phase1 flags prevent both webhook work and scheduled sync',async t=>{
  const f=await fixture(t);f.env.TELEGRAM_WEBHOOK_ENABLED='false';f.env.SHEETS_SCHEDULE_ENABLED='false';
  assert.equal((await worker.fetch(f.request(),f.env)).status,404);
  await worker.scheduled({cron:SHEETS_CRON,scheduledTime:NOW,noRetry(){}},f.env);
  assert.equal(f.source.calls,0);assert.equal(f.sheet.reads,0);assert.equal(f.telegram.length,0);
});
