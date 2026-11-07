import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {weekBounds,bookingsMessage} from '../src/bookings-message.mjs';
import {WeeklyNotifications,scheduledMonday,readWeekly,WEEKLY_SQL} from '../src/weekly.mjs';
import {projectBooked,BOOKED_SQL} from '../src/booked.mjs';
import {CoordinatorStore} from '../src/store.mjs';
import {parseWebhook,TelegramError} from '../src/telegram.mjs';
import worker,{SheetsCoordinator} from '../src/index.mjs';
const MONDAY=Date.parse('2026-11-09T08:35:00+09:00');
const AT=Date.parse('2026-11-09T08:30:00+09:00'),trigger='cfbooking-'+AT;
const signatureSecret='offline_test_only_signing_012345678901';
const sid='offline_spreadsheet_identifier_only';
const auth='offline_test_only_webhook_012345678901';
const stamp='2026-11-09T08:33:00+09:00';
const envBase={TELEGRAM_TEST_CHAT_ID:'-1001',GOOGLE_SPREADSHEET_ID:sid,TELEGRAM_BOT_USERNAME:'BotDatSan_bot',TG_WEBHOOK_SECRET:auth,TELEGRAM_WEBHOOK_ENABLED:'true',BOOKING_CRON_SIGNING_SECRET:signatureSecret};
const groups=()=>['A','B','C'].map(group=>({group,status:'COMPLETE',lastSuccess:stamp,lastAttempt:stamp,displayName:'ＦＣ　'+group,code:'VERIFIED'}));
const row=(group='A',day='2026-11-11',start='20:30',court='A')=>({id:crypto.randomUUID(),group,day,start,end:start==='18:30'?'20:30':'22:30',court,observedAt:stamp});
const snapshot=()=>({groups:groups(),rows:[row('A'),row('B','2026-11-14','18:30','B'),row('C','2026-11-15'),row('A','2026-11-14','20:30','A')]});
const data=(s=snapshot(),now=MONDAY)=>({status:'READ',...projectBooked(s,now)});
function ownStore(db=new DatabaseSync(':memory:')){
 const sql={exec(text,...args){const s=db.prepare(text);const rows=s.columns().length?s.all(...args):(s.run(...args),[]);return{toArray:()=>rows};}};
 return{db,sql,store:new CoordinatorStore(sql)};
}
async function sign(t=trigger){const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(signatureSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return Buffer.from(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode('BOOKING_CRON_V1:'+t))).toString('hex');}
const request=(text,id=1,chat=-1001,secret=auth)=>new Request('https://sheets.test/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:id,message:{text,chat:{id:chat,type:'supergroup'},from:{id:11,is_bot:false}}})});

test('current/next week uses JST Monday through Sunday, month/year boundaries',()=>{
 assert.deepEqual(weekBounds(Date.parse('2026-11-08T23:59:00+09:00')),{start:'2026-11-02',end:'2026-11-08'});
 assert.deepEqual(weekBounds(MONDAY),{start:'2026-11-09',end:'2026-11-15'});
 assert.deepEqual(weekBounds(MONDAY,1),{start:'2026-11-16',end:'2026-11-22'});
 assert.deepEqual(weekBounds(Date.parse('2026-12-31T23:59:00+09:00')),{start:'2026-12-28',end:'2027-01-03'});
 assert.deepEqual(weekBounds(Date.parse('2026-11-30T08:00:00+09:00')),{start:'2026-11-30',end:'2026-12-06'});
});
test('format sorted ISO/time/court/group, unique days, no sensitive fields, next week and true zero',()=>{
 const s=snapshot();s.rows.reverse();s.rows.push(row('B','2026-11-18'));
 const message=bookingsMessage(data(s),sid,{now:MONDAY});
 assert.equal(message.total,4);assert.equal(message.days,3);assert(message.text.includes('T4 11/11/2026'));
 assert(message.text.indexOf('18:30–20:30')<message.text.indexOf('T7 14/11/2026 · 20:30'));
 assert(!message.text.includes('reservation'));assert(!message.text.includes('payment'));assert(!message.text.includes('/3'));
 assert.equal(bookingsMessage(data(s),sid,{now:MONDAY,offset:1}).total,1);
 const zero=bookingsMessage(data({groups:groups(),rows:[]}),sid,{now:MONDAY});assert.equal(zero.days,0);assert(zero.text.includes('chưa có lịch sân'));
});
test('FAILED/PARTIAL keeps verified old rows, never calls incomplete zero complete; source error is not zero',()=>{
 for(const status of ['FAILED','PARTIAL']){
  const s=snapshot();s.groups[2].status=status;s.groups[2].lastSuccess='2026-11-08T08:33:00+09:00';s.rows.find(r=>r.group==='C').observedAt=s.groups[2].lastSuccess;
  const m=bookingsMessage(data(s),sid,{now:MONDAY});assert(m.text.includes('Group C: '+status));assert(m.text.includes('15/11/2026'));assert(!m.complete);assert(m.text.includes('cũ'));
  s.rows=[];assert(!bookingsMessage(data(s),sid,{now:MONDAY}).text.includes('Hiện chưa có lịch sân'));
 }
 const bad=bookingsMessage({status:'FAILED'},sid,{now:MONDAY});assert.equal(bad.total,null);assert(bad.text.includes('Không thể xác minh'));
});
test('ended slots excluded and 4096 UTF-16 budget has hidden count and BOOKED link, not spam pages',()=>{
 const s=snapshot();s.rows.push({...row('A','2026-11-09'),start:'06:00',end:'07:00'});
 assert.equal(bookingsMessage(data(s),sid,{now:MONDAY}).total,4);
 s.rows=Array.from({length:1000},(_,i)=>row('ABC'[i%3],'2026-11-11',i%2?'18:30':'20:30',i%2?'A':'B'));
 const m=bookingsMessage(data(s),sid,{now:MONDAY});assert(m.text.length<=4096);assert(m.hidden>0);assert.equal(m.shown+m.hidden,1000);assert(m.text.includes('BOOKED!A1:E'));
});
test('parser accepts only bookings current/next targeted commands, rejects wrong chat/auth and malformed args',async()=>{
 for(const [text,command] of [['/bookings','bookings_current'],['/bookings next','bookings_next'],['/bookings@BotDatSan_bot','bookings_current'],['/bookings@BotDatSan_bot next','bookings_next'],['/available','available'],['/priority','priority']])assert.equal((await parseWebhook(request(text),envBase)).command,command);
 for(const text of ['/bookings next extra','/bookings@Another_bot','/priority next','/available next','/bookings previous'])assert.equal(await parseWebhook(request(text),envBase),null);
 await assert.rejects(parseWebhook(request('/bookings',1,-2001),envBase));await assert.rejects(parseWebhook(request('/bookings',1,-1001,'wrong'),envBase));
});
test('existing inbox receipts unchanged; routing persists through claim/finish/restart/UNCERTAIN without schema rebuild',()=>{
 const f=ownStore();try{
  for(const [id,command] of [[1,'available'],[2,'priority'],[3,'bookings_current'],[4,'bookings_next']]){
   f.store.accept({updateId:id,chatId:'-1001',command,receivedAt:MONDAY,deadlineAt:MONDAY+15000});
   assert.equal(f.store.claimUpdate(id).command,command);assert(f.store.claimReply(id));
   if(id<4)f.store.finishUpdate(id,'SENT',{messageId:id});
  }
  const previous=f.store.getUpdate(1);const restarted=new CoordinatorStore(f.sql);restarted.recover();
  assert.deepEqual(restarted.getUpdate(1),previous);assert.equal(restarted.getUpdate(3).command,'bookings_current');assert.equal(restarted.getUpdate(4).command,'bookings_next');assert.equal(restarted.getUpdate(4).state,'UNCERTAIN');
  assert(!restarted.accept({updateId:3,chatId:'-1001',command:'bookings_next',receivedAt:MONDAY,deadlineAt:MONDAY+15000}).accepted);
  assert.equal(restarted.getUpdate(3).command,'bookings_current');
 }finally{f.db.close();}
});
test('scheduled proof requires Monday JST, authentic HMAC and D1 terminal attempts, not just manual Monday',async()=>{
 assert.equal(new Date(AT).getUTCDay(),0);assert(scheduledMonday(trigger,MONDAY));
 assert.equal(scheduledMonday('cfbooking-'+(AT+86400000),MONDAY+86400000),null);
 const f=ownStore();let reads=0,sends=0;
 const manager=new WeeklyNotifications({store:f.store,env:envBase,clock:()=>MONDAY,read:async()=>{reads++;return data();},send:async()=>{sends++;return{messageId:99};}});
 try{
  for(const signature of ['', 'a'.repeat(64)])assert.equal((await manager.deliver({trigger_id:trigger,signature,sheets_status:'UPDATED'})).status,'REJECTED');
  assert.equal(reads,0);assert.equal(sends,0);
  const valid={trigger_id:trigger,signature:await sign(),sheets_status:'FAILED'};
  let sentText;manager.send=async(e,c,text)=>{sends++;sentText=text;assert.equal(f.store.weekly('WEEKLY_BOOKINGS:2026-11-09').state,'IN_FLIGHT');return{messageId:99};};
  const replies=await Promise.all([manager.deliver(valid),manager.deliver(valid)]);
  assert.equal(sends,1);assert(sentText.includes('Chưa xác nhận cập nhật BOOKED'));assert(replies.some(r=>r.status==='SENT'));
  assert.equal((await manager.deliver(valid)).duplicate,true);
  new CoordinatorStore(f.sql).recover();assert.equal((await manager.deliver(valid)).status,'SENT');assert.equal(sends,1);
 }finally{f.db.close();}
});
test('weekly lost receipt and interrupted IN_FLIGHT remain UNCERTAIN through restart, never retry FAILED either',async()=>{
 for(const ambiguous of [false,true]){
  const f=ownStore();let sends=0;
  const m=new WeeklyNotifications({store:f.store,env:envBase,clock:()=>MONDAY,read:async()=>data(),send:async()=>{sends++;throw new TelegramError('TELEGRAM_SEND_TIMEOUT',{ambiguous});}});
  try{
   const input={trigger_id:trigger,signature:await sign(),sheets_status:'UPDATED'};
   assert.equal((await m.deliver(input)).status,ambiguous?'UNCERTAIN':'FAILED');
   f.store.recover();await m.deliver(input);assert.equal(sends,1);
  }finally{f.db.close();}
 }
 const f=ownStore();try{
  f.store.weeklyIntent('WEEKLY_BOOKINGS:2026-11-09',{});f.store.weeklyClaim('WEEKLY_BOOKINGS:2026-11-09');f.store.recover();
  assert.equal(f.store.weekly('WEEKLY_BOOKINGS:2026-11-09').state,'UNCERTAIN');
 }finally{f.db.close();}
});
test('readWeekly single SELECT validates completed run/lease/groups; incomplete cannot consume receipt',async()=>{
 const s=snapshot();let record={groups_json:JSON.stringify(s.groups),rows_json:JSON.stringify(s.rows),attempts_json:JSON.stringify(groups().map(g=>({group:g.group,status:g.status,observedAt:stamp}))),run_started:'2026-11-09T08:30:30+09:00',lease_expires:0};
 const db={withSession:()=>({prepare:sql=>{assert.equal(sql,WEEKLY_SQL);assert(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i.test(sql));return{bind:(...args)=>{assert.deepEqual(args,[trigger,trigger]);return{first:async()=>record};}};}})};
 assert.equal((await readWeekly(db,trigger,MONDAY)).status,'READ');
 record.lease_expires=MONDAY+1;await assert.rejects(readWeekly(db,trigger,MONDAY));record.lease_expires=0;
 record.attempts_json=JSON.stringify([{group:'A',status:'STARTED'}]);await assert.rejects(readWeekly(db,trigger,MONDAY));
});

test('weekly incomplete/zero/unverified source has truthful warning, one warning consumes the week',async()=>{
 for(const mode of ['PARTIAL','ZERO','UNVERIFIED']){
  const f=ownStore();let text='',sends=0;const s=snapshot();s.groups[2].status='PARTIAL';
  const read=mode==='PARTIAL'?data(s):mode==='ZERO'?data({groups:groups(),rows:[]}):{status:'UNVERIFIED',groups:groups().map(g=>({...g,status:'FAILED',lastSuccess:null}))};
  const m=new WeeklyNotifications({store:f.store,env:envBase,clock:()=>MONDAY,read:async()=>read,send:async(e,c,t)=>{text=t;sends++;return{messageId:7};}});
  try{
   const input={trigger_id:trigger,signature:await sign(),sheets_status:'UPDATED'};
   assert.equal((await m.deliver(input)).status,'SENT');await m.deliver(input);assert.equal(sends,1);
   if(mode==='PARTIAL')assert(text.includes('Group C: PARTIAL'));
   if(mode==='ZERO')assert(text.includes('chưa có lịch sân'));
   if(mode==='UNVERIFIED'){assert(text.includes('Không thể xác minh'));assert(text.includes('Group C: FAILED'));assert(!text.includes('Tổng: 0'));}
  }finally{f.db.close();}
 }
 const f=ownStore();try{
  const m=new WeeklyNotifications({store:f.store,env:envBase,clock:()=>MONDAY,read:async()=>{throw Object.assign(new Error(),{code:'BOOKING_RUN_NOT_FINISHED'});},send:async()=>{throw new Error('NO_SEND');}});
  assert.equal((await m.deliver({trigger_id:trigger,signature:await sign(),sheets_status:'UPDATED'})).status,'REJECTED');
  assert.equal(f.store.weekly('WEEKLY_BOOKINGS:2026-11-09'),null);
 }finally{f.db.close();}
});

test('bookings source failure and lost Telegram response survive duplicate/restart without a false zero',async t=>{
 t.mock.method(Date,'now',()=>MONDAY);const f=ownStore(),background=[];let sends=0;
 const env={...envBase,DB:{withSession:()=>({prepare:()=>({first:async()=>{throw new Error('OFFLINE_D1_FAILURE');}})})},TELEGRAM_BOT_TOKEN:['123456789',':','OFFLINE_ONLY_'.repeat(4)].join('')};
 const ctx={storage:{sql:f.sql,setAlarm:async()=>{}},blockConcurrencyWhile:fn=>fn(),waitUntil:p=>background.push(p)};
 const object=new SheetsCoordinator(ctx,env);env.SHEETS_COORDINATOR={idFromName:n=>n,get:()=>({fetch:r=>object.fetch(r)})};
 t.mock.method(globalThis,'fetch',async(url,init)=>{sends++;assert(JSON.parse(init.body).text.includes('Không thể xác minh'));throw new Error('lost response');});
 try{
  await worker.fetch(request('/bookings',23),env);await Promise.all(background);
  assert.equal(f.store.getUpdate(23).state,'UNCERTAIN');assert.equal(f.store.getUpdate(23).result.total,null);
  f.store.recover();await worker.fetch(request('/bookings',23),env);await Promise.all(background);assert.equal(sends,1);
 }finally{f.db.close();}
});

test('real webhook/DO bookings duplicate and timeout use D1 only; no Google/website calls',async t=>{
 t.mock.method(Date,'now',()=>MONDAY);const f=ownStore(),background=[];let sends=0;
 const s=snapshot();const env={...envBase,DB:{withSession:()=>({prepare:sql=>{assert.equal(sql,BOOKED_SQL);return{first:async()=>({groups_json:JSON.stringify(s.groups),rows_json:JSON.stringify(s.rows)})};}})},TELEGRAM_BOT_TOKEN:['123456789',':','OFFLINE_ONLY_'.repeat(4)].join('')};
 const ctx={storage:{sql:f.sql,setAlarm:async()=>{}},blockConcurrencyWhile:fn=>fn(),waitUntil:p=>background.push(p)};
 const object=new SheetsCoordinator(ctx,env);env.SHEETS_COORDINATOR={idFromName:n=>n,get:()=>({fetch:r=>object.fetch(r)})};
 t.mock.method(globalThis,'fetch',async(url,init)=>{assert(String(url).startsWith('https://api.telegram.org/'));sends++;const body=JSON.parse(init.body);assert(body.text.includes('LỊCH SÂN TUẦN'));return Response.json({ok:true,result:{message_id:44,chat:{id:-1001}}});});
 try{
  assert.equal((await worker.fetch(request('/bookings',12),env)).status,200);await Promise.all(background);assert.equal(sends,1);
  assert.equal((await worker.fetch(request('/bookings',12),env)).status,200);await Promise.all(background);assert.equal(sends,1);assert.equal(f.store.getUpdate(12).command,'bookings_current');
  await worker.fetch(request('/bookings next',13),env);await Promise.all(background);assert.equal(sends,2);assert.equal(f.store.getUpdate(13).result.total,0);
 }finally{f.db.close();}
});
