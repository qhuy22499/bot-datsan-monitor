import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';
import {LocalD1} from './d1.mjs';
const secret='offline_test_only_01234567890123456789';
const owner='11111111-1111-4111-8111-111111111111';
function setup() {
 const db=new LocalD1();const env={DB:db,API_SECRET:secret};
 const send=async(name,p,opts={})=>{
  const r=await worker.fetch(new Request((opts.scheme||'https')+'://storage.test/v1/'+name,{method:opts.method||'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+(opts.secret||secret)},body:opts.raw===undefined?JSON.stringify(p):opts.raw}),env);
  return {status:r.status,...await r.json()};
 };
 return {db,send};
}
test('unauthorized, invalid bearer, no data or secret in response',async()=>{const {db,send}=setup();for(const value of ['bad','']){const r=await send('snapshot',{}, {secret:value||'wrong'});assert.equal(r.status,401);assert(!JSON.stringify(r).includes(secret));}db.close();});
test('malformed JSON and unsupported command',async()=>{const {db,send}=setup();assert.equal((await send('acquire',{}, {raw:'{'})).error,'INVALID_JSON');assert.equal((await send('execute-arbitrary-sql',{})).status,404);db.close();});
test('HTTPS and request size limits',async()=>{const {db,send}=setup();assert.equal((await send('snapshot',{}, {scheme:'http'})).error,'HTTPS_REQUIRED');assert.equal((await send('acquire',{}, {raw:' '.repeat(800001)})).status,413);db.close();});
test('SQL injection is rejected without altering schema',async()=>{const {db,send}=setup();assert.equal((await send('acquire',{owner:"';DROP TABLE slots;--",destination:'-1001'})).status,400);assert(db.sql.prepare("SELECT name FROM sqlite_master WHERE name='slots'").get());db.close();});
test('migration replay keeps data and unique/FK constraints',()=>{const {db}=setup();db.sql.exec(db.migration);assert.equal(db.sql.prepare('SELECT count(*) AS n FROM source').get().n,1);assert.throws(()=>db.sql.exec("INSERT INTO members VALUES('x','missing',1,'PENDING')"));assert.equal(db.sql.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();});
test('concurrent acquire has one winner, destination bound, release fenced',async()=>{const {db,send}=setup();const attempts=await Promise.all([send('acquire',{owner,destination:'-1001'}),send('acquire',{owner:'22222222-2222-4222-8222-222222222222',destination:'-1001'})]);assert.equal(attempts.filter(r=>r.ok).length,1);const a=attempts.find(r=>r.ok);assert.equal(attempts.find(r=>!r.ok).error,'SOURCE_BUSY');assert.equal((await send('release',{owner:a.owner,fence:a.fence+1})).error,'STALE_OWNER');assert((await send('release',{owner:a.owner,fence:a.fence})).ok);assert.equal((await send('acquire',{owner,destination:'-1002'})).error,'DESTINATION_MISMATCH');db.close();});
test('expired lease fences stale writes',async()=>{const {db,send}=setup();const a=await send('acquire',{owner,destination:'-1001'});db.sql.exec('UPDATE lease SET expires=0');const b=await send('acquire',{owner:'22222222-2222-4222-8222-222222222222',destination:'-1001'});assert(b.fence>a.fence);const stale=await send('snapshot',{owner,fence:a.fence});assert.equal(stale.error,'STALE_OWNER');db.close();});
test('D1 batch guard rolls back all writes',async()=>{const {db,send}=setup();const a=await send('acquire',{owner,destination:'-1001'});const r=await send('failure',{owner,fence:a.fence+1,id:'a'.repeat(32),started_at:'2026-10-31T08:00:00+09:00',finished_at:'2026-10-31T08:00:01+09:00',status:'FAILED',reason:'READ_ERROR',days:0,cells:0});assert.equal(r.error,'STALE_OWNER');assert.equal(db.sql.prepare('SELECT count(*) n FROM scans').get().n,0);db.close();});
test('failure records never modify slots or fabricate reservations',async()=>{const {db,send}=setup();const a=await send('acquire',{owner,destination:'-1001'});assert((await send('failure',{owner,fence:a.fence,id:'b'.repeat(32),started_at:'2026-10-31T08:00:00+09:00',finished_at:'2026-10-31T08:00:01+09:00',status:'PARTIAL',reason:'UNKNOWN_STATUS',days:1,cells:14})).ok);assert.equal(db.sql.prepare('SELECT count(*) n FROM slots').get().n,0);assert.equal(db.sql.prepare('SELECT last_status FROM source').get().last_status,'PARTIAL');db.close();});
test('snapshot is read-only and stale owner still rejected',async()=>{const {db,send}=setup();const a=await send('acquire',{owner,destination:'-1001'});const before=db.sql.prepare('SELECT total_changes() n').get().n;assert((await send('snapshot',{owner,fence:a.fence})).ok);assert.equal(db.sql.prepare('SELECT total_changes() n').get().n,before);assert.equal((await send('snapshot',{owner,fence:a.fence+1})).error,'STALE_OWNER');assert.equal(db.sql.prepare('SELECT total_changes() n').get().n,before);db.close();});
test('deployed handler never accepts fixture clock headers',async()=>{const db=new LocalD1();const before=Date.now();const r=await worker.fetch(new Request('https://storage.test/v1/acquire',{method:'POST',headers:{'Authorization':'Bearer '+secret,'Content-Type':'application/json','X-Fixture-Clock':'0'},body:JSON.stringify({owner,destination:'-1001'})}),{DB:db,API_SECRET:secret});const body=await r.json();assert(body.ok);assert(body.expires>before);db.close();});
test('noncanonical timestamps and invalid owner types are rejected',async()=>{const {db,send}=setup();assert.equal((await send('acquire',{owner:[owner],destination:'-1001'})).status,400);const a=await send('acquire',{owner,destination:'-1001'});const bad=await send('failure',{owner,fence:a.fence,id:'a'.repeat(32),started_at:'2026-10-31T24:00:00+09:00',finished_at:'2026-10-31T24:00:00+09:00',status:'FAILED',reason:'READ_ERROR',days:0,cells:0});assert.equal(bad.status,400);assert.equal(db.sql.prepare('SELECT count(*) n FROM scans').get().n,0);db.close();});
test('storage diagnostics never expose SQL, bindings, tokens or raw exceptions',async()=>{
 const {db,send}=setup();const a=await send('acquire',{owner,destination:'-1001'});
 const batch=db.batch;const warn=console.warn;const logged=[];
 db.batch=async()=>{throw new Error('SQL request size limit exceeded SELECT private_table '+secret);};
 console.warn=(...args)=>logged.push(args.join(' '));
 try {
  const r=await send('failure',{owner,fence:a.fence,id:'c'.repeat(32),started_at:'2026-10-31T08:00:00+09:00',finished_at:'2026-10-31T08:00:01+09:00',status:'FAILED',reason:'READ_ERROR',days:0,cells:0});
  assert.equal(r.error,'STORAGE_UNAVAILABLE');assert.equal(r.status,503);
  assert.equal(logged.length,1);assert(logged[0].includes('limit'));
  for(const text of [secret,'SELECT','private_table'])assert(!JSON.stringify({r,logged}).includes(text));
 } finally {db.batch=batch;console.warn=warn;db.close();}
});
