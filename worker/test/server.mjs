// Loopback-only integration harness. Not included in Worker bundle.
import http from 'node:http';
import worker from '../src/index.mjs';
import {LocalD1} from './d1.mjs';
const useD1=process.env.MONITOR_TEST_STORAGE==='workerd';
if(process.env.MONITOR_TEST_STORAGE && !['workerd','shim'].includes(process.env.MONITOR_TEST_STORAGE)) throw Error('INVALID_TEST_BACKEND');
const db=useD1 ? null : new LocalD1(process.argv[2] || ':memory:');
const d1=useD1 ? await (await import('./engine.mjs')).startD1(process.argv[2]) : null;
const realNow=Date.now;
let now=Date.parse('2026-10-31T08:00:02+09:00');if(!useD1)Date.now=()=>now;
const secret='offline_test_only_01234567890123456789';
const server=http.createServer(async(req,res)=>{
  if(req.url==='/__clock' && req.method==='POST') {
    let raw='';for await(const c of req) raw+=c;
    now=Number(raw);res.end('ok');return;
  }
  let body='';for await(const c of req) body+=c;
  let r;
  if(req.url==='/__integrity' && req.method==='POST') {
    const sql=useD1 ? d1.db : db;
    const result=await sql.batch([sql.prepare('PRAGMA foreign_key_check'),sql.prepare('PRAGMA quick_check')]);
    r=Response.json({foreign_key_errors:result[0].results.length,integrity_ok:Object.values(result[1].results[0]).includes('ok')});
  } else {
    r=useD1 ? await d1.fetch(req.url,{body:body || undefined,headers:req.headers,now})
      : await worker.fetch(new Request('https://storage.test'+req.url,{method:req.method,headers:req.headers,body:body || undefined}),{DB:db,API_SECRET:secret});
  }
  res.writeHead(r.status,Object.fromEntries(r.headers));res.end(await r.text());
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,backend:useD1?'D1_LOCAL_WORKERD':'SQLITE_SHIM'})));
const stop=()=>{server.close(async()=>{if(d1)await d1.close();else db.close();Date.now=realNow;process.exit(0);});};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
