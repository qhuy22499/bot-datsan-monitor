// Fixed booking commands. Separate lease, guard and tables from monitoring V2.
class BookingFault extends Error {constructor(code,status=400){super(code);this.code=code;this.status=status;}}
const need=(ok,code='INVALID_REQUEST',status=400)=>{if(!ok)throw new BookingFault(code,status);};
const exact=(p,names)=>need(p&&typeof p==='object'&&!Array.isArray(p)&&Object.keys(p).sort().join(',')===names.split(',').sort().join(','));
const stamp=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(Date.parse(s)+32400000).toISOString().slice(0,19)+'+09:00'===s;
const date=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\d$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const time=s=>typeof s==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
const codes=new Set(['VERIFIED','SOURCE_INCOMPLETE','PAGINATION_INCOMPLETE','MANUAL_ACTION_REQUIRED','CREDENTIALS_MISSING','LOGIN_SAFETY_CHECK_FAILED','LOGIN_FAILED','LOGIN_UNVERIFIED','WEBSITE_OR_READ_ERROR','READ_ERROR']);
async function atomic(db,p,now,commands){
  const g=crypto.randomUUID();
  try{return await db.batch([
    db.prepare('INSERT INTO booking_guard VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM booking_lease WHERE id=1 AND owner=? AND fence=? AND expires>?) THEN 1 ELSE 0 END)').bind(g,p.owner,p.fence,now),
    ...commands,db.prepare('DELETE FROM booking_guard WHERE id=?').bind(g)]);}
  catch{throw new BookingFault('BOOKING_CONFLICT_OR_UNAVAILABLE',409);}
}
export async function bookingCommand(name,p,db,now){
  if(name==='booking_acquire'){
    exact(p,'owner');need(typeof p.owner==='string'&&/^[a-f0-9-]{36}$/.test(p.owner));
    const lease=await db.prepare('UPDATE booking_lease SET owner=?,fence=fence+1,expires=? WHERE id=1 AND expires<=? RETURNING owner,fence,expires').bind(p.owner,now+720000,now).first();
    need(lease,'BOOKING_BUSY',409);return lease;
  }
  need(typeof p.owner==='string'&&/^[a-f0-9-]{36}$/.test(p.owner)&&Number.isSafeInteger(p.fence)&&p.fence>0);
  if(name==='booking_release'){
    exact(p,'owner,fence');const r=await db.prepare('UPDATE booking_lease SET expires=0 WHERE id=1 AND owner=? AND fence=? RETURNING fence').bind(p.owner,p.fence).first();
    need(r,'STALE_OWNER',409);return {released:true};
  }
  const current=await db.prepare('SELECT * FROM booking_lease WHERE id=1').first();
  need(current?.owner===p.owner&&current.fence===p.fence&&current.expires>now,'STALE_OWNER',409);
  if(name==='booking_snapshot'){
    exact(p,'owner,fence');const r=await db.batch([db.prepare('SELECT * FROM booking_groups ORDER BY group_alias'),db.prepare('SELECT * FROM bookings WHERE listed=1 ORDER BY day,start,court,group_alias')]);
    return {groups:r[0].results,rows:r[1].results};
  }
  need(typeof p.run_id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(p.run_id)&&['A','B','C'].includes(p.group));
  if(name==='booking_begin'){
    exact(p,'owner,fence,run_id,group,started_at');need(stamp(p.started_at)&&Date.parse(p.started_at)<=now&&now-Date.parse(p.started_at)<=300000);
    const r=await atomic(db,p,now,[
      db.prepare('INSERT INTO booking_runs(id,started_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING').bind(p.run_id,p.started_at),
      db.prepare("INSERT INTO booking_attempts(run_id,group_alias,status) VALUES(?,?,'STARTED') ON CONFLICT(run_id,group_alias) DO NOTHING RETURNING status").bind(p.run_id,p.group),
      db.prepare("UPDATE booking_groups SET sync_status='PARTIAL',code='IN_PROGRESS_OR_INTERRUPTED',last_attempt_at=? WHERE group_alias=? AND EXISTS(SELECT 1 FROM booking_attempts WHERE run_id=? AND group_alias=? AND status='STARTED')").bind(p.started_at,p.group,p.run_id,p.group)]);
    return {accepted:r[2].results.length===1}; // Once-only login permit survives job restart.
  }
  need(name==='booking_result');exact(p,'owner,fence,run_id,group,result');
  const r=p.result;exact(r,'group,status,code,observed_at,display_name,rows,pages,source_count');
  need(r.group===p.group&&['COMPLETE','PARTIAL','FAILED'].includes(r.status)&&codes.has(r.code)
    &&(r.status==='COMPLETE'?r.code==='VERIFIED':r.code!=='VERIFIED')&&stamp(r.observed_at)
    &&Date.parse(r.observed_at)<=now&&now-Date.parse(r.observed_at)<=720000
    &&Number.isSafeInteger(r.pages)&&r.pages>=0&&r.pages<=100&&Number.isSafeInteger(r.source_count)&&r.source_count>=0&&r.source_count<=10000
    &&Array.isArray(r.rows)&&r.rows.length<=1000&&r.rows.length<=r.source_count
    &&(r.display_name===null||(typeof r.display_name==='string'&&r.display_name.length>0&&r.display_name.length<=200&&!/[\x00-\x1f\x7f]/.test(r.display_name))));
  if(r.status==='COMPLETE')need(r.pages>=1);
  const old=await db.prepare('SELECT status FROM booking_attempts WHERE run_id=? AND group_alias=?').bind(p.run_id,p.group).first();
  need(old,'BOOKING_NOT_STARTED',409);if(old.status!=='STARTED')return {recorded:true,duplicate:true};
  const seen=new Set();
  for(const row of r.rows){
    exact(row,'id,day,start,end,court,reservation_number,reservation_status,payment_status,payment_raw');
    need(typeof row.id==='string'&&/^[a-f0-9]{64}$/.test(row.id)&&!seen.has(row.id)&&date(row.day)&&time(row.start)&&time(row.end)&&row.start<row.end
      &&['A','B'].includes(row.court)&&row.reservation_status==='CONFIRMED'
      &&(row.reservation_number===null||/^\d{1,40}$/.test(row.reservation_number))&&['UNPAID','UNKNOWN'].includes(row.payment_status)
      &&(row.payment_raw===null||['支払前','支払済','支払済み','支払い済み','未払い','入金済','未入金'].includes(row.payment_raw)));
    seen.add(row.id);
  }
  const commands=[db.prepare("INSERT INTO booking_guard VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM booking_attempts WHERE run_id=? AND group_alias=? AND status='STARTED') THEN 1 ELSE 0 END)").bind(crypto.randomUUID(),p.run_id,p.group),
    db.prepare('UPDATE booking_attempts SET status=?,code=?,observed_at=?,source_count=?,pages=? WHERE run_id=? AND group_alias=?').bind(r.status,r.code,r.observed_at,r.source_count,r.pages,p.run_id,p.group),
    db.prepare('UPDATE booking_groups SET last_attempt_at=?,sync_status=?,code=? WHERE group_alias=?').bind(r.observed_at,r.status,r.code,p.group)];
  if(r.status==='COMPLETE'){
    commands.push(db.prepare('UPDATE booking_groups SET display_name=COALESCE(?,display_name),last_success_at=? WHERE group_alias=?').bind(r.display_name,r.observed_at,p.group),
      db.prepare('UPDATE bookings SET listed=0 WHERE group_alias=?').bind(p.group));
    for(const row of r.rows)commands.push(db.prepare(`INSERT INTO bookings(id,group_alias,reservation_number,day,start,end,court,reservation_status,payment_status,payment_raw,observed_at,listed,last_run)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET payment_status=excluded.payment_status,payment_raw=excluded.payment_raw,observed_at=excluded.observed_at,listed=1,last_run=excluded.last_run
      WHERE bookings.group_alias=excluded.group_alias AND bookings.day=excluded.day AND bookings.start=excluded.start AND bookings.end=excluded.end AND bookings.court=excluded.court`).bind(row.id,p.group,row.reservation_number,row.day,row.start,row.end,row.court,row.reservation_status,row.payment_status,row.payment_raw,r.observed_at,p.run_id));
  }
  commands.push(db.prepare('DELETE FROM booking_guard'));
  await atomic(db,p,now,commands);return {recorded:true,duplicate:false};
}
