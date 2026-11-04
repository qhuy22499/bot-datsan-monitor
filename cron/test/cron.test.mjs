import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker, {CRON,DISPATCH_URL,dispatchScheduled,createScheduledHandler} from '../src/index.mjs';

const token='github_pat_'+ 'offline_test_only_'.repeat(3);
const at=Date.parse('2026-11-04T10:07:00Z'); // 19:07 JST
const event=(ms=at)=>({cron:CRON,scheduledTime:ms,noRetry(){this.noRetryCalled=true;}});
const env={GITHUB_DISPATCH_TOKEN:token};

test('UTC cron covers exactly 34 JST ticks within verified operating hours',()=>{
 const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 assert.deepEqual(config.triggers.crons,[CRON]);
 assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
 assert.equal(config.d1_databases,undefined);
 const ticks=[];
 for(let h=0;h<24;h++)for(const m of [7,37])if(h<=14||h>=22)ticks.push([(h+9)%24,m]);
 ticks.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 assert.equal(ticks.length,34);assert.deepEqual(ticks[0],[7,7]);assert.deepEqual(ticks.at(-1),[23,37]);
});

test('scheduled handler creates one exact GitHub monitoring request, not connectivity probe',async()=>{
 const calls=[];const controller=event();
 const result=await dispatchScheduled(controller,env,{clock:()=>at+1,fetcher:async(...args)=>{calls.push(args);return new Response(null,{status:204});}});
 assert.equal(result.status,'DISPATCH_ACCEPTED');assert.equal(controller.noRetryCalled,true);
 assert.equal(calls.length,1);assert.equal(calls[0][0],DISPATCH_URL);
 const request=calls[0][1];assert.equal(request.method,'POST');assert.equal(request.redirect,'manual');
 assert.deepEqual(JSON.parse(request.body),{ref:'main',inputs:{confirm_test_delivery:true,telegram_transport_test:false,dispatch_source:'cloudflare_cron',trigger_id:`cfcron-${at}`}});
 assert.equal(request.headers.Authorization,'Bearer '+token);
 assert.equal(JSON.stringify(result).includes(token),false);
});

test('HTTP rejection, rate limit, server ambiguity and transport loss never retry',async()=>{
 for(const status of [302,401,403,422,429,500,503,200]){
  let count=0;const result=await dispatchScheduled(event(),env,{clock:()=>at+1,fetcher:async()=>{count++;return new Response('',{status});}});
  assert.equal(count,1);assert.equal(result.status,status>=500||status===200?'UNCERTAIN':'FAILED');
  assert.equal(result.http,status);assert.equal(JSON.stringify(result).includes(token),false);
 }
 let count=0;const result=await dispatchScheduled(event(),env,{clock:()=>at+1,fetcher:async()=>{count++;throw new Error('sensitive '+token);}});
 assert.equal(count,1);assert.equal(result.status,'UNCERTAIN');assert.equal(JSON.stringify(result).includes(token),false);
});

test('Cloudflare redirect compatibility never follows redirect or leaks Authorization',async()=>{
 let count=0;
 const fetcher=async(url,options)=>{
  count++;if(options.redirect==='error')throw new TypeError('Invalid redirect value');
  assert.equal(options.redirect,'manual');assert.equal(url,DISPATCH_URL);
  return new Response(null,{status:302,headers:{Location:'https://other.invalid/'}});
 };
 const result=await dispatchScheduled(event(),env,{clock:()=>at+1,fetcher});
 assert.equal(result.status,'FAILED');assert.equal(result.http,302);assert.equal(count,1);
 assert.equal(JSON.stringify(result).includes(token),false);
});

test('GitHub 2026 HTTP 200 run response is accepted only with exact repository identity',async()=>{
 const valid={workflow_run_id:17,run_url:'https://api.github.com/repos/qhuy22499/bot-datsan-monitor/actions/runs/17',
  html_url:'https://github.com/qhuy22499/bot-datsan-monitor/actions/runs/17'};
 for(const [data,accepted] of [[valid,true],[{...valid,html_url:'https://other.invalid/'},false],[{ok:true},false]]) {
  let count=0;const result=await dispatchScheduled(event(),env,{clock:()=>at+1,fetcher:async()=>{count++;return Response.json(data);}});
  assert.equal(count,1);assert.equal(result.status,accepted?'DISPATCH_ACCEPTED':'UNCERTAIN');
  if(accepted)assert.equal(result.run_id,17);
 }
});

test('07:00 JST boundary, delayed midnight, malformed events and missing token fail closed',async()=>{
 let count=0;const fetcher=async()=>{count++;return new Response(null,{status:204});};
 for(const iso of ['2026-11-03T21:37:00Z','2026-11-04T15:07:00Z']){
  const ms=Date.parse(iso);assert.equal((await dispatchScheduled(event(ms),env,{fetcher,clock:()=>ms+1})).status,'SKIPPED');
 }
 assert.equal((await dispatchScheduled(event(),env,{fetcher,clock:()=>Date.parse('2026-11-04T15:01:00Z')})).status,'SKIPPED');
 for(const c of [{cron:'* * * * *',scheduledTime:at},event(at+1000),event(at+60000),event(NaN)])
  assert.equal((await dispatchScheduled(c,env,{fetcher,clock:()=>at})).status,'FAILED');
 assert.equal((await dispatchScheduled(event(),{}, {fetcher,clock:()=>at})).reason,'GITHUB_CREDENTIAL_MISSING');
 assert.equal(count,0);
 for(const iso of ['2026-11-03T22:07:00Z','2026-11-04T14:37:00Z']){
  const ms=Date.parse(iso);assert.equal((await dispatchScheduled(event(ms),env,{fetcher,clock:()=>ms+1})).status,'DISPATCH_ACCEPTED');
 }
 assert.equal(count,2);
});

test('same isolate does not overlap; next sequential invocation can recover',async()=>{
 let unblock;const wait=new Promise(resolve=>{unblock=resolve;});let calls=0;
 const handler=createScheduledHandler({clock:()=>at+1,fetcher:async()=>{calls++;await wait;return new Response(null,{status:204});}});
 const first=handler(event(),env);assert.equal((await handler(event(),env)).reason,'INVOCATION_ALREADY_RUNNING');
 unblock();assert.equal((await first).status,'DISPATCH_ACCEPTED');
 assert.equal((await handler(event(),env)).status,'DISPATCH_ACCEPTED');assert.equal(calls,2);
 // Cross-isolate/restart protection remains GitHub concurrency + existing D1 lease/fencing/outbox.
});

test('production fetch never dispatches, regardless of request path',async()=>{
 for(const path of ['/','/__scheduled','/admin/trigger'])assert.equal((await worker.fetch(new Request('https://example.test'+path))).status,404);
});

test('actual scheduled entrypoint logs safe outcome and surfaces failures without retry',async t=>{
 const logs=[];let calls=0;
 t.mock.method(Date,'now',()=>at+1);
 t.mock.method(console,'log',value=>logs.push(JSON.parse(value)));
 const fetch=t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:204});});
 const controller=event();await worker.scheduled(controller,env);
 assert.equal(calls,1);assert.equal(controller.noRetryCalled,true);
 assert.equal(logs[0].status,'DISPATCH_ACCEPTED');assert.equal(logs[0].execution_allowed,false);
 fetch.mock.mockImplementation(async()=>{calls++;return new Response('',{status:403});});
 await assert.rejects(worker.scheduled(event(),env),{message:'GITHUB_DISPATCH_REJECTED'});
 assert.equal(calls,2);assert.equal(logs[1].status,'FAILED');
 assert.equal(JSON.stringify(logs).includes(token),false);
});
