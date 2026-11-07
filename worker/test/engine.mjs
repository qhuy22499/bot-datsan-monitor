// Test harness only. Actual Miniflare/workerd D1; never falls back to node:sqlite.
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as miniflare from 'miniflare';
export const SECRET='offline_test_only_01234567890123456789';
export async function startD1(persistPath) {
 const directory=mkdtempSync(join(tmpdir(),'datsan-workerd-test-'));
 // The wrapper controls time only for fixtures. index.mjs is copied byte for
 // byte from the reviewed Worker; its SQL, auth, validation, and fencing run
 // inside workerd against the actual local D1 binding.
 writeFileSync(join(directory,'index.mjs'),readFileSync(new URL('../src/index.mjs',import.meta.url)));
 writeFileSync(join(directory,'entry.mjs'),`import {createHandler} from './index.mjs';
 export default {fetch(request,env){
 const clock=Number(request.headers.get('X-Fixture-Clock'));
 if(!Number.isSafeInteger(clock)) return new Response('',{status:400});
 return createHandler(()=>clock).fetch(request,env);
 }};`);
 // The pinned v5 compatibility converter does not discover imported modules,
 // and strips the legacy d1Persist option. Declare both modules and the v5
 // resource root explicitly so actual D1 survives a child-process restart.
 const options={modules:[{type:'ESModule',path:join(directory,'entry.mjs')},{type:'ESModule',path:join(directory,'index.mjs')}],
   modulesRoot:directory,compatibilityDate:'2025-10-01',
   d1Databases:{DB:'00000000-0000-0000-0000-000000000001'},bindings:{API_SECRET:SECRET},
   ...(persistPath ? (miniflare.convertV4MiniflareOptions ? {resourcePersistencePath:persistPath} : {d1Persist:persistPath}) : {})};
 const mf=new miniflare.Miniflare(miniflare.convertV4MiniflareOptions ? miniflare.convertV4MiniflareOptions(options) : options);
 try {
  const db=await mf.getD1Database('DB');
  const statements=readFileSync(new URL('../migrations/0001_monitor.sql',import.meta.url),'utf8')
    .replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean);
  await db.batch(statements.map(s=>db.prepare(s)));
  const columns=await db.prepare('PRAGMA table_info(source)').all();
  if(!columns.results.some(r=>r.name==='notification_version')) {
    const additive=readFileSync(new URL('../migrations/0002_notification_v2.sql',import.meta.url),'utf8')
      .replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean);
    await db.batch(additive.map(s=>db.prepare(s)));
  }
  return {db,async fetch(path,{body,headers={},now}) {
    return mf.dispatchFetch('https://storage.test'+path,{method:'POST',headers:{...headers,'X-Fixture-Clock':String(now)},body});
   },async close(){await mf.dispose();rmSync(directory,{recursive:true,force:true});}};
 } catch(error) {await mf.dispose();rmSync(directory,{recursive:true,force:true});throw error;}
}
