// Actual local workerd + D1 binding. No Cloudflare account or remote requests.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as miniflare from 'miniflare';
import {startD1} from './engine.mjs';
const SECRET='offline_test_only_01234567890123456789';
const OWNER='11111111-1111-4111-8111-111111111111';
const id=n=>n.toString(16).padStart(32,'0');
const stamp=ms=>new Date(ms+9*3600000).toISOString().slice(0,19)+'+09:00';

test('actual D1 harness resolves wrapper imports and persists across restart',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'datsan-d1-restart-'));
 let engine;
 try {
  const now=Date.now();
  const call=async()=>{
   const response=await engine.fetch('/v1/acquire',{now,headers:{'Content-Type':'application/json','Authorization':'Bearer '+SECRET},body:JSON.stringify({owner:OWNER,destination:'-1001'})});
   assert.equal(response.status,200);return response.json();
  };
  engine=await startD1(directory);
  const first=await call();assert(first.ok);
  await engine.db.prepare('UPDATE lease SET expires=0 WHERE id=1').run();
  await engine.close();engine=null;
  engine=await startD1(directory);
  const second=await call();assert(second.ok);assert(second.fence>first.fence);
  assert.equal((await engine.db.prepare('SELECT destination FROM source WHERE id=1').first()).destination,'-1001');
 } finally {if(engine)await engine.close();rmSync(directory,{recursive:true,force:true});}
});
test('workerd/D1 local: migration, commit, concurrency, receipt, rollback, lease fencing',async t=>{
 const options={modules:true,scriptPath:new URL('../src/index.mjs',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),compatibilityDate:'2025-10-01',d1Databases:['DB'],bindings:{API_SECRET:SECRET}};
 const mf=new miniflare.Miniflare(miniflare.convertV4MiniflareOptions ? miniflare.convertV4MiniflareOptions(options) : options);
 try {
  const db=await mf.getD1Database('DB');
  const migration=readFileSync(new URL('../migrations/0001_monitor.sql',import.meta.url),'utf8').replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean);
  await db.batch(migration.map(s=>db.prepare(s)));
  await db.batch(migration.map(s=>db.prepare(s)));
  const additive=readFileSync(new URL('../migrations/0002_notification_v2.sql',import.meta.url),'utf8').replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean);
  await db.batch(additive.map(s=>db.prepare(s)));
  const call=async(name,p)=>{
   const response=await mf.dispatchFetch('https://storage.test/v1/'+name,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+SECRET},body:JSON.stringify(p)});
   return {http:response.status,...await response.json()};
  };
  const acquired=await call('acquire',{owner:OWNER,destination:'-1001'});assert(acquired.ok);
  const auth={owner:OWNER,fence:acquired.fence};
  const started=Date.now()-1000;const day=stamp(started).slice(0,10);const next=new Date(Date.parse(day)+86400000).toISOString().slice(0,10);
  const times=[['08:00','10:00'],['10:00','12:00'],['12:00','14:00'],['14:00','16:00'],['16:00','18:00'],['18:30','20:30'],['20:30','22:30']];
  const slots=[];for(const d of [day,next])for(const c of ['A','B'])for(const [a,b] of times)slots.push({id:`${d}:${c}:${a}:${b}`,day:d,court:c,start:a,end:b,status:d===next && a==='20:30'?'AVAILABLE':'GENERAL_RESERVED',observed_at:stamp(started),in_scope:1,scan_id:id(1)});
  const opps=slots.filter(s=>s.status==='AVAILABLE').map((s,i)=>({id:id(i+2),slot_id:s.id,state:'ACTIVE',origin:'BASELINE',reason:'AVAILABLE',created_scan:id(1),updated_at:stamp(started)}));
  const p={...auth,expected_revision:0,scan:{id:id(1),started_at:stamp(started),finished_at:stamp(started),status:'COMPLETE',reason:'VERIFIED',window_start:day,window_end:next,days:2,cells:28},baseline:'NOTIFY',slots,opportunities:opps,batches:[{id:id(4),kind:'INITIAL',revision:1,message_id:null,scan_id:id(1)}],members:opps.map((o,i)=>({opportunity_id:o.id,batch_id:id(4),ordinal:i+1,delivery:'PENDING'})),jobs:[{id:id(5),batch_id:id(4),revision:1,kind:'SEND',text:'TEST local only'}],transitions:[],execution_allowed:false,auto_booking_allowed:false};
  await t.test('guarded commit and primary snapshot',async()=>{assert((await call('commit',p)).ok);const s=await call('snapshot',auth);assert.equal(s.slots.length,28);assert.equal(s.members.length,2);assert.equal(s.source.revision,1);});
  await t.test('two concurrent HTTP claims have one winner',async()=>{const responses=await Promise.all([call('claim',{...auth,job_id:id(5)}),call('claim',{...auth,job_id:id(5)})]);assert.equal(responses.filter(r=>r.job!==null).length,1);});
  await t.test('receipt is atomic and FK/integrity hold',async()=>{assert((await call('receipt',{...auth,job_id:id(5),status:'SENT',message_id:99,error_code:null})).ok);const s=await call('snapshot',auth);assert.equal(s.jobs[0].status,'SENT');assert.equal(s.batches[0].message_id,99);assert(s.members.every(m=>m.delivery==='SENT'));const fk=await db.prepare('PRAGMA foreign_key_check').all();assert.equal(fk.results.length,0);const integrity=await db.prepare('PRAGMA quick_check').all();assert(Object.values(integrity.results[0]).includes('ok'));});
  await t.test('unique/FK constraints and mid-batch rollback',async()=>{
    await assert.rejects(db.prepare('INSERT INTO members VALUES(?,?,?,?)').bind(id(99),id(4),3,'PENDING').run());
    await assert.rejects(db.prepare('INSERT INTO members VALUES(?,?,?,?)').bind(id(2),id(4),1,'PENDING').run());
    await assert.rejects(db.batch([
      db.prepare('UPDATE source SET revision=revision+100 WHERE id=1'),
      db.prepare('INSERT INTO members VALUES(?,?,?,?)').bind(id(99),id(4),3,'PENDING')
    ]));
    assert.equal((await db.prepare('SELECT revision FROM source WHERE id=1').first()).revision,1);
  });
  await t.test('stale revision transaction rolls back',async()=>{const bad={...p,scan:{...p.scan,id:id(10)},slots:p.slots.map(r=>({...r,scan_id:id(10)})),opportunities:[],batches:[],members:[],jobs:[]};assert.equal((await call('commit',bad)).error,'STALE_OWNER');const s=await call('snapshot',auth);assert.equal(s.source.revision,1);assert.equal((await db.prepare('SELECT count(*) n FROM scans').first()).n,1);});
  await t.test('expired owner cannot overwrite successor',async()=>{await db.prepare('UPDATE lease SET expires=0').run();const b=await call('acquire',{owner:'22222222-2222-4222-8222-222222222222',destination:'-1001'});assert(b.fence>auth.fence);assert.equal((await call('snapshot',auth)).error,'STALE_OWNER');});
 } finally {await mf.dispose();}
});
