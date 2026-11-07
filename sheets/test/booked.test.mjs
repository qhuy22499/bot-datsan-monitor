import test from 'node:test';
import assert from 'node:assert/strict';
import {projectBooked,bookedValues,readBooked,BOOKED_SQL} from '../src/booked.mjs';
import {SyncCoordinator} from '../src/coordinator.mjs';
import {GoogleSheets,GoogleError} from '../src/google.mjs';
import handler from '../src/index.mjs';
const now=Date.parse('2026-11-07T12:00:00+09:00');
const at='2026-11-07T08:30:00+09:00';
const groups=()=>['A','B','C'].map(group=>({group,displayName:'ＦＣ　'+group,status:'COMPLETE',lastSuccess:at,lastAttempt:at,code:'VERIFIED'}));
const row=(group='A',day='2026-11-08',start='18:30',court='B')=>({id:crypto.randomUUID(),group,day,start,end:start==='18:30'?'20:30':'22:30',court,observedAt:at});
const source=()=>({groups:groups(),rows:[row('C'),row('A'),row('B','2026-11-08','20:30','A'),row('A','2026-11-08','18:30','A')]});

test('BOOKED ISO sorting, five literal columns, full-width name and no private fields',()=>{
 const d=projectBooked(source(),now),v=bookedValues(d,'updated');
 assert.deepEqual(v[11],['Ngày','Khung giờ','Sân','Group','Tên tài khoản']);
 assert.deepEqual(d.rows.map(r=>r.court+r.group),['AA','BA','BC','AB']);
 assert.equal(v[12][0],'CN 08/11/2026');assert.equal(v[12][4],'ＦＣ　A');
 assert.equal(d.weeklyDays,1);assert(d.complete);assert(v.slice(12).every(r=>r.length===5));
 assert(!JSON.stringify(v).includes('reservation_number'));
});
test('ended bookings hidden; weekly days distinct incl past; FAILED group retains data with lower-bound warning',()=>{
 const s=source();s.rows.push({...row('A','2026-11-06'),start:'08:00',end:'10:00'});
 s.groups[2].status='FAILED';const d=projectBooked(s,now);
 assert.equal(d.rows.length,4);assert.equal(d.weeklyDays,2);assert(d.sourceWarning);
 assert(bookedValues(d,'now')[8][1].includes('CHƯA ĐẦY ĐỦ'));
 const zero=projectBooked({groups:groups(),rows:[]},now);assert.equal(zero.total,0);
 assert.throws(()=>projectBooked({groups:groups().map(g=>({...g,lastSuccess:null})),rows:[]},now));
});
test('SELECT-only D1 read; invalid data never becomes a verified zero',async()=>{
 assert(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i.test(BOOKED_SQL));
 let reads=0;const s=source();const db={withSession:()=>({prepare:sql=>{
   reads++;assert.equal(sql,BOOKED_SQL);return {first:async()=>({groups_json:JSON.stringify(s.groups),rows_json:JSON.stringify(s.rows)})};}})};
 assert.equal((await readBooked(db,now)).total,4);assert.equal(reads,1);
 s.rows[0].observedAt='invalid';await assert.rejects(readBooked(db,now));
});
test('dedup/restart/UNCERTAIN BOOKED independent replacement, source error leaves previous values',async()=>{
 let state={phase:'IDLE'},values=[],writes=0,s=source(),ambiguous=false;
 const store={readSync:()=>state,writeSync:s=>{state=s;}};
 const google={readTab:async()=>({values:structuredClone(values)}),replaceTab:async r=>{
   writes++;assert.equal(state.phase,'WRITING');values=structuredClone(r.values);
   if(ambiguous)throw new GoogleError('GOOGLE_TIMEOUT',{ambiguous:true});}};
 const make=()=>new SyncCoordinator({store,google,readSource:async()=>projectBooked(s,now),clock:()=>now,render:bookedValues,project:projectBooked});
 const c=make();const r=await Promise.all([c.sync(),c.sync()]);assert(r.every(r=>r.status==='UPDATED'));assert.equal(writes,1);
 assert.equal((await make().sync()).status,'SKIPPED');assert.equal(writes,1);
 s.rows.pop();ambiguous=true;assert.equal((await make().sync()).status,'UNCERTAIN');assert.equal(writes,2);
 ambiguous=false;assert.equal((await make().sync()).status,'SKIPPED');assert.equal(writes,2);
 s.rows=[];assert.equal((await make().sync()).status,'UPDATED');assert.equal(values.length,12);
 const previous=structuredClone(values);s.groups=[];assert.equal((await make().sync()).status,'FAILED');assert.deepEqual(values,previous);
});
test('BOOKED sync endpoint rejects anonymous or wrong secret before reaching D1/DO',async()=>{
 const env={BOOKED_SYNC_SECRET:'offline_test_only_01234567890123456789'};
 for(const auth of ['', 'Bearer wrong']){
   const r=await handler.fetch(new Request('https://sheets.test/booked/sync',{method:'POST',headers:{Authorization:auth}}),env);
   assert.equal(r.status,401);
 }
});

