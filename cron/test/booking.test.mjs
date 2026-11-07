import test from 'node:test';
import assert from 'node:assert/strict';
import {BOOKING_CRON,BOOKING_DISPATCH_URL,CRON,DISPATCH_URL,dispatchScheduled} from '../src/index.mjs';
import {verifySignature} from '../../sheets/src/weekly.mjs';
test('08:30 JST crosses previous UTC date; booking and monitor dispatch remain separate',async()=>{
 const at=Date.parse('2026-11-07T08:30:00+09:00');assert.equal(new Date(at).toISOString(),'2026-11-06T23:30:00.000Z');
 let requests=0;
 const signing='offline_test_only_cron_signing_0123456789';
 const r=await dispatchScheduled({cron:BOOKING_CRON,scheduledTime:at},{GITHUB_DISPATCH_TOKEN:'github_pat_'+'x'.repeat(50),BOOKING_CRON_SIGNING_SECRET:signing},
   {clock:()=>at,fetcher:async(url,init)=>{requests++;assert.equal(url,BOOKING_DISPATCH_URL);
     const body=JSON.parse(init.body);assert.equal(body.ref,'main');assert.equal(body.inputs.trigger_id,'cfbooking-'+at);
     assert(await verifySignature(body.inputs.trigger_id,body.inputs.trigger_signature,signing));return new Response(null,{status:204});}});
 assert.equal(r.status,'DISPATCH_ACCEPTED');assert.equal(requests,1);
 assert.equal(CRON,'7,22,37,52 0-14,22-23 * * *');assert(DISPATCH_URL.includes('/monitor.yml/'));
 const bad=await dispatchScheduled({cron:BOOKING_CRON,scheduledTime:at+3600000},{},{clock:()=>at+3600000});assert.equal(bad.status,'FAILED');
});
