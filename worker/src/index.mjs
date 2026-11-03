// Fixed command API only. No SQL/URLs from clients; no logging of requests.
const MAX_BODY = 800000;
const ID = /^[a-f0-9]{32}$/;
const OWNER = /^[a-f0-9-]{36}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;
const TIMES = ['08:00:10:00','10:00:12:00','12:00:14:00','14:00:16:00','16:00:18:00','18:30:20:30','20:30:22:30'];
const STATES = new Set(['AVAILABLE','GENERAL_RESERVED','EVENT_RESERVED','TOURNAMENT_RESERVED','OTHER_RESERVED','COMMUNITY_RESERVED','CLOSED','MAINTENANCE','BAD_WEATHER','OUTSIDE_ACCEPTANCE_PERIOD','UNSELECTABLE','UNBOOKABLE_TIME']);
const ERRORS = new Set(['WEBSITE_UNAVAILABLE','TIMEOUT','READ_ERROR','SOURCE_INCOMPLETE','UNKNOWN_STATUS','MANUAL_ACTION_REQUIRED','UNTRUSTED_ORIGIN','UNEXPECTED_DATE','INVALID_OBSERVATION','INTERRUPTED','BOOKABLE_BOUNDARY_UNVERIFIED','SCAN_WINDOW_CHANGED','NAVIGATION_LIMIT']);
const DELIVERY_ERRORS = new Set(['TELEGRAM_REJECTED','TELEGRAM_AUTH_FAILED','TELEGRAM_FORBIDDEN','TELEGRAM_RATE_LIMITED','TELEGRAM_DELIVERY_UNKNOWN','TELEGRAM_INVALID_RESPONSE','INVALID_TEXT','INVALID_MESSAGE_ID','INVALID_CHAT_ID','INVALID_TOKEN','INVALID_KEYBOARD','INVALID_TIMEOUT','TELEGRAM_DISABLED']);
class Fault extends Error { constructor(code, status=400) {super(code);this.code=code;this.status=status;} }
const need = (ok, code='INVALID_REQUEST', status=400) => {if (!ok) throw new Fault(code,status);};
const response = (body,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const integer = (x,min=0,max=Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(x) && x>=min && x<=max;
const keys = (o,names) => {need(o && typeof o==='object' && !Array.isArray(o));need(Object.keys(o).sort().join(',')===names.split(',').sort().join(','));};
function stamp(x) {
  need(typeof x==='string' && STAMP.test(x) && Number.isFinite(Date.parse(x)));
  need(new Date(Date.parse(x)+9*3600000).toISOString().slice(0,19)+'+09:00'===x);
}
function day(x) {need(typeof x==='string' && DAY.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0,10)===x);}
function lease(p) {need(typeof p.owner==='string' && OWNER.test(p.owner) && integer(p.fence,1));}
function rowid(x) {need(typeof x==='string' && ID.test(x));}
function guard(db,p,now,revision=null) {
  lease(p);
  const rev = revision===null ? '' : ' AND (SELECT revision FROM source WHERE id=1)=?';
  const args=[crypto.randomUUID(),p.owner,p.fence,now];
  if (revision!==null) args.push(revision);
  return db.prepare(`INSERT INTO atomic_guard(id,valid) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM lease WHERE id=1 AND owner=? AND fence=? AND expires>?)${rev} THEN 1 ELSE 0 END)`).bind(...args);
}
async function atomic(db,p,now,commands,revision=null) {
  try {return await db.batch([guard(db,p,now,revision),...commands,db.prepare('DELETE FROM atomic_guard')]);}
  catch {
    const current=await db.prepare('SELECT owner,fence,expires FROM lease WHERE id=1').first();
    const state=await db.prepare('SELECT revision FROM source WHERE id=1').first();
    if(!current || current.owner!==p.owner || current.fence!==p.fence || current.expires<=now
       || (revision!==null && state.revision!==revision)) throw new Fault('STALE_OWNER',409);
    throw new Fault('STORAGE_UNAVAILABLE',503);
  }
}
function validatePlan(p,now) {
  keys(p,'owner,fence,expected_revision,scan,baseline,slots,opportunities,batches,members,jobs,transitions,execution_allowed,auto_booking_allowed');
  lease(p);need(integer(p.expected_revision) && p.execution_allowed===false && p.auto_booking_allowed===false);
  need(['QUIET','NOTIFY'].includes(p.baseline));
  const s=p.scan;keys(s,'id,started_at,finished_at,status,reason,window_start,window_end,days,cells');
  rowid(s.id);stamp(s.started_at);stamp(s.finished_at);day(s.window_start);day(s.window_end);
  need(s.status==='COMPLETE' && s.reason==='VERIFIED' && integer(s.days,1,366) && s.cells===s.days*14);
  need(s.window_start===s.started_at.slice(0,10) && s.window_start===s.finished_at.slice(0,10));
  need((Date.parse(s.window_end)-Date.parse(s.window_start))/86400000+1===s.days);
  need(Date.parse(s.started_at)<=Date.parse(s.finished_at) && Date.parse(s.finished_at)<=now && now-Date.parse(s.started_at)<=300000);
  const limits={slots:8192,opportunities:4096,batches:128,members:1024,jobs:128,transitions:8192};
  for (const [name,max] of Object.entries(limits)) need(Array.isArray(p[name]) && p[name].length<=max);
  const unique=new Set();let active=0;
  for (const r of p.slots) {
    keys(r,'id,day,court,start,end,status,observed_at,in_scope,scan_id');
    day(r.day);stamp(r.observed_at);rowid(r.scan_id);
    need(['A','B'].includes(r.court) && TIMES.includes(r.start+':'+r.end) && STATES.has(r.status));
    need(r.id===`${r.day}:${r.court}:${r.start}:${r.end}` && !unique.has(r.id));unique.add(r.id);
    need(r.in_scope===0 || r.in_scope===1);
    if (r.in_scope===1) {
      active++;
      need(r.day>=s.window_start && r.day<=s.window_end && r.scan_id===s.id);
      need(Date.parse(r.observed_at)>=Date.parse(s.started_at) && Date.parse(r.observed_at)<=Date.parse(s.finished_at));
    }
  }
  need(active===s.cells);
  for (const r of p.opportunities) {
    keys(r,'id,slot_id,state,origin,reason,created_scan,updated_at');rowid(r.id);rowid(r.created_scan);stamp(r.updated_at);
    need(typeof r.slot_id==='string' && r.slot_id.length<64 && ['ACTIVE','INVALIDATED','EXPIRED'].includes(r.state));
    need(['BASELINE','FIRST_OBSERVED','ENTERED_SCOPE','REOPENED'].includes(r.origin));
    need(['AVAILABLE','OUT_OF_SCOPE','STARTED','SOURCE_NOT_AVAILABLE'].includes(r.reason));
  }
  for (const r of p.batches) {
    keys(r,'id,kind,revision,message_id,scan_id');rowid(r.id);rowid(r.scan_id);
    need(['INITIAL','INCREMENTAL'].includes(r.kind) && integer(r.revision,1) && (r.message_id===null || integer(r.message_id,1)));
  }
  for (const r of p.members) {
    keys(r,'opportunity_id,batch_id,ordinal,delivery');rowid(r.opportunity_id);rowid(r.batch_id);
    need(integer(r.ordinal,1,24) && r.delivery==='PENDING');
  }
  for (const r of p.jobs) {
    keys(r,'id,batch_id,revision,kind,text');rowid(r.id);rowid(r.batch_id);
    need(integer(r.revision,1) && ['SEND','EDIT'].includes(r.kind) && typeof r.text==='string' && r.text.length>0 && r.text.length<=4096);
  }
  for (const r of p.transitions) {
    keys(r,'id,slot_id,scan_id,old_status,new_status,reason');rowid(r.id);rowid(r.scan_id);
    need(typeof r.slot_id==='string' && r.slot_id.length<64 && (r.old_status===null || STATES.has(r.old_status)) && STATES.has(r.new_status));
    need(['FIRST_OBSERVED','VERIFIED_CHANGE'].includes(r.reason) && r.scan_id===s.id);
  }
}

async function command(name,p,db,now) {
  if (name==='acquire') {
    keys(p,'owner,destination');need(typeof p.owner==='string' && OWNER.test(p.owner) && typeof p.destination==='string' && /^-[1-9]\d{0,18}$/.test(p.destination));
    // Single conditional UPDATE is the authority. Lease is a 12 minute technical
    // bound, not a notification TTL or a business retry policy.
    const acquired=await db.prepare('UPDATE lease SET owner=?,fence=fence+1,expires=? WHERE id=1 AND expires<=? RETURNING owner,fence,expires').bind(p.owner,now+720000,now).first();
    need(acquired,'SOURCE_BUSY',409);
    try {
      const bound=await db.prepare('SELECT destination FROM source WHERE id=1').first();
      need(bound.destination===null || bound.destination===p.destination,'DESTINATION_MISMATCH',409);
      await atomic(db,acquired,now,[
        db.prepare('UPDATE source SET destination=? WHERE id=1 AND destination IS NULL').bind(p.destination),
        db.prepare("UPDATE jobs SET status='UNCERTAIN',error_code='CLAIM_EXPIRED' WHERE status='IN_FLIGHT' AND (owner<>? OR fence<>?)").bind(acquired.owner,acquired.fence)
      ]);
    } catch (e) {
      await db.prepare('UPDATE lease SET expires=0 WHERE id=1 AND owner=? AND fence=?').bind(acquired.owner,acquired.fence).run();throw e;
    }
    return acquired;
  }
  lease(p);
  if (name==='release') {
    keys(p,'owner,fence');
    const r=await db.prepare('UPDATE lease SET expires=0 WHERE id=1 AND owner=? AND fence=? RETURNING fence').bind(p.owner,p.fence).first();
    need(r,'STALE_OWNER',409);return {released:true};
  }
  if (name==='snapshot') {
    keys(p,'owner,fence');
    const names=['source','slots','opportunities','batches','members','jobs'];
    // Read-only batch: no INSERT/DELETE guard writes for snapshots. The first
    // SELECT and the data reads share the D1 batch; all mutations remain fenced.
    const result=await db.batch([
      db.prepare('SELECT 1 AS valid FROM lease WHERE id=1 AND owner=? AND fence=? AND expires>?').bind(p.owner,p.fence,now),
      ...names.map(n=>db.prepare(`SELECT * FROM ${n} LIMIT 20001`))
    ]);
    need(result[0].results.length===1,'STALE_OWNER',409);
    const out=Object.fromEntries(names.map((n,i)=>[n,result[i+1].results]));
    need(names.every(n=>out[n].length<=20000),'STATE_LIMIT',409);out.source=out.source[0];out.stats={transition_count:out.source.transition_count,scan_count:out.source.revision};return out;
  }
  if (name==='failure') {
    keys(p,'owner,fence,id,started_at,finished_at,status,reason,days,cells');rowid(p.id);stamp(p.started_at);stamp(p.finished_at);
    need(['PARTIAL','FAILED'].includes(p.status) && ERRORS.has(p.reason) && integer(p.days,0,366) && p.cells===p.days*14);
    await atomic(db,p,now,[
      db.prepare('INSERT INTO scans(id,started_at,finished_at,status,reason,days,cells,fence) VALUES(?,?,?,?,?,?,?,?)').bind(p.id,p.started_at,p.finished_at,p.status,p.reason,p.days,p.cells,p.fence),
      db.prepare('UPDATE source SET revision=revision+1,last_scan=?,last_status=?,last_error=? WHERE id=1').bind(p.id,p.status,p.reason)
    ]);return {recorded:true};
  }
  if (name==='commit') {
    validatePlan(p,now);const s=p.scan;
    const commands=[db.prepare('INSERT INTO scans VALUES(?,?,?,?,?,?,?,?,?,?)').bind(s.id,s.started_at,s.finished_at,s.status,s.reason,s.window_start,s.window_end,s.days,s.cells,p.fence)];
    // A quiet baseline cannot be silently changed by a later job.
    commands.push(db.prepare("INSERT INTO atomic_guard VALUES(?,CASE WHEN (SELECT baseline FROM source WHERE id=1) IS NULL OR (SELECT baseline FROM source WHERE id=1)=? THEN 1 ELSE 0 END)").bind(crypto.randomUUID(),p.baseline));
    // One bound JSON array per typed table reduces Worker CPU and D1 subrequests.
    // Column expressions are constants; no client SQL is accepted.
    const bulk=(table,columns,rows,suffix='',where='1')=>db.prepare(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map(c=>`json_extract(value,'$.${c}')`).join(',')} FROM json_each(?) WHERE ${where} ${suffix}`).bind(JSON.stringify(rows));
    commands.push(bulk('slots',['id','day','court','start','end','status','observed_at','in_scope','scan_id'],p.slots,'ON CONFLICT(id) DO UPDATE SET status=excluded.status,observed_at=excluded.observed_at,in_scope=excluded.in_scope,scan_id=excluded.scan_id'));
    // Invalidate old lifecycles first so the unique active index is preserved.
    const oc=['id','slot_id','state','origin','reason','created_scan','updated_at'];
    const upsert='ON CONFLICT(id) DO UPDATE SET state=excluded.state,reason=excluded.reason,updated_at=excluded.updated_at';
    commands.push(bulk('opportunities',oc,p.opportunities,upsert,"json_extract(value,'$.state')<>'ACTIVE'"));
    commands.push(bulk('opportunities',oc,p.opportunities,upsert,"json_extract(value,'$.state')='ACTIVE'"));
    commands.push(bulk('batches',['id','kind','revision','message_id','scan_id'],p.batches,'ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,scan_id=excluded.scan_id'));
    commands.push(db.prepare("UPDATE jobs SET status='CANCELLED' WHERE status='PENDING' AND EXISTS(SELECT 1 FROM batches b WHERE b.id=jobs.batch_id AND b.revision>jobs.revision)"));
    commands.push(bulk('members',['opportunity_id','batch_id','ordinal','delivery'],p.members));
    commands.push(bulk('jobs',['id','batch_id','revision','kind','status','text'],p.jobs.map(r=>({...r,status:'PENDING'}))));
    commands.push(bulk('transitions',['id','slot_id','scan_id','old_status','new_status','reason'],p.transitions));
    commands.push(db.prepare('UPDATE source SET revision=revision+1,transition_count=transition_count+?,baseline=coalesce(baseline,?),last_scan=?,last_status=\'COMPLETE\',last_success=?,last_error=NULL WHERE id=1').bind(p.transitions.length,p.baseline,s.id,s.finished_at));
    await atomic(db,p,now,commands,p.expected_revision);return {committed:true};
  }
  if (name==='claim') {
    keys(p,'owner,fence,job_id');rowid(p.job_id);
    const commands=[db.prepare(`UPDATE jobs SET status='IN_FLIGHT',owner=?,fence=?,claimed_at=?
      WHERE id=? AND status='PENDING'
      AND NOT EXISTS(SELECT 1 FROM jobs WHERE status IN ('IN_FLIGHT','UNCERTAIN'))
      AND EXISTS(SELECT 1 FROM batches b WHERE b.id=jobs.batch_id AND b.revision=jobs.revision AND ((jobs.kind='SEND' AND b.message_id IS NULL) OR (jobs.kind='EDIT' AND b.message_id IS NOT NULL)))
      AND EXISTS(SELECT 1 FROM source WHERE last_status='COMPLETE')
      AND EXISTS(SELECT 1 FROM lease WHERE id=1 AND expires>?)
      AND (kind='EDIT' OR NOT EXISTS(
        SELECT 1 FROM members m JOIN opportunities o ON o.id=m.opportunity_id JOIN slots s ON s.id=o.slot_id
        WHERE m.batch_id=jobs.batch_id AND (o.state<>'ACTIVE' OR s.status<>'AVAILABLE' OR s.in_scope<>1
          OR unixepoch(s.observed_at)*1000<? OR unixepoch(s.observed_at)*1000>?
          OR s.day||'T'||s.start<=strftime('%Y-%m-%dT%H:%M',?/1000,'unixepoch','+9 hours'))))
      RETURNING *`).bind(p.owner,p.fence,now,p.job_id,now+30000,now-300000,now,now)];
    const r=await atomic(db,p,now,commands);
    const job=r[1].results[0] || null;
    if (job) job.message_id=(await db.prepare('SELECT message_id FROM batches WHERE id=?').bind(job.batch_id).first()).message_id;
    return {job};
  }
  if (name==='receipt') {
    keys(p,'owner,fence,job_id,status,message_id,error_code');rowid(p.job_id);
    need(['SENT','FAILED','UNCERTAIN'].includes(p.status));
    need(p.status==='SENT' ? integer(p.message_id,1) && p.error_code===null : p.message_id===null && DELIVERY_ERRORS.has(p.error_code));
    const check=db.prepare(`INSERT INTO atomic_guard VALUES(?,CASE WHEN EXISTS(
      SELECT 1 FROM jobs j JOIN batches b ON b.id=j.batch_id
      WHERE j.id=? AND j.owner=? AND j.fence=? AND j.status='IN_FLIGHT'
      AND (?<>'SENT' OR (j.kind='SEND' AND b.message_id IS NULL) OR b.message_id=?)
    ) THEN 1 ELSE 0 END)`).bind(crypto.randomUUID(),p.job_id,p.owner,p.fence,p.status,p.message_id);
    const commands=[check,db.prepare('UPDATE jobs SET status=?,message_id=?,error_code=? WHERE id=?').bind(p.status,p.message_id,p.error_code,p.job_id)];
    if (p.status==='SENT') {
      commands.push(db.prepare('UPDATE batches SET message_id=? WHERE id=(SELECT batch_id FROM jobs WHERE id=?) AND (message_id IS NULL OR message_id=?)').bind(p.message_id,p.job_id,p.message_id));
      commands.push(db.prepare("UPDATE members SET delivery='SENT' WHERE batch_id=(SELECT batch_id FROM jobs WHERE id=?)").bind(p.job_id));
    }
    await atomic(db,p,now,commands);return {recorded:true};
  }
  throw new Fault('UNSUPPORTED_ENDPOINT',404);
}

// Clock injection is a code-only test seam. Deployed default always uses the
// server clock; no request/header/env option can override production time.
export function createHandler(clock=()=>Date.now()) { return {
  async fetch(request,env) {
    try {
      const url=new URL(request.url);
      need(url.protocol==='https:','HTTPS_REQUIRED',400);
      need(typeof env.API_SECRET==='string' && /^[A-Za-z0-9_-]{32,128}$/.test(env.API_SECRET),'NOT_CONFIGURED',503);
      // Fixed-size digest comparison avoids comparing a bearer character by character.
      const digest=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
      const [given,wanted]=await Promise.all([digest(request.headers.get('Authorization')||''),digest('Bearer '+env.API_SECRET)]);
      let delta=0;for(let i=0;i<given.length;i++) delta|=given[i]^wanted[i];need(delta===0,'UNAUTHORIZED',401);
      need(request.method==='POST','METHOD_NOT_ALLOWED',405);
      const allowed=new Set(['acquire','snapshot','commit','failure','claim','receipt','release']);
      const name=url.pathname.replace(/^\/v1\//,'');need(allowed.has(name) && url.pathname==='/v1/'+name && !url.search,'UNSUPPORTED_ENDPOINT',404);
      need((request.headers.get('Content-Type')||'').split(';')[0]==='application/json');
      const declared=Number(request.headers.get('Content-Length')||0);need(declared<=MAX_BODY,'BODY_TOO_LARGE',413);
      const reader=request.body?.getReader();let bytes=0;const chunks=[];
      if(reader) while(true) {const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BODY){await reader.cancel();throw new Fault('BODY_TOO_LARGE',413);}chunks.push(value);}
      const combined=new Uint8Array(bytes);let offset=0;for(const c of chunks){combined.set(c,offset);offset+=c.length;}
      let payload;try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(combined));}catch{throw new Fault('INVALID_JSON');}
      need(payload && typeof payload==='object' && !Array.isArray(payload));
      const db=env.DB.withSession('first-primary');
      const version=await db.prepare('SELECT version FROM schema_meta ORDER BY version DESC LIMIT 1').first();
      need(version?.version===1,'UNSUPPORTED_SCHEMA',409);
      const result=await command(name,payload,db,clock());
      return response({ok:true,...result});
    } catch(error) {
      return response({ok:false,error:error instanceof Fault ? error.code : 'STORAGE_UNAVAILABLE'},error instanceof Fault ? error.status : 503);
    }
  }
}; }
export default createHandler();
