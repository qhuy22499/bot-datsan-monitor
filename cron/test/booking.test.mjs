import test from 'node:test';
import assert from 'node:assert/strict';
import {BOOKING_CRON,BOOKING_DISPATCH_URL,CRON,DISPATCH_URL,dispatchScheduled} from '../src/index.mjs';
test('08:30 JST crosses previous UTC date; booking and monitor dispatch remain separate',async()=>{
 const at=Date.parse('2026-11-07T08:30:00+09:00');assert.equal(new Date(at).toISOString(),'2026-11-06T23:30:00.000Z');
 let requests=0;
 const r=await dispatchScheduled({cron:BOOKING_CRON,scheduledTime:at},{GITHUB_DISPATCH_TOKEN:'github_pat_'+'x'.repeat(50)},
   {clock:()=>at,fetcher:async(url,init)=>{requests++;assert.equal(url,BOOKING_DISPATCH_URL);
     assert.deepEqual(JSON.parse(init.body),{ref:'main',inputs:{trigger_id:'cfbooking-'+at}});return new Response(null,{status:204});}});
 assert.equal(r.status,'DISPATCH_ACCEPTED');assert.equal(requests,1);
 assert.equal(CRON,'7,22,37,52 0-14,22-23 * * *');assert(DISPATCH_URL.includes('/monitor.yml/'));
 const bad=await dispatchScheduled({cron:BOOKING_CRON,scheduledTime:at+3600000},{},{clock:()=>at+3600000});assert.equal(bad.status,'FAILED');
});