// Real Google wire protocol tested with ephemeral in-RAM key, never fixtures with credentials.
test('BOOKED addSheet only once with durable intent, REPLACE only target tab, formulas literal, ambiguous creation reconciled',async()=>{
 const key=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const der=new Uint8Array(await crypto.subtle.exportKey('pkcs8',key.privateKey));
 const delim=action=>['-----'+action,'PRIVATE KEY-----'].join(' ');
 const sa={type:'service_account',client_email:'test@example.iam.gserviceaccount.com',token_uri:'https://oauth2.googleapis.com/token',private_key:delim('BEGIN')+'\n'+btoa(String.fromCharCode(...der))+'\n'+delim('END')+'\n'};
 const sid='offline_spreadsheet_fixture_only';let intent=null,booked=null,creates=0,writeRequests=[],lose=true;
 const json=x=>Response.json(x);
 const fetcher=async(url,init)=>{
   if(String(url).includes('oauth2.googleapis.com'))return json({access_token:'offline-access-fixture',token_type:'Bearer',expires_in:3600});
   const u=new URL(url);
   if(init.method==='GET'){
     if(!u.searchParams.has('ranges'))return json({spreadsheetId:sid,sheets:[{properties:{sheetId:1,title:'AVAILABLE'}},...(booked?[{properties:booked}]:[])]});
     assert.equal(u.searchParams.get('ranges'),"'BOOKED'!A:E");
     return json({spreadsheetId:sid,sheets:[{properties:booked,data:[]}]});
   }
   const body=JSON.parse(init.body);
   if(body.requests[0].addSheet){
     creates++;assert(intent);assert.equal(body.requests[0].addSheet.properties.title,'BOOKED');
     booked=body.requests[0].addSheet.properties;
     if(lose){lose=false;throw new Error('lost receipt');}
     return json({spreadsheetId:sid,replies:[{addSheet:{properties:booked}}]});
   }
   writeRequests=body.requests;return json({spreadsheetId:sid,replies:body.requests.map(()=>({}))});
 };
 const make=()=>new GoogleSheets({serviceAccountJson:JSON.stringify(sa),spreadsheetId:sid,fetcher,clock:()=>now,tabTitle:'BOOKED',headerRowIndex:11,creationStore:{read:async()=>intent,write:async v=>{intent=v;}}});
 await assert.rejects(make().readTab(),e=>e.ambiguous);assert.equal(creates,1);assert(intent);
 const adapter=make(),tab=await adapter.readTab();assert.equal(creates,1);assert.equal(intent,null);
 const data=projectBooked(source(),now);data.groups[0].displayName='=never_a_formula';
 await adapter.replaceTab({...tab,values:bookedValues(data,'now')});
 assert(writeRequests.every(r=>!JSON.stringify(r).includes('AVAILABLE')));
 const cells=writeRequests.find(r=>r.updateCells).updateCells;
 assert.equal(cells.range.sheetId,booked.sheetId);
 assert.equal(cells.rows[12].values[4].userEnteredValue.stringValue,'=never_a_formula');
 assert.equal(writeRequests.find(r=>r.setBasicFilter).setBasicFilter.filter.range.startRowIndex,11);
});
