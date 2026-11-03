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
 const options={modules:true,scriptPath:join(directory,'entry.mjs'),compatibilityDate:'2025-10-01',
   d1Databases:{DB:'00000000-0000-0000-0000-000000000001'},bindings:{API_SECRET:SECRET},...(persistPath ? {d1Persist:persistPath} : {})};
 const mf=new miniflare.Miniflare(miniflare.convertV4MiniflareOptions ? miniflare.convertV4MiniflareOptions(options) : options);
 try {
  const db=await mf.getD1Database('DB');
  const statements=readFileSync(new URL('../migrations/0001_monitor.sql',import.meta.url),'utf8')
    .replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean);
  await db.batch(statements.map(s=>db.prepare(s)));
  return {db,async fetch(path,{body,headers={},now}) {
    return mf.dispatchFetch('https://storage.test'+path,{method:'POST',headers:{...headers,'X-Fixture-Clock':String(now)},body});
   },async close(){await mf.dispose();rmSync(directory,{recursive:true,force:true});}};
 } catch(error) {await mf.dispose();rmSync(directory,{recursive:true,force:true});throw error;}
}
