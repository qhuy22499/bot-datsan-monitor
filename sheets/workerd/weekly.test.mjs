// Ubuntu actual workerd + D1 + SQLite DO. Every network response is an offline fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import * as esbuild from '../../worker/node_modules/esbuild/lib/main.js';
import * as miniflare from '../../worker/node_modules/miniflare/dist/src/index.js';
const now=Date.parse('2026-11-09T08:35:00+09:00');const at=now-300000;
const stamp='2026-11-09T08:33:00+09:00',trigger='cfbooking-'+at;
const secret='offline_test_only_shared_01234567890123';
test('actual DO/D1: historical receipts, command dedup, Monday proof, restart uncertain, business DB read only',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'datsan-weekly-'));let mf;
 try{
  const index=fileURLToPath(new URL('../src/index.mjs',import.meta.url));
  const entry=join(dir,'entry.mjs'),bundle=join(dir,'bundle.mjs');
  writeFileSync(entry,`import worker,{SheetsCoordinator} from ${JSON.stringify(index)};
    export class FixtureCoordinator extends SheetsCoordinator {
      async fetch(r){await this.ready;const p=new URL(r.url).pathname;
        if(p==='/__drain'){await Promise.all([...this.activeUpdates.values()]);return Response.json({ok:true});}
        if(p==='/__seed'){this.store.accept({updateId:1,chatId:'-1001',command:'available',receivedAt:${now},deadlineAt:${now+15000}});this.store.claimUpdate(1);this.store.claimReply(1);this.store.finishUpdate(1,'SENT',{messageId:10});this.store.weeklyIntent('WEEKLY_BOOKINGS:2026-11-02',{});this.store.weeklyClaim('WEEKLY_BOOKINGS:2026-11-02');return Response.json({ok:true});}
        return super.fetch(r);
      }
    }
    export default {async fetch(r,e){Date.now=()=>${now};if(new URL(r.url).pathname.startsWith('/__'))return e.SHEETS_COORDINATOR.get(e.SHEETS_COORDINATOR.idFromName('AVAILABLE-v1')).fetch(r);return worker.fetch(r,e);}};`);
  await esbuild.build({entryPoints:[entry],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  // v5 converter otherwise names /tmp bundle relative to repo cwd with ../,
  // which workerd rejects as escaping its module root (kj/filesystem.c++319).
  const options={name:'weekly-fixture',modulesRoot:dir,modules:[{type:'ESModule',path:bundle}],compatibilityDate:'2025-10-01',
    d1Databases:{DB:'00000000-0000-0000-0000-000000000001'},durableObjects:{SHEETS_COORDINATOR:{className:'FixtureCoordinator',useSQLite:true}},
    bindings:{TG_WEBHOOK_SECRET:secret,BOOKED_SYNC_SECRET:secret,BOOKING_CRON_SIGNING_SECRET:secret,GOOGLE_SPREADSHEET_ID:'offline_spreadsheet_identifier_only',TELEGRAM_BOT_USERNAME:'BotDatSan_bot',TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_TEST_CHAT_ID:'-1001',TELEGRAM_BOT_TOKEN:['123456789',':','OFFLINE_ONLY_'.repeat(4)].join('')},
    outboundService:async request=>{
      assert(new URL(request.url).origin==='https://api.telegram.org');sends++;
      return Response.json({ok:true,result:{message_id:100+sends,chat:{id:-1001}}});
    }};
  let sends=0;
  const convert=o=>miniflare.convertV4MiniflareOptions?miniflare.convertV4MiniflareOptions(o):o;
  mf=new miniflare.Miniflare(convert(options));let db=await mf.getD1Database('DB');
  for(const name of ['0001_monitor.sql','0002_notification_v2.sql','0003_bookings.sql']){
    const sql=readFileSync(new URL('../../worker/migrations/'+name,import.meta.url),'utf8').replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean);
    await db.batch(sql.map(s=>db.prepare(s)));
  }
  await db.prepare('INSERT INTO booking_runs VALUES(?,?)').bind(trigger,'2026-11-09T08:30:30+09:00').run();
  for(const g of ['A','B','C']){
    await db.prepare("INSERT INTO booking_attempts VALUES(?,?,'COMPLETE','VERIFIED',?,1,1)").bind(trigger,g,stamp).run();
    await db.prepare("UPDATE booking_groups SET display_name=?,last_success_at=?,last_attempt_at=?,sync_status='COMPLETE',code='VERIFIED' WHERE group_alias=?").bind('ＦＣ　'+g,stamp,stamp,g).run();
  }
  await db.prepare("INSERT INTO bookings VALUES(?,'A','12345','2026-11-11','20:30','22:30','A','CONFIRMED','UNPAID','支払前',?,1,?)").bind('a'.repeat(64),stamp,trigger).run();
  const before=await db.prepare('SELECT * FROM bookings').all();
  const post=(path,body={},headers={})=>mf.dispatchFetch('https://sheets.test'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  await post('/__seed');
  const update={update_id:2,message:{text:'/bookings@BotDatSan_bot',from:{is_bot:false},chat:{id:-1001,type:'supergroup'}}};
  assert.equal((await post('/telegram/webhook',update,{'X-Telegram-Bot-Api-Secret-Token':secret})).status,200);await post('/__drain');
  assert.equal(sends,1);await post('/telegram/webhook',update,{'X-Telegram-Bot-Api-Secret-Token':secret});await post('/__drain');assert.equal(sends,1);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('BOOKING_CRON_V1:'+trigger))).toString('hex');
  const input={trigger_id:trigger,signature,sheets_status:'FAILED'},auth={Authorization:'Bearer '+secret};
  assert.equal((await (await post('/booked/weekly',input,auth)).json()).status,'SENT');assert.equal(sends,2);
  await mf.setOptions(convert({...options,bindings:{...options.bindings,TEST_EPOCH:'restart'}}));
  db=await mf.getD1Database('DB'); // Old runtime stubs are intentionally poisoned on restart.
  assert.equal((await (await post('/booked/weekly',input,auth)).json()).status,'SENT');assert.equal(sends,2);
  const receipts=await(await post('/booked/receipts',{},auth)).json();
  assert.equal(receipts.inbox.find(r=>r.updateId===1).messageId,10);assert.equal(receipts.inbox.find(r=>r.updateId===2).command,'bookings_current');
  assert.equal(receipts.weekly.find(r=>r.id==='WEEKLY_BOOKINGS:2026-11-02').state,'UNCERTAIN');
  assert.deepEqual((await db.prepare('SELECT * FROM bookings').all()).results,before.results);
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
 }finally{if(mf)await mf.dispose();rmSync(dir,{recursive:true,force:true});}
});
